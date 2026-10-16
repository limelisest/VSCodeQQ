import { restoreReply } from './replies';
import { isNapCatEventTimeout } from './requestFailure';
import { mentionText, restoredMentions } from './mentions';
import { DraftService } from './draftService';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Attachment, Chat, Draft, Member, Message, id, inline, isPending, mergeMessages, normalizeSegments, messageText, splitKey } from './model';

export type StoreChange = 'messages' | 'chat' | 'members' | 'unread' | 'favorites' | 'collapsed' | 'notification';
export class ChatStore extends EventEmitter<{ change: [key: string, kind: StoreChange]; draft: [key: string, replyChanged: boolean]; storageError: [error: Error] }> {
  readonly chats = new Map<string, Chat>();
  readonly messages = new Map<string, Message[]>();
  readonly outbox = new Map<string, Message>();
  readonly favorites = new Set<string>();
  readonly collapsed = new Set<string>();
  readonly draftService = new DraftService((key, replyChanged) => { this.schedule(); this.emit('draft', key, replyChanged); });
  get drafts() { return this.draftService.values; }
  readonly members = new Map<string, Map<string, Member>>();
  private loaded = new Set<string>();
  private loading = new Map<string, Promise<void>>();
  private dirty = new Set<string>();
  private stateDirty = false;
  private saveTimer?: NodeJS.Timeout;
  private saving: Promise<void> = Promise.resolve();
  constructor(readonly folder: string, readonly selfId: string, public limit = 500) { super(); }
  async restore(): Promise<void> {
    try {
      const data = JSON.parse(await fs.readFile(path.join(this.folder, 'state.json'), 'utf8'));
      this.draftService.attachmentSerial = Number(data.attachmentSerial) || 0;
      for (const chat of data.chats ?? []) { try { splitKey(chat.key); this.chats.set(chat.key, { ...chat, notification: 'unknown' }); } catch {} }
      for (const message of data.outbox ?? []) {
        if (!this.chats.has(message.chatKey) || !isPending(message)) continue;
        if (['sending', 'queued'].includes(message.sendState)) { message.sendState = 'uncertain'; message.sendError = '上次关闭时结果未确认，请检查聊天记录后重试'; }
        if (message.sendState === 'failed' && isNapCatEventTimeout(message.sendError)) message.sendState = 'uncertain';
        message.segments = normalizeSegments(message.segments ?? []);
        this.outbox.set(message.id, message);
        this.messages.set(message.chatKey, [...this.messages.get(message.chatKey) ?? [], message]);
      }
      for (const key of data.collapsed ?? []) if (this.chats.get(key)?.type === 'group') this.collapsed.add(key);
      for (const key of data.favorites ?? []) if (this.chats.has(key)) this.favorites.add(key);
      for (const [key, draft] of Object.entries(data.drafts ?? {})) {
        const d = draft as Draft;
        if (this.chats.has(key) && typeof d.text === 'string') this.drafts.set(key, restoreReply({ ...d, text: d.text, replyId: d.replyId, version: Number(d.version) || 0, attachments: Array.isArray(d.attachments) ? d.attachments : [], mentions: restoredMentions(d.mentions) }));
      }
    } catch (error: any) { if (error.code !== 'ENOENT') this.emit('storageError', new Error('本地会话缓存无法读取，已使用空缓存')); }
  }
  private file(key: string): string { const c = splitKey(key); return path.join(this.folder, `${c.type}-${c.id}.json`); }
  async load(key: string): Promise<void> {
    if (this.loaded.has(key)) return;
    const existing = this.loading.get(key); if (existing) return existing;
    const task = (async () => {
      try {
        const cached: Message[] = JSON.parse(await fs.readFile(this.file(key), 'utf8'));
        const valid = Array.isArray(cached) ? cached.filter(m => m.chatKey === key && typeof m.id === 'string' && Array.isArray(m.segments)) : [];
        for (const m of valid) {
          m.segments = normalizeSegments(m.segments);
          if (isPending(m) && m.sendState === 'failed' && isNapCatEventTimeout(m.sendError)) m.sendState = 'uncertain';
        }
        for (const m of valid) if (m.sendState === 'sending' || m.sendState === 'queued') {
          m.sendState = 'uncertain'; m.sendError = '插件上次关闭时尚未确认结果，请检查聊天记录后再重试';
        }
        this.messages.set(key, mergeMessages(valid, this.messages.get(key) ?? [], this.limit));
      } catch (error: any) { if (error.code !== 'ENOENT') this.emit('storageError', new Error('部分聊天缓存无法读取')); }
      this.trackOutbox(key);
      this.loaded.add(key); this.loading.delete(key);
    })();
    this.loading.set(key, task); await task;
  }
  private trackOutbox(key: string): void {
    for (const [id, m] of this.outbox) if (m.chatKey === key) this.outbox.delete(id);
    for (const m of this.messages.get(key) ?? []) if (isPending(m)) this.outbox.set(m.id, m);
  }
  async attachmentReferences(): Promise<Set<string>> {
    const refs = new Set<string>();
    const add = (items: Attachment[] = []) => { for (const a of items) if (a.file) refs.add(path.resolve(a.file)); };
    // Inspect unopened histories one at a time without retaining all chats in memory.
    for (const key of this.chats.keys()) {
      if (this.loaded.has(key)) continue;
      try {
        const cached = JSON.parse(await fs.readFile(this.file(key), 'utf8'));
        if (!Array.isArray(cached)) throw new Error('聊天缓存格式异常，暂停清理附件');
        for (const m of cached) { add(m.outgoing?.attachments); add(m.localImages); add(m.localVideos); }
      } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    }
    // Read current references after filesystem awaits, so edits during the scan are protected.
    for (const d of this.drafts.values()) add(d.attachments); // Includes bounded undo attachments.
    for (const messages of this.messages.values()) for (const m of messages) { add(m.outgoing?.attachments); add(m.localImages); add(m.localVideos); }
    return refs;
  }
  upsert(chat: Chat): void {
    const current = this.chats.get(chat.key);
    this.chats.set(chat.key, current ? { ...current, name: chat.name, remark: chat.remark ?? current.remark, nickname: chat.nickname ?? current.nickname } : chat);
    this.changed(chat.key, 'chat');
  }
  history(key: string, messages: Message[]): void {
    const combined = [...messages, ...this.messages.get(key) ?? []];
    const own = new Set(combined.filter(m => m.senderId === this.selfId).map(m => m.id));
    for (const m of combined) if (m.replyId && own.has(m.replyId)) m.replyToSelf = true;
    this.messages.set(key, mergeMessages(messages, this.messages.get(key) ?? [], this.limit));
    this.trackOutbox(key); this.dirty.add(key); this.changed(key);
  }
  setMembers(key: string, data: any[]): void {
    const members = new Map<string, Member>();
    for (const m of data) if (/^\d+$/.test(id(m.user_id))) members.set(id(m.user_id), {
      id: id(m.user_id), name: inline(m.card || m.nickname || m.user_id), title: inline(m.title), nickname: inline(m.nickname),
      role: ['owner', 'admin', 'member'].includes(m.role) ? m.role : 'member'
    });
    this.members.set(key, members); this.emit('change', key, 'members');
  }
  displayMessages(key: string): Message[] {
    return (this.messages.get(key) ?? []).map(message => {
      const member = this.members.get(key)?.get(message.senderId);
      let name = member?.name || message.senderName;
      const friend = message.senderId !== this.selfId && this.chats.get(`private:${message.senderId}`);
      if (friend && key.startsWith('private:')) name = friend.name;
      const segments = message.segments.map(segment => {
        if (segment.type !== 'mention') return segment;
        const member = this.members.get(key)?.get(segment.qq);
        const friend = this.chats.get(`private:${segment.qq}`);
        const displayName = (member?.name !== segment.qq ? member?.name : undefined)
          || segment.name || friend?.remark || friend?.nickname || friend?.name || segment.qq;
        return { ...segment, name: segment.qq === 'all' ? '全体成员' : displayName, text: mentionText(segment.qq === 'all' ? '全体成员' : displayName) };
      });
      return { ...message, segments, senderName: name, senderRemark: friend ? friend.remark : undefined, senderNickname: member?.nickname || message.senderNickname || (friend ? friend.nickname : undefined), senderTitle: member?.title || message.senderTitle, senderRole: member?.role || message.senderRole };
    });
  }
  add(message: Message, countUnread: boolean): boolean {
    const current = this.messages.get(message.chatKey) ?? [];
    if (current.some(m => m.id === message.id)) return false;
    if (message.replyId && current.some(m => m.id === message.replyId && m.senderId === this.selfId)) message.replyToSelf = true;
    this.messages.set(message.chatKey, mergeMessages([], [...current, message], this.limit));
    const chat = this.chats.get(message.chatKey);
    if (chat) {
      if (message.time >= chat.lastTime) { chat.lastTime = message.time; chat.preview = messageText(message).replace(/\s+/g, ' ').slice(0, 100); }
      if (countUnread && message.senderId !== this.selfId) {
        chat.unread++; chat.mentioned ||= message.mentioned;
        chat.replied ||= message.replyToSelf || !!message.replyId && current.some(m => m.id === message.replyId && m.senderId === this.selfId);
      }
    }
    this.trackOutbox(message.chatKey); this.dirty.add(message.chatKey); this.changed(message.chatKey); return true;
  }
  markRead(key: string): void {
    const chat = this.chats.get(key);
    if (chat && (chat.unread || chat.mentioned || chat.replied)) { chat.unread = 0; chat.mentioned = false; chat.replied = false; this.changed(key, 'unread'); }
  }
  markReplyToSelf(key: string): void {
    const chat = this.chats.get(key);
    if (chat?.unread && !chat.replied) { chat.replied = true; this.changed(key, 'unread'); }
  }
  private updatePreview(message: Message): void {
    const chat = this.chats.get(message.chatKey);
    // Detail/receipt updates can arrive after a newer message in the same second.
    // Only the current last message owns the preview, regardless of equal timestamps.
    if (chat && this.messages.get(message.chatKey)?.at(-1)?.id === message.id) {
      chat.lastTime = Math.max(chat.lastTime, message.time);
      chat.preview = message.recalled ? '[消息已撤回]' : messageText(message).replace(/\s+/g, ' ').slice(0, 100);
    }
  }
  enrichMessage(message: Message, refreshPreview = false): void {
    const messages = this.messages.get(message.chatKey);
    const index = messages?.findIndex(m => m.id === message.id) ?? -1;
    if (!messages || index < 0 || messages[index].recalled) return;
    messages[index] = { ...messages[index], ...message };
    if (refreshPreview) this.updatePreview(messages[index]);
    this.trackOutbox(message.chatKey); this.dirty.add(message.chatKey); this.changed(message.chatKey);
  }
  settleOutgoing(key: string, localId: string, confirmed: Message, excludeFileEchoIds?: ReadonlySet<string>): Message {
    const current = this.messages.get(key) ?? [];
    const local = current.find(m => m.id === localId);
    // A real message ID is authoritative. UUID-only upload receipts may match
    // new echoes, but never an older occurrence of the same file.
    const matchFile = confirmed.id === localId && !!excludeFileEchoIds;
    const echo = current.find(m => m.id !== localId && (m.id === confirmed.id || (matchFile && !excludeFileEchoIds!.has(m.id) && m.senderId === this.selfId && !m.id.startsWith('local:') && confirmed.fileIds?.some(f => m.fileIds?.includes(f)))));
    const message: Message = { ...confirmed, ...echo, sendState: 'sent', localImages: local?.localImages, localVideos: local?.localVideos, outgoing: undefined, forwardDelivery: undefined, sendError: undefined };
    const settled = current.filter(m => m.id !== message.id || m.id === localId).map(m => m.id === localId ? message : m);
    if (!local) settled.push(message);
    this.messages.set(key, mergeMessages([], settled, this.limit));
    if (local?.forwardDelivery) this.updatePreview(message);
    this.trackOutbox(key); this.dirty.add(key); this.changed(key); return message;
  }
  setNotification(key: string, notification: Chat['notification']): void {
    const chat = this.chats.get(key);
    if (chat && chat.notification !== notification) { chat.notification = notification; this.changed(key, 'notification'); }
  }
  toggleIgnoreUnread(key: string): void {
    const chat = this.chats.get(key);
    if (chat) { chat.ignoreUnread = !chat.ignoreUnread; this.changed(key, 'notification'); }
  }
  recall(key: string, messageId: string): void {
    const message = this.messages.get(key)?.find(m => m.id === messageId);
    if (!message || message.recalled) return;
    const chat = this.chats.get(key);
    if (chat && this.messages.get(key)?.at(-1)?.id === messageId) chat.preview = '[消息已撤回]';
    this.enrichMessage({ ...message, recalled: true, outgoing: undefined, sendState: undefined, sendProgress: undefined, sendError: undefined });
  }
  toggleCollapsed(key: string): void {
    if (this.chats.get(key)?.type !== 'group') return;
    if (this.collapsed.has(key)) this.collapsed.delete(key); else this.collapsed.add(key);
    this.changed(key, 'collapsed');
  }
  toggleFavorite(key: string): void {
    if (!this.chats.has(key)) return;
    if (this.favorites.has(key)) this.favorites.delete(key); else this.favorites.add(key);
    this.changed(key, 'favorites');
  }
  draft(key: string): Draft { return this.draftService.draft(key); }
  setDraft(key: string, text: string, replyId?: string, attachments?: Attachment[]): Draft { return this.draftService.setDraft(key, text, replyId, attachments); }
  reserveMention(key: string, qq: string, name: string): string { return this.draftService.reserveMention(key, qq, name); }
  editDraft(key: string, text: string): Draft { return this.draftService.editDraft(key, text); }
  setReply(key: string, replyId: string, name: string): Draft { return this.draftService.setReply(key, replyId, name); }
  cancelReply(key: string): Draft { return this.draftService.cancelReply(key); }
  clearDraftIfVersion(key: string, version: number): boolean { return this.draftService.clearDraftIfVersion(key, version); }
  completeSend(key: string, captured: Draft): boolean { return this.draftService.completeSend(key, captured); }
  attach(key: string, attachments: Attachment[]): void { this.draftService.attach(key, attachments); }
  prepareAttachments(key: string, attachments: Attachment[]): Attachment[] { return this.draftService.prepareAttachments(key, attachments); }
  removeAttachment(key: string, id: string): void { this.draftService.removeAttachment(key, id); }
  private changed(key: string, kind: StoreChange = 'messages'): void { this.schedule(); this.emit('change', key, kind); }
  private schedule(): void {
    this.stateDirty = true;
    if (!this.saveTimer) this.saveTimer = setTimeout(() => { this.saveTimer = undefined; void this.flush(); }, 1200);
  }
  async flush(): Promise<void> {
    clearTimeout(this.saveTimer); this.saveTimer = undefined;
    this.saving = this.saving.then(async () => {
      if (!this.stateDirty && !this.dirty.size) return;
      const keys = [...this.dirty]; this.dirty.clear(); this.stateDirty = false;
      try {
        await fs.mkdir(this.folder, { recursive: true });
        for (const key of keys) {
          // Merge unread-on-disk messages before persisting a newly received event.
          await this.load(key);
          await this.atomic(this.file(key), this.messages.get(key) ?? []);
        }
        await this.atomic(path.join(this.folder, 'state.json'), {
          version: 3, outbox: [...this.outbox.values()], attachmentSerial: this.draftService.attachmentSerial, chats: [...this.chats.values()], favorites: [...this.favorites], collapsed: [...this.collapsed],
          drafts: Object.fromEntries([...this.drafts].filter(([, d]) => d.text || d.replyId || d.attachments.length))
        });
      } catch {
        keys.forEach(key => this.dirty.add(key)); this.stateDirty = true;
        this.emit('storageError', new Error('缓存保存失败，消息仍保留在内存中'));
      }
    });
    await this.saving;
  }
  private async atomic(file: string, data: unknown): Promise<void> {
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data), 'utf8'); await fs.rename(tmp, file);
  }
  async dispose(): Promise<void> { await this.flush(); this.removeAllListeners(); }
}
