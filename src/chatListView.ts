import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { ChatTree } from './tree';
import { ChatStore } from './store';
import { allowsUnread } from './notifications';
import { systemChatName } from './systemChats';

// TreeView does not expose an embedded input. Keep filtering/sorting in ChatTree
// and use a small theme-aware view for a permanent search field.
export class ChatListView implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private subscriptions: vscode.Disposable[] = [];
  private pendingFocus = false;
  private activeKey?: string;
  constructor(private tree: ChatTree, private store: () => ChatStore | undefined, private filter: (query: string) => void, private extensionUri: vscode.Uri) {
    this.subscriptions.push(tree.onDidChangeTreeData(() => this.update()));
  }
  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')] };
    view.webview.html = this.html(view.webview);
    const messages = view.webview.onDidReceiveMessage(async data => {
      if (!data || typeof data !== 'object') return;
      if (data.type === 'ready') {
        void view.webview.postMessage({ type: 'initialFilter', query: this.tree.filter }); this.update(true);
        if (this.pendingFocus) this.focusSearch();
        return;
      }
      if (data.type === 'focused') { this.pendingFocus = false; return; }
      if (data.type === 'filter' && typeof data.query === 'string') { this.filter(data.query.slice(0, 200)); return; }
      const store = this.store();
      if (!store || data.account !== store.selfId || typeof data.key !== 'string' || !store.chats.has(data.key)) return;
      const command = { open: 'qq.openChat', favorite: 'qq.toggleFavorite', collapse: 'qq.toggleCollapsed' }[data.type as string];
      if (command) await vscode.commands.executeCommand(command, data.key);
    });
    const visibility = view.onDidChangeVisibility(() => { if (view.visible) this.update(true); });
    const closed = view.onDidDispose(() => { messages.dispose(); visibility.dispose(); closed.dispose(); if (this.view === view) this.view = undefined; });
  }
  focusSearch(): void {
    this.pendingFocus = true;
    if (!this.view) return;
    void this.view.webview.postMessage({ type: 'focus' });
  }
  setFilter(query: string): void { void this.view?.webview.postMessage({ type: 'filter', query }); }
  setActive(key?: string): void {
    if (key === this.activeKey) return;
    this.activeKey = key;
    void this.view?.webview.postMessage({ type: 'active', account: this.store()?.selfId ?? '', key: key ?? '' });
  }
  private update(revealActive = false): void {
    if (!this.view?.visible) return;
    const store = this.store(), config = vscode.workspace.getConfiguration('qq');
    const showAvatars = config.get('showAvatars', true);
    const rows = this.tree.getChildren('', true).map(chat => ({
      key: chat.key, name: chat.name, id: chat.id, kind: chat.type,
      system: !!systemChatName(chat.type, chat.id), lastTime: chat.lastTime, hasMessages: !!store?.hasMessages(chat.key),
      avatar: showAvatars && /^\d+$/.test(chat.id) && !systemChatName(chat.type, chat.id) ? chat.type === 'group'
        ? `https://p.qlogo.cn/gh/${chat.id}/${chat.id}/100` : `https://q1.qlogo.cn/g?b=qq&nk=${chat.id}&s=100` : undefined,
      search: `${chat.name} ${chat.remark ?? ''} ${chat.nickname ?? ''} ${chat.id}`.toLocaleLowerCase(),
      collapsed: !!store?.collapsed.has(chat.key), preview: chat.preview, favorite: !!store?.favorites.has(chat.key), unread: chat.unread,
      mention: chat.mentioned, reply: chat.replied, muted: !allowsUnread(chat), tooltip: this.tree.getTreeItem(chat).tooltip
    }));
    void this.view.webview.postMessage({ type: 'rows', account: store?.selfId ?? '', rows, showAvatars, palette: Object.fromEntries(['mentionColor', 'replyColor', 'unreadColor'].map(key => [key, vscode.workspace.getConfiguration('qq').get(key)])), active: this.activeKey ?? '', revealActive });
  }
  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('hex');
    const iconFont = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'codicon.ttf'));
    const stylesheet = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'chatList.css'));
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'chatList.js'));
    return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https://q1.qlogo.cn https://p.qlogo.cn; font-src ${webview.cspSource}; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="${stylesheet}"><style nonce="${nonce}">
@font-face{font-family:qq-codicons;src:url('${iconFont}') format('truetype');font-display:block}.codicon{display:inline-block;width:16px;height:16px;line-height:16px;font:normal normal normal 16px/1 qq-codicons;text-align:center;flex-shrink:0;-webkit-font-smoothing:antialiased}
</style></head><body data-section="list" class="show-avatars"><div class="search"><div class="search-field"><input id="search" type="text" maxlength="200" aria-label="搜索会话" placeholder="搜索名称、备注、号码" autocomplete="off"><button id="clear" title="清除搜索" aria-label="清除搜索"></button></div></div><div class="list-tools"><button id="collapsed" class="collapsed-entry" aria-pressed="false">收纳箱 (0)</button><div id="count" role="status"></div></div><div id="empty"></div><div id="results" role="listbox" aria-label="会话列表"></div>
<script nonce="${nonce}" src="${script}"></script></body></html>`;
  }
  dispose(): void { this.subscriptions.forEach(d => d.dispose()); }
}
