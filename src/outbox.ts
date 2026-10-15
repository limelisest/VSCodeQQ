import { draftMentions } from './mentions';
import { randomUUID } from 'node:crypto';
import { ChatStore } from './store';
import { OneBotClient, OneBotRequestError } from './onebot';
import { AttachmentFiles } from './attachments';
import { uploadToNapCat } from './fileUpload';
import { Attachment, Message, Segment, draftParts, outgoingDrafts, id, parseMessage, splitKey } from './model';
import { AccountSession } from './accountSession';
import { OperationLocks } from './operationLocks';
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
        segments: parts.flatMap<Segment>(p => typeof p === 'string'
          ? (key.startsWith('group:') ? draftMentions(p, outgoing.mentions) : [p]).map(part => typeof part === 'string' ? { type: 'text' as const, text: part } : { type: 'mention' as const, qq: part.qq, name: part.text.startsWith('[@:') ? part.text.slice(3, -1) : undefined, text: part.text })
          : p.kind === 'image' ? [{ type: 'image' as const, image: { file: '' } }]
          : [{ type: 'text' as const, text: p.kind === 'file' ? p.placeholder ?? `[文件:${p.label}]` : `[表情:${p.faceId}]` }])
      };
      store.add(local, false); messageIds.push(local.id);
      tasks.push(this.enqueue(store, local));
    }
    store.completeSend(key, captured);
    return { messageIds, completion: Promise.all(tasks).then(results => results.every(Boolean), error => { this.host.log(error); return false; }) };
  }
  async cancel(store: ChatStore, message: Message): Promise<void> {
    if (!(message.sendState === 'queued' || (message.sendState === 'sending' && message.sendProgress?.stage === 'upload'))) return;
    this.cancelled.add(message.id); message.sendState = 'cancelled'; message.sendProgress = undefined;
    message.outgoing = undefined; message.localImages = undefined; message.sendError = undefined;
    store.enrichMessage(message); await store.flush();
  }
  retry(store: ChatStore, key: string, messageId: string, confirm: () => Promise<boolean>): Promise<boolean> {
    return this.locks(this.retries, store).run(JSON.stringify([key, messageId]), async () => {
      const token = this.host.session.capture();
      const current = () => store.messages.get(key)?.find(m => m.id === messageId);
      const message = current();
      if (store !== this.host.store || !message?.outgoing || message.recalled || !['failed', 'uncertain'].includes(message.sendState ?? '')) return false;
      if (!this.host.ready) throw new Error('NapCat 未连接，消息仍保留在记录中');
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
      let requested = false;
      const checkCancelled = () => { if (this.cancelled.has(message.id)) throw new Error('已取消发送'); };
      try {
        checkCancelled();
        const latest = store.messages.get(message.chatKey)?.find(m => m.id === message.id);
        if (!latest?.outgoing || latest.recalled || latest.sendState === 'sent' || latest.sendState === 'cancelled') return false;
        if (store !== this.host.store || epoch !== this.host.session.generation || !this.host.ready) throw new Error('连接已变化，消息尚未提交');
        message.sendState = 'sending'; message.sendError = undefined; message.sendProgress = undefined; store.enrichMessage(message);
        await store.flush();
        const draft = message.outgoing!;
        const parts = draftParts(draft.text, draft.attachments);
        const used = parts.filter((p): p is Attachment => typeof p !== 'string');
        const file = used.find(a => a.kind === 'file');
        if (file && files) {
          const source = await files.filePath(file);
          const check = () => { checkCancelled(); if (store !== this.host.store || epoch !== this.host.session.generation || !this.host.ready) throw new Error('连接已变化，上传已暂停'); };
          let lastUpdate = 0;
          const remote = await uploadToNapCat(this.host.client, source, progress => {
            check(); message.sendProgress = progress;
            if (Date.now() - lastUpdate > 200 || progress.stage === 'confirm') { lastUpdate = Date.now(); store.enrichMessage(message); }
          }, check);
          check();
          const chat = splitKey(message.chatKey);
          requested = true;
          const result = await this.host.client.call(chat.type === 'group' ? 'upload_group_file' : 'upload_private_file', {
            [chat.type === 'group' ? 'group_id' : 'user_id']: chat.id, file: remote, name: file.label
          }, 30 * 60 * 1000);
          message.sendProgress = undefined;
          message.fileIds = result?.file_id ? [String(result.file_id)] : undefined;
          store.settleOutgoing(message.chatKey, message.id, { ...message, id: id(result?.message_id) || message.id });
          await store.flush();
          return true;
        }
        checkCancelled();
        const media = files ? await files.segments(used) : [];
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
        requested = true;
        const result = await this.host.client.call('send_msg', { message_type: chat.type, [chat.type === 'group' ? 'group_id' : 'user_id']: chat.id, message: segments });
        const confirmed = store.settleOutgoing(message.chatKey, message.id, { ...message, id: id(result?.message_id) || message.id });
        if (message.localImages?.length && result?.message_id && store === this.host.store && epoch === this.host.session.generation) {
          void this.host.client.call('get_msg', { message_id: result.message_id }).then(raw => {
            if (store === this.host.store && epoch === this.host.session.generation && raw?.message && id(raw.message_id) === confirmed.id) store.enrichMessage(parseMessage(raw, message.chatKey, store.selfId));
          }).catch(error => this.host.log(`图片详情稍后获取：${error.message}`));
        }
        return true;
      } catch (error: any) {
        if (this.cancelled.has(message.id) && !requested) {
          message.sendState = 'cancelled'; message.outgoing = undefined; message.sendProgress = undefined; message.sendError = undefined; message.localImages = undefined;
        } else {
          message.sendState = requested && !(error instanceof OneBotRequestError && error.kind === 'rejected') ? 'uncertain' : 'failed';
          message.sendError = error.message;
        }
        store.enrichMessage(message);
        return false;
      } finally { this.cancelled.delete(message.id); }
    });
    this.sendQueues.set(queueKey, task);
    const cleanup = () => { if (this.sendQueues.get(queueKey) === task) this.sendQueues.delete(queueKey); };
    void task.then(cleanup, cleanup);
    return task;
  }
}
