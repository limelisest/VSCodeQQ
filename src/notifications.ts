import { Chat } from './model';
import { ChatStore } from './store';
import { OneBotClient } from './onebot';

// Count display cells without splitting emoji, combining marks or other grapheme clusters.
const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
function previewText(value: string, limit: number): string {
  // Native notification links are parsed even in plain strings. Keep QQ text literal.
  const text = value.replace(/\s+/g, ' ').trim().replace(/\[/g, '［').replace(/\]/g, '］');
  const parts: { text: string; width: number }[] = [];
  let width = 0;
  for (const { segment } of segments.segment(text)) {
    const size = /^[\x00-\x7f]+$/.test(segment) ? segment.length : 2;
    if (width + size > limit) {
      while (width + 1 > limit) width -= parts.pop()!.width;
      return parts.map(part => part.text).join('') + '…';
    }
    parts.push({ text: segment, width: size }); width += size;
  }
  return parts.map(part => part.text).join('');
}
export function notificationPreview(chat: string, reason: string, body: string): string {
  return previewText(`${previewText(chat, 20)} · ${reason}：${body}`, 72);
}

export function groupNotification(data: any): NonNullable<Chat['notification']> {
  // NapCat GroupDetailInfo.cmdUinMsgMask / QQ GroupMsgMask, not group_all_shut (a speaking ban).
  const mask = data?.cmdUinMsgMask;
  if (mask === 1 || mask === '1') return 'notify';
  if ([2, 3, 4, '2', '3', '4'].includes(mask)) return 'muted';
  return 'unknown';
}
export function allowsUnread(chat: Chat): boolean {
  // OneBot's friend/recents projection does not expose QQ private-chat DND.
  return !chat.ignoreUnread && (chat.mentioned || !!chat.replied || chat.type === 'private' || chat.notification === 'notify');
}

export function countedUnread(chat: Chat): number {
  if (chat.ignoreUnread || chat.notification === 'muted') return 0;
  if (chat.type === 'group' && chat.notification !== 'notify') return 0;
  return chat.unread;
}

// Conversation flags are sticky until read. They keep the tab/list highlighted,
// but must never grant a notification exception to later unrelated messages.
export function allowsMessageNotification(chat: Chat, mentioned: boolean, replyToSelf: boolean): boolean {
  return !chat.ignoreUnread && (mentioned || replyToSelf || chat.type === 'private' || chat.notification === 'notify');
}

export class NotificationSync {
  private checked = new Map<string, number>();
  private pending = new Map<string, Promise<void>>();
  private active = 0;
  private waiting: (() => void)[] = [];
  private stopped = false;
  constructor(private store: ChatStore, private client: OneBotClient) {}
  async refresh(force = false): Promise<void> {
    await Promise.all([...this.store.chats.values()].filter(c => c.type === 'group').map(c => this.ensure(c.key, force)));
  }
  ensure(key: string, force = false): Promise<void> {
    const existing = this.pending.get(key); if (existing) return existing;
    const chat = this.store.chats.get(key);
    if (!chat || chat.type !== 'group' || this.stopped || !this.client.connected) return Promise.resolve();
    const ttl = chat.notification === 'unknown' ? 60000 : 300000;
    if (!force && Date.now() - (this.checked.get(key) ?? 0) < ttl) return Promise.resolve();
    const task = this.query(key, chat.id).finally(() => this.pending.delete(key));
    this.pending.set(key, task); return task;
  }
  private async query(key: string, id: string): Promise<void> {
    if (this.active >= 4) await new Promise<void>(r => this.waiting.push(r)); else this.active++;
    try {
      if (this.stopped || !this.client.connected) return;
      let state: Chat['notification'] = 'unknown';
      try { state = groupNotification(await this.client.call('get_group_detail_info', { group_id: id }, 8000)); } catch {}
      if (this.stopped) return;
      this.checked.set(key, Date.now()); this.store.setNotification(key, state);
    } finally { const next = this.waiting.shift(); if (next) next(); else this.active--; }
  }
  dispose(): void { this.stopped = true; }
}
