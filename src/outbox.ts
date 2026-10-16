import { draftMentions } from './mentions';
import * as fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { ChatStore } from './store';
import { OneBotClient, OneBotRequestError } from './onebot';
import { AttachmentFiles } from './attachments';
import { uploadToNapCat } from './fileUpload';
import { Attachment, Message, Segment, draftParts, outgoingDrafts, id, parseMessage, splitKey } from './model';
import { AccountSession } from './accountSession';
import { OperationLocks } from './operationLocks';
import { FileReceipt } from './fileReceipt';
import { isNapCatEventTimeout } from './requestFailure';
import { SendReceipt, SendReceipts, mediaDigest } from './sendReceipt';
interface OutboxHost {
  store?: ChatStore; attachments?: AttachmentFiles; client: OneBotClient;
  session: AccountSession; ready: boolean; log(error: unknown): void;
}
export interface Submission { messageIds: string[]; completion: Promise<boolean>; }
// Owns delivery, never editor focus or draft widgets. Persist before network submission.
export class OutboxService {
  private deliveries = new WeakMap<ChatStore, OperationLocks>();
  private retries = new WeakMap<ChatStore, OperationLocks>();
  private locks(map: WeakMap<ChatStore, OperationLocks>, store: ChatStore): OperationLocks {
    let locks = map.get(store);
    if (!locks) { locks = new OperationLocks(); map.set(store, locks); }
    return locks;
  }
  private receipts = new SendReceipts();
  observeEcho(store: ChatStore, raw: unknown, message: Message): boolean { return this.receipts.observe(store, raw, message); }
  private cancelled = new Set<string>();
  private sendQueues = new Map<string, Promise<boolean>>();
  constructor(private host: OutboxHost) {}
  isBusy(account: string, key: string): boolean { return this.sendQueues.has(`${account}:${key}`); }
  async whenIdle(account: string, key: string): Promise<void> { await this.sendQueues.get(`${account}:${key}`); }
  submit(store: ChatStore, key: string, text: string, replyId?: string): Submission {
    if (store !== this.host.store || !this.host.ready) throw new Error('NapCat 未连接，草稿已保留');
    const pendingKey = `${store.selfId}:${key}`;
    const draft = store.draft(key);
    const current = draft.text === text && draft.replyId === replyId ? draft : store.setDraft(key, text, replyId);
    const captured = { ...current, mentions: current.mentions ? { ...current.mentions } : undefined, replies: current.replies ? { ...current.replies } : undefined };
    const drafts = outgoingDrafts(captured);
    if (!drafts.length || drafts.every(draft => !draft.text.trim() && !draftParts(draft.text, draft.attachments).some(part => typeof part !== 'string'))) throw new Error('请在回复占位符后输入消息或插入附件');
    // Validate before creating outgoing records or clearing the draft.
    if (key.startsWith('group:')) for (const outgoing of drafts) {
      for (const part of draftParts(outgoing.text, outgoing.attachments)) if (typeof part === 'string') draftMentions(part, outgoing.mentions);
    }
    const tasks: Promise<boolean>[] = [], messageIds: string[] = [];
    for (const outgoing of drafts) {
      const parts = draftParts(outgoing.text, outgoing.attachments);
      const local: Message = {
        id: `local:${randomUUID()}`, chatKey: key, senderId: store.selfId, senderName: '我',
        time: Math.floor(Date.now() / 1000), mentioned: false, replyId: outgoing.replyId,
        sendState: this.sendQueues.has(pendingKey) ? 'queued' : 'sending', outgoing,
        localImages: parts.filter((p): p is Attachment => typeof p !== 'string' && p.kind === 'image'),
        localVideos: parts.filter((p): p is Attachment => typeof p !== 'string' && p.kind === 'video'),
        segments: parts.flatMap<Segment>(p => typeof p === 'string'
          ? (key.startsWith('group:') ? draftMentions(p, outgoing.mentions) : [p]).map(part => typeof part === 'string' ? { type: 'text' as const, text: part } : { type: 'mention' as const, qq: part.qq, name: part.text.startsWith('[@:') ? part.text.slice(3, -1) : undefined, text: part.text })
          : p.kind === 'image' ? [{ type: 'image' as const, image: { file: '' } }]
          : p.kind === 'video' ? [{ type: 'video' as const, video: { file: '', name: p.label }, text: '[视频]' }]
          : p.kind === 'file' ? [{ type: 'file' as const, file: { id: '', name: p.label, size: p.size }, text: p.placeholder ?? `[文件:${p.label}]` }]
          : [{ type: 'face' as const, id: p.faceId ?? '', text: `[表情:${p.faceId}]` }])
      };
      store.add(local, false); messageIds.push(local.id);
      tasks.push(this.enqueue(store, local));
    }
    store.completeSend(key, captured);
    return { messageIds, completion: Promise.all(tasks).then(results => results.every(Boolean), error => { this.host.log(error); return false; }) };
  }
  async cancel(store: ChatStore, message: Message): Promise<void> {
    const current = store.messages.get(message.chatKey)?.find(m => m.id === message.id);
    if (store !== this.host.store || !current || current.recalled) return;
    message = current;
    if (!(message.sendState === 'queued' || (message.sendState === 'sending' && message.sendProgress?.stage === 'upload'))) return;
    this.cancelled.add(message.id); message.sendState = 'cancelled'; message.sendProgress = undefined;
    message.outgoing = undefined; message.localImages = undefined; message.localVideos = undefined; message.sendError = undefined;
    store.enrichMessage(message); await store.flush();
  }
  retry(store: ChatStore, key: string, messageId: string, confirm: () => Promise<boolean>): Promise<boolean> {
    return this.locks(this.retries, store).run(JSON.stringify([key, messageId]), async () => {
      const token = this.host.session.capture();
      const current = () => store.messages.get(key)?.find(m => m.id === messageId);
      const message = current();
      if (store !== this.host.store || !message?.outgoing || message.recalled || !['failed', 'uncertain'].includes(message.sendState ?? '')) return false;
      if (!this.host.ready) throw new Error('NapCat 未连接，消息仍保留在记录中');
      if (message.sendState === 'failed' && isNapCatEventTimeout(message.sendError)) {
        message.sendState = 'uncertain'; store.enrichMessage(message);
      }
      const state = message.sendState;
      if (state === 'uncertain' && !await confirm()) return false;
      const latest = current();
      if (!token.current() || store !== this.host.store || !this.host.ready || !latest?.outgoing || latest.recalled || latest.sendState !== state) return false;
      latest.sendState = 'queued'; latest.sendError = undefined; store.enrichMessage(latest);
      return this.enqueue(store, latest);
    });
  }
  enqueue(store: ChatStore, message: Message): Promise<boolean> {
    return this.locks(this.deliveries, store).run(JSON.stringify([message.chatKey, message.id]), () => {
      const latest = store.messages.get(message.chatKey)?.find(m => m.id === message.id);
      if (!latest?.outgoing || latest.recalled || !['queued', 'sending', 'failed', 'uncertain'].includes(latest.sendState ?? '')) return false;
      return this.enqueueOnce(store, latest);
    });
  }
  private enqueueOnce(store: ChatStore, message: Message): Promise<boolean> {
    const queueKey = `${store.selfId}:${message.chatKey}`;
    const previous = this.sendQueues.get(queueKey) ?? Promise.resolve(true);
    const files = this.host.attachments, epoch = this.host.session.generation;
    const task = previous.catch(() => false).then(async () => {
      let requested = false, fileRequested = false, confirmed = false;
      let fileReceipt: FileReceipt | undefined, sendReceipt: SendReceipt | undefined;
      const checkCancelled = () => { if (this.cancelled.has(message.id)) throw new Error('已取消发送'); };
      try {
        checkCancelled();
        const latest = store.messages.get(message.chatKey)?.find(m => m.id === message.id);
        if (!latest?.outgoing || latest.recalled || latest.sendState === 'sent' || latest.sendState === 'cancelled') return false;
        if (store !== this.host.store || epoch !== this.host.session.generation || !this.host.ready) throw new Error('连接已变化，消息尚未提交');
        message.sendState = 'sending'; message.sendError = undefined; message.sendProgress = undefined; store.enrichMessage(message);
        await store.flush();
        checkCancelled();
        if (store !== this.host.store || epoch !== this.host.session.generation || !this.host.ready) throw new Error('连接已变化，消息尚未提交');
        const draft = message.outgoing!;
        const parts = draftParts(draft.text, draft.attachments);
        const used = parts.filter((p): p is Attachment => typeof p !== 'string');
        if (used.length && !files) throw new Error('附件缓存不可用，消息尚未提交');
        const file = used.find(a => a.kind === 'file');
        if (file && files) {
          const source = await files.filePath(file);
          const check = () => { checkCancelled(); if (store !== this.host.store || epoch !== this.host.session.generation || !this.host.ready) throw new Error('连接已变化，上传已暂停'); };
          let lastUpdate = 0, uploadSize = file.size;
          const remote = await uploadToNapCat(this.host.client, source, progress => {
            check(); message.sendProgress = progress; uploadSize = progress.total;
            if (Date.now() - lastUpdate > 200 || progress.stage === 'confirm') { lastUpdate = Date.now(); store.enrichMessage(message); }
          }, check);
          check();
          const chat = splitKey(message.chatKey);
          // File UUIDs can be reused. Only a new echo can settle this attempt.
          const beforeRequest = new Set(store.messages.get(message.chatKey)?.map(m => m.id));
          fileReceipt = new FileReceipt(this.host.client, store.selfId, message.chatKey, { ...file, size: uploadSize }, beforeRequest, this.host.session.capture().signal);
          requested = true;
          fileRequested = true;
          const result = await this.host.client.call(chat.type === 'group' ? 'upload_group_file' : 'upload_private_file', {
            [chat.type === 'group' ? 'group_id' : 'user_id']: chat.id, file: remote, name: file.label
          }, 30 * 60 * 1000);
          message.sendProgress = undefined;
          const fileId = id(result?.file_id);
          message.fileIds = fileId ? [fileId] : undefined;
          const segments: Segment[] = message.fileIds?.length
            ? [{ type: 'file', file: { id: message.fileIds[0], name: file.label, size: file.size }, text: `[文件:${file.label}]` }] : message.segments;
          store.settleOutgoing(message.chatKey, message.id, { ...message, segments, id: id(result?.message_id) || message.id }, beforeRequest);
          confirmed = true;
          await store.flush();
          return true;
        }
        checkCancelled();
        const uploads = new Map<string, unknown>();
        const mediaDigests = new Map<string, string>();
        let lastMediaUpdate = 0;
        for (const attachment of used) {
          if (uploads.has(attachment.id) || !['image', 'video'].includes(attachment.kind)) continue;
          const source = await files!.filePath(attachment);
          // Small images retain the compatible inline transport. Larger ones
          // use the same bounded-memory stream as video; this is not a size cap.
          if (attachment.kind === 'image' && (await fs.stat(source)).size <= 512 * 1024) continue;
          const check = () => { checkCancelled(); if (store !== this.host.store || epoch !== this.host.session.generation || !this.host.ready) throw new Error('连接已变化，资源上传已暂停'); };
          const hash = createHash('md5');
          const remote = await uploadToNapCat(this.host.client, source, progress => {
            check(); message.sendProgress = progress;
            if (Date.now() - lastMediaUpdate > 200 || progress.stage === 'confirm') { lastMediaUpdate = Date.now(); store.enrichMessage(message); }
          }, check, bytes => hash.update(bytes));
          mediaDigests.set(attachment.id, hash.digest('hex'));
          check(); uploads.set(attachment.id, { type: attachment.kind, data: { file: remote, ...(attachment.sticker ? { sub_type: 1 } : {}) } });
        }
        const regular = files ? await files.segments(used.filter(a => !uploads.has(a.id))) : [];
        const media = used.map(a => uploads.get(a.id) ?? regular.shift());
        if (store !== this.host.store || epoch !== this.host.session.generation || !this.host.ready) throw new Error('连接已变化，消息尚未提交');
        checkCancelled();
        const segments: unknown[] = draft.replyId ? [{ type: 'reply', data: { id: draft.replyId } }] : [];
        let index = 0;
        for (const part of parts) {
          if (typeof part !== 'string') { segments.push(media[index++]); continue; }
          for (const value of message.chatKey.startsWith('group:') ? draftMentions(part, draft.mentions) : [part]) {
            segments.push(typeof value === 'string' ? { type: 'text', data: { text: value } } : { type: 'at', data: { qq: value.qq } });
          }
        }
        const chat = splitKey(message.chatKey);
        const expected = parseMessage({ message: segments }, message.chatKey, store.selfId);
        let mediaIndex = 0;
        for (const segment of expected.segments) {
          if (segment.type !== 'image' && segment.type !== 'video' && segment.type !== 'face') continue;
          const attachment = used[mediaIndex++];
          if (segment.type === 'face') continue;
          const resource = segment.type === 'image' ? segment.image : segment.video;
          resource.file = mediaDigests.get(attachment.id) ?? mediaDigest(resource.file) ?? '';
        }
        const timeout = uploads.size ? 30 * 60 * 1000 : 15000;
        sendReceipt = this.receipts.begin(store, message, expected.segments, this.host.session.capture().signal, timeout);
        requested = true;
        const result = await this.host.client.call('send_msg', { message_type: chat.type, [chat.type === 'group' ? 'group_id' : 'user_id']: chat.id, message: segments }, timeout);
        const messageId = id(result?.message_id);
        if (sendReceipt?.echo) {
          // A different valid API ID proves a separate send. Keep both real
          // messages if another client happened to send identical content.
          if (/^-?[1-9]\d*$/.test(messageId) && messageId !== sendReceipt.echo.id) {
            store.settleOutgoing(message.chatKey, message.id, { ...message, id: messageId, sendProgress: undefined });
          }
          return true;
        }
        if (!/^-?\d+$/.test(messageId) || /^-?0+$/.test(messageId)) throw new Error('NapCat 未返回有效消息 ID，发送结果未确认，请先检查目标会话');
        message.sendProgress = undefined;
        const settled = store.settleOutgoing(message.chatKey, message.id, { ...message, id: messageId });
        confirmed = true; sendReceipt?.close();
        if ((message.localImages?.length || message.localVideos?.length) && result?.message_id && store === this.host.store && epoch === this.host.session.generation) {
          void this.host.client.call('get_msg', { message_id: result.message_id }).then(raw => {
            if (store === this.host.store && epoch === this.host.session.generation && raw?.message && id(raw.message_id) === settled.id) store.enrichMessage(parseMessage(raw, message.chatKey, store.selfId));
          }).catch(error => this.host.log(`媒体详情稍后获取：${error.message}`));
        }
        return true;
      } catch (error: any) {
        // A definitive success must survive later cache/detail errors. NapCat may
        // also reject upload_*_file after QQ has already accepted the file.
        if (confirmed || sendReceipt?.echo) { this.host.log(error); return true; }
        if (error instanceof OneBotRequestError && error.kind === 'rejected') sendReceipt?.close();
        if (fileReceipt && store === this.host.store && epoch === this.host.session.generation && this.host.ready) {
          const echo = await fileReceipt.wait();
          if (echo && store === this.host.store && epoch === this.host.session.generation && this.host.ready) {
            store.settleOutgoing(message.chatKey, message.id, { ...message, ...echo, sendProgress: undefined });
            this.host.log(`收到文件发送回显，已确认成功；上传接口异常：${error.message}`);
            await store.flush().catch(error => this.host.log(error));
            return true;
          }
        }
        if (this.cancelled.has(message.id) && !requested) {
          message.sendState = 'cancelled'; message.outgoing = undefined; message.sendProgress = undefined; message.sendError = undefined; message.localImages = undefined; message.localVideos = undefined;
        } else {
          message.sendState = fileRequested || requested && !(error instanceof OneBotRequestError && error.kind === 'rejected') ? 'uncertain' : 'failed';
          message.sendError = fileRequested
            ? `文件已提交给 NapCat，可能已经发出。请先检查目标会话，避免重复发送。${error.message}`
            : requested && isNapCatEventTimeout(error.message)
              ? `NapCat 等待发送事件超时，消息可能已送达。请先检查目标会话，再决定是否重试。${error.message}` : error.message;
          if (fileRequested) this.host.log(`文件发送结果未确认：${error.message}`);
        }
        store.enrichMessage(message);
        return false;
      } finally { fileReceipt?.dispose(); this.cancelled.delete(message.id); }
    });
    this.sendQueues.set(queueKey, task);
    const cleanup = () => { if (this.sendQueues.get(queueKey) === task) this.sendQueues.delete(queueKey); };
    void task.then(cleanup, cleanup);
    return task;
  }
}
