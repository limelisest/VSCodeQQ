import { Chat, Message, id, inline } from './model';
import { ChatStore } from './store';
import { OneBotClient } from './onebot';
import { systemChatName } from './systemChats';

// System/service accounts often aren't friends. Resolve missing names through
// the standard profile API instead of guessing identities from shared cards.
export class PrivateChatProfiles {
  private pending = new Map<string, Promise<void>>();
  private attempted = new Map<string, number>();
  constructor(private store: ChatStore, private client: Pick<OneBotClient, 'call'>, private current: () => boolean) {}

  private needsName(chat: Chat): boolean {
    const named = (name?: string) => !!name?.trim() && name.trim() !== chat.id;
    return chat.type === 'private' && chat.id !== this.store.selfId
      && (!named(chat.name) || chat.name === systemChatName(chat.type, chat.id))
      && !named(chat.remark) && !named(chat.nickname);
  }

  observe(message: Message): Promise<void> {
    const chat = this.store.chats.get(message.chatKey);
    const name = inline(message.senderName).trim();
    if (this.current() && chat && this.needsName(chat) && message.senderId === chat.id
      && name && name !== chat.id && name !== systemChatName(chat.type, chat.id)) {
      this.store.upsert({ ...chat, name, nickname: message.senderNickname || name });
    }
    return this.ensure(message.chatKey);
  }

  ensure(key: string): Promise<void> {
    const pending = this.pending.get(key); if (pending) return pending;
    const chat = this.store.chats.get(key);
    if (!this.current() || !chat || !this.needsName(chat) || Date.now() - (this.attempted.get(key) ?? 0) < 60000) return Promise.resolve();
    this.attempted.set(key, Date.now());
    const task = this.resolve(key, chat.id).finally(() => { if (this.pending.get(key) === task) this.pending.delete(key); });
    this.pending.set(key, task); return task;
  }

  private async resolve(key: string, userId: string): Promise<void> {
    try {
      const info = await this.client.call('get_stranger_info', { user_id: userId }, 5000);
      const chat = this.store.chats.get(key);
      if (!this.current() || !chat || !this.needsName(chat) || info?.user_id != null && id(info.user_id) !== userId) return;
      const nickname = typeof info?.nickname === 'string' ? inline(info.nickname).trim() : '';
      if (nickname && nickname !== userId) this.store.upsert({ ...chat, name: nickname, nickname });
    } catch { /* Optional profile queries must not interrupt messages or history. */ }
  }

  async refresh(): Promise<void> {
    const keys = [...this.store.chats.values()].filter(chat => this.needsName(chat)).map(chat => chat.key);
    for (let i = 0; i < keys.length && this.current(); i += 4) await Promise.all(keys.slice(i, i + 4).map(key => this.ensure(key)));
  }
}
