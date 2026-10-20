import type { Chat, Member, Message } from './model';
import type { ChatStore } from './store';

export type GroupRole = 'owner' | 'admin' | 'member';
type Rule = 'moderate' | 'manager' | 'owner' | 'admin' | 'card' | 'leave' | 'file' | 'recall' | 'message';
export const commandRules: Readonly<Record<string, Rule>> = {
  recall: 'recall', react: 'message', unreact: 'message',
  ban: 'moderate', unban: 'moderate', kick: 'moderate',
  ban_all: 'manager', unban_all: 'manager', rename: 'manager',
  notice: 'manager', notice_delete: 'manager', essence_add: 'manager', essence_remove: 'manager',
  folder: 'manager', folder_delete: 'manager', group_request: 'manager',
  admin: 'admin', unadmin: 'admin', title: 'owner', dismiss: 'owner',
  card: 'card', leave: 'leave', group_file_delete: 'file'
};
export function groupRole(value: unknown): GroupRole | undefined {
  return value === 'owner' || value === 'admin' || value === 'member' ? value : undefined;
}
const manager = (role?: GroupRole) => role === 'owner' || role === 'admin';
export function canManageMember(command: string, selfId: string, targetId: string, selfRole?: GroupRole, targetRole?: GroupRole): boolean {
  const rule = commandRules[command];
  if (rule === 'card' && selfId === targetId) return true;
  if (rule === 'owner') return selfRole === 'owner' && !!targetRole;
  if (rule === 'admin') return selfRole === 'owner' && targetId !== selfId && !!targetRole && targetRole !== 'owner';
  if (rule === 'moderate' || rule === 'card') return targetId !== selfId && !!targetRole
    && (selfRole === 'owner' && targetRole !== 'owner' || selfRole === 'admin' && targetRole === 'member');
  return true;
}
export function usableMessage(message: Message, chatKey: string): boolean {
  return message.chatKey === chatKey && /^-?\d+$/.test(message.id) && Number(message.id) !== 0
    && Number.isSafeInteger(Number(message.id)) && !message.recalled && !message.systemNotice
    && (!message.sendState || message.sendState === 'sent');
}
export function canRecall(message: Message, chat: Chat, selfId: string, roles: ReadonlyMap<string, GroupRole>): boolean {
  if (!usableMessage(message, chat.key)) return false;
  if (message.senderId === selfId) return true;
  return chat.type === 'group' && canManageMember('ban', selfId, message.senderId, roles.get(selfId), roles.get(message.senderId));
}
export function memberAllowed(command: string, selfId: string, target: Member, members: ReadonlyMap<string, Member>): boolean {
  return canManageMember(command, selfId, target.id, groupRole(members.get(selfId)?.role), groupRole(target.role));
}

// Each command owns its permission snapshot. Cached display names are not proof
// of authority; refresh() discards roles before the final mutation.
export class CommandPermissions {
  private roles = new Map<string, GroupRole>();
  private loaded = new Set<string>();
  private fileFolder: string | undefined;
  constructor(private store: ChatStore, readonly chat: Chat,
    private read: (action: string, params: Record<string, unknown>) => Promise<any>) {}
  refresh(): void { this.roles.clear(); this.loaded.clear(); }
  private async role(userId: string): Promise<GroupRole | undefined> {
    if (!this.loaded.has(userId)) {
      const data = await this.read('get_group_member_info', { group_id: this.chat.id, user_id: userId, no_cache: true }).catch(() => undefined);
      this.loaded.add(userId);
      if (String(data?.user_id) === userId && (data?.group_id === undefined || String(data.group_id) === this.chat.id)) {
        const role = groupRole(data?.role); if (role) this.roles.set(userId, role);
      }
    }
    return this.roles.get(userId);
  }
  async members(command: string): Promise<Member[]> {
    this.refresh();
    const data = await this.read('get_group_member_list', { group_id: this.chat.id, no_cache: true }).catch(() => undefined);
    const names = new Map(this.store.members.get(this.chat.key));
    if (Array.isArray(data)) for (const item of data) {
      const id = String(item?.user_id ?? ''), role = groupRole(item?.role);
      if (!/^[1-9]\d*$/.test(id) || item.group_id !== undefined && String(item.group_id) !== this.chat.id) continue;
      this.loaded.add(id);
      if (role) this.roles.set(id, role);
      names.set(id, { id, name: String(item.card || item.nickname || id), nickname: item.nickname, title: String(item.title || ''), role: role ?? '' });
    }
    const self = this.store.selfId, selfRole = await this.role(self);
    if (!names.has(self)) names.set(self, { id: self, name: self, title: '', role: selfRole ?? '' });
    return [...names.values()].filter(member => canManageMember(command, self, member.id, selfRole, this.roles.get(member.id)));
  }
  async messages(command: string): Promise<Message[]> {
    if (command === 'recall' && this.chat.type === 'group') await this.members(command);
    return this.store.displayMessages(this.chat.key).filter(message => command === 'recall'
      ? canRecall(message, this.chat, this.store.selfId, this.roles) : usableMessage(message, this.chat.key));
  }
  private message(id: unknown): Message {
    const message = this.store.messages.get(this.chat.key)?.find(message => message.id === String(id));
    if (!message || !usableMessage(message, this.chat.key)) throw new Error('此消息不在当前会话中或已不可操作');
    return message;
  }
  private async ownsFile(fileId: string): Promise<boolean | undefined> {
    const read = async (folder?: string) => this.read(folder ? 'get_group_files_by_folder' : 'get_group_root_files',
      { group_id: this.chat.id, file_count: 200, ...(folder ? { folder_id: folder } : {}) });
    const owned = (data: any) => {
      const file = Array.isArray(data?.files) && data.files.find((file: any) => String(file.file_id) === fileId);
      return file && /^[1-9]\d*$/.test(String(file.uploader)) ? String(file.uploader) === this.store.selfId : undefined;
    };
    if (this.fileFolder !== undefined) return owned(await read(this.fileFolder || undefined));
    const root = await read(), own = owned(root);
    if (own !== undefined) { this.fileFolder = ''; return own; }
    for (const folder of Array.isArray(root?.folders) ? root.folders : []) {
      if (!folder?.folder_id) continue;
      const id = String(folder.folder_id), own = owned(await read(id));
      if (own !== undefined) { this.fileFolder = id; return own; }
    }
    return undefined;
  }
  async check(command: string, params?: Record<string, unknown>): Promise<void> {
    const rule = commandRules[command]; if (!rule) return;
    const self = this.store.selfId;
    if (params?.message_id !== undefined) {
      const message = this.message(params.message_id);
      if (rule === 'recall') {
        if (message.senderId === self) return;
        if (this.chat.type !== 'group') throw new Error('私聊只能撤回自己发送的消息');
        await this.role(self); await this.role(message.senderId);
        if (!canRecall(message, this.chat, self, this.roles)) throw new Error('没有撤回此消息的权限');
        return;
      }
    }
    if (rule === 'recall' || rule === 'message') return;
    if (this.chat.type !== 'group') throw new Error('此操作仅用于群聊');
    if (rule === 'card' && (!params || String(params.user_id) === self)) return;
    if (rule === 'file' && !params) return;
    const role = await this.role(self);
    if (!role) throw new Error('无法确认当前群权限');
    if (rule === 'leave') {
      if (role === 'owner') throw new Error('群主请先转让群主，或使用解散群聊');
      return;
    }
    if (rule === 'file') {
      if (manager(role)) return;
      const owned = await this.ownsFile(String(params!.file_id));
      if (owned) return;
      if (owned === undefined) throw new Error('无法确认此群文件的上传者');
      throw new Error('只能删除自己上传的群文件');
    }
    if (rule === 'owner' || rule === 'admin') {
      if (role !== 'owner') throw new Error('此操作需要群主权限');
    } else if (!manager(role)) throw new Error('此操作需要群主或管理员权限');
    if (params?.user_id !== undefined && ['moderate', 'admin', 'owner', 'card'].includes(rule)) {
      const target = String(params.user_id), targetRole = await this.role(target);
      if (!canManageMember(command, self, target, role, targetRole)) throw new Error('没有操作此成员的权限');
    }
  }
}
