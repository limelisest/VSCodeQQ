import * as vscode from 'vscode';
import { Chat } from './model';
import { ChatStore } from './store';
import { allowsUnread } from './notifications';
import { systemChatName } from './systemChats';
export type Section = 'list';
export class ChatTree implements vscode.Disposable {
  private emitter = new vscode.EventEmitter<Chat | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private timer?: NodeJS.Timeout;
  filter = '';
  setFilter(value: string): void { this.filter = value.trim(); this.refresh(); }
  constructor(readonly section: Section, private getStore: () => ChatStore | undefined) {}
  refresh(): void {
    if (!this.timer) this.timer = setTimeout(() => { this.timer = undefined; this.emitter.fire(undefined); }, 150);
  }
  getChildren(filter = this.filter, includeHidden = false): Chat[] {
    const store = this.getStore(); if (!store) return [];
    const terms = filter.toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return [...store.chats.values()].filter(chat => {
      if (!terms.every(term => `${chat.name} ${chat.remark ?? ''} ${chat.nickname ?? ''} ${chat.id}`.toLocaleLowerCase().includes(term))) return false;
      return includeHidden || terms.length > 0 || store.hasMessages(chat.key) && !store.collapsed.has(chat.key);
    }).sort((a,b) => Number(store.favorites.has(b.key)) - Number(store.favorites.has(a.key)) || Number(b.unread > 0 && allowsUnread(b)) - Number(a.unread > 0 && allowsUnread(a)) || b.lastTime - a.lastTime || a.name.localeCompare(b.name, 'zh-CN'));
  }
  getTreeItem(chat: Chat): vscode.TreeItem {
    const node = new vscode.TreeItem(chat.name);
    node.id = `${this.section}:${chat.key}`; node.contextValue = 'qq-chat';
    const system = !!systemChatName(chat.type, chat.id);
    const mode = chat.ignoreUnread ? '已设为不提醒' : system ? '系统通知；可右键设为不提醒' : chat.type === 'private' ? '好友免打扰未同步；可右键设为不提醒' : chat.notification === 'muted' ? 'QQ 免打扰' : chat.notification === 'notify' ? 'QQ 接收并提醒' : '免打扰状态未知，显示未读但暂不提醒和置顶';
    const allowed = allowsUnread(chat);
    node.description = `${!allowed ? '◦ ' : ''}${chat.mentioned ? '@我 ' : ''}${chat.replied ? '回复我 ' : ''}${chat.unread ? `(${chat.unread}) ` : ''}${chat.preview}`.trim();
    node.tooltip = `${chat.name}\n${chat.type === 'group' ? '群号' : 'QQ'}：${chat.id}\n${mode}${chat.preview ? `\n${chat.preview}` : ''}`;
    node.iconPath = new vscode.ThemeIcon(this.getStore()?.favorites.has(chat.key) ? 'star-full' : system ? 'mail' : chat.type === 'group' ? 'organization' : 'account');
    node.command = { command: 'qq.openChat', title: '打开会话', arguments: [chat.key] };
    return node;
  }
  dispose(): void { clearTimeout(this.timer); this.emitter.dispose(); }
}
