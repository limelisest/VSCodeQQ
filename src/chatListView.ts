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
    const store = this.store();
    const rows = this.tree.getChildren('', true).map(chat => ({
      key: chat.key, name: chat.name, id: chat.id, kind: chat.type,
      system: !!systemChatName(chat.type, chat.id),
      search: `${chat.name} ${chat.remark ?? ''} ${chat.nickname ?? ''} ${chat.id}`.toLocaleLowerCase(),
      collapsed: !!store?.collapsed.has(chat.key), preview: chat.preview, favorite: !!store?.favorites.has(chat.key), unread: chat.unread,
      mention: chat.mentioned, reply: chat.replied, muted: !allowsUnread(chat), tooltip: this.tree.getTreeItem(chat).tooltip
    }));
    void this.view.webview.postMessage({ type: 'rows', account: store?.selfId ?? '', rows, active: this.activeKey ?? '', revealActive });
  }
  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('hex');
    const iconFont = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'codicon.ttf'));
    return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src ${webview.cspSource}; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width,initial-scale=1"><style nonce="${nonce}">
@font-face{font-family:qq-codicons;src:url('${iconFont}') format('truetype');font-display:block}.codicon{display:inline-block;width:16px;height:16px;line-height:16px;font:normal normal normal 16px/1 qq-codicons;text-align:center;flex-shrink:0;-webkit-font-smoothing:antialiased}
*{box-sizing:border-box}body{padding:0;margin:0;color:var(--vscode-sideBar-foreground);background:var(--vscode-sideBar-background);font:var(--vscode-font-size) var(--vscode-font-family);height:100vh;display:flex;flex-direction:column}
.search{display:flex;gap:3px;flex-shrink:0;padding:6px 8px;background:var(--vscode-sideBar-background)}input{min-width:0;width:100%;height:26px;border:1px solid var(--vscode-input-border,transparent);background:var(--vscode-input-background);color:var(--vscode-input-foreground);padding:3px 6px;font:inherit;outline:none}input:focus,button:focus-visible,.row:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}input::placeholder{color:var(--vscode-input-placeholderForeground)}
button{font:inherit;border:0;cursor:pointer;background:transparent;color:inherit;padding:3px 5px}button:hover{background:var(--vscode-toolbar-hoverBackground)}#results{overflow-y:auto;flex:1;min-height:0}.row{display:flex;align-items:center;gap:6px;padding:5px 8px;min-height:42px;cursor:pointer;outline:none}.row:hover{background:var(--vscode-list-hoverBackground);color:var(--vscode-list-hoverForeground)}.row.starred .name{font-weight:600}.row.active,#results:focus-within .row.selected{background:var(--vscode-list-inactiveSelectionBackground)}.row:focus{background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground)}.kind{opacity:.8}.text{flex:1;min-width:0}.name,.preview{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.preview{opacity:.7;font-size:11px;margin-top:2px}.count{border-radius:9px;padding:1px 5px;font-size:11px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground)}.count.muted{background:var(--vscode-editor-inactiveSelectionBackground,var(--vscode-badge-background));color:var(--vscode-descriptionForeground,var(--vscode-badge-foreground));opacity:.7}.box-icon{width:16px;height:16px;vertical-align:middle;flex-shrink:0}.row-actions{display:none;align-items:center;gap:2px;flex-shrink:0}.row-actions button{display:flex;align-items:center;justify-content:center;width:22px;height:22px;padding:3px}.row:hover .row-actions{display:flex}.row:hover>.count{display:none}.collapsed-entry{display:flex;align-items:center;gap:6px;text-align:left;padding:7px 8px;flex-shrink:0;border-bottom:1px solid var(--vscode-panel-border);font-weight:600}.collapsed-entry[aria-pressed=true]{color:var(--vscode-textLink-foreground)}#empty{padding:10px;opacity:.7}#empty:empty{display:none}#count{padding:0 8px 4px;font-size:11px;opacity:.65}::-webkit-scrollbar{width:8px}::-webkit-scrollbar-thumb{background:var(--vscode-scrollbarSlider-background)}
</style></head><body data-section="list"><div class="search"><input id="search" type="text" maxlength="200" aria-label="搜索会话" placeholder="搜索名称、备注、号码" autocomplete="off"><button id="clear" title="清除搜索" aria-label="清除搜索">×</button></div><button id="collapsed" class="collapsed-entry" aria-pressed="false">收纳箱 (0)</button><div id="count" role="status"></div><div id="empty"></div><div id="results" role="listbox" aria-label="会话列表"></div>
<script nonce="${nonce}">
const vscode=acquireVsCodeApi(), input=document.getElementById('search'), results=document.getElementById('results');
let rows=[],account='',selected='',active='',composing=false,touched=false,collapsed=!!vscode.getState()?.collapsed;
function save(){vscode.setState({query:input.value,collapsed});}
input.value=vscode.getState()?.query||'';
function send(type,key){vscode.postMessage({type,key,account});}
function icon(name){const node=document.createElement('span');node.className='codicon codicon-'+name;node.setAttribute('aria-hidden','true');node.textContent=String.fromCodePoint({account:0xeb99,organization:0xea7e,mail:0xeb1c,'star-full':0xeb59,'star-empty':0xea6a,archive:0xea98,discard:0xeae2}[name]);return node;}
function boxIcon(){return icon('archive');}
function unreadBadge(unread,muted,prefix=''){const count=document.createElement('span');count.className='count'+(muted?' muted':'');count.textContent=prefix+(unread>99?'99+':unread);count.title=unread+' 条未读'+(muted?' · 不提醒':'');return count;}
function render(){
 const focused=results.contains(document.activeElement),scroll=results.scrollTop,terms=input.value.trim().toLocaleLowerCase().split(/\\s+/).filter(Boolean);
 const visible=rows.filter(row=>terms.every(term=>row.search.includes(term))&&(terms.length>0||row.collapsed===collapsed));
 const entry=document.getElementById('collapsed');
 if(entry){const folded=rows.filter(row=>row.collapsed),unread=folded.reduce((n,row)=>n+row.unread,0);entry.replaceChildren(boxIcon(),document.createTextNode((collapsed?'← 返回列表 · ':'')+'收纳箱 ('+folded.length+')'));if(unread)entry.append(unreadBadge(unread,!folded.some(row=>row.unread&&!row.muted)));entry.setAttribute('aria-pressed',String(collapsed));results.setAttribute('aria-label',collapsed?'收纳箱':'会话列表');}
 if(!visible.some(row=>row.key===selected))selected=visible.find(row=>row.key===active)?.key||visible[0]?.key||'';
 const fragment=document.createDocumentFragment();
 for(const row of visible){
  const item=document.createElement('div');item.className='row'+(row.key===selected?' selected':'')+(row.favorite?' starred':'')+(row.key===active?' active':'');item.dataset.key=row.key;item.tabIndex=row.key===selected?0:-1;item.setAttribute('role','option');item.setAttribute('aria-selected',String(row.key===selected));if(row.key===active)item.setAttribute('aria-current','true');item.title=row.tooltip||row.name;
  item.dataset.vscodeContext=JSON.stringify({webviewSection:'qq-chat-row',key:row.key,account,chatType:row.kind,preventDefaultContextMenuItems:true});
  const kind=icon(row.favorite?'star-full':row.system?'mail':row.kind==='group'?'organization':'account');kind.classList.add('kind');kind.title=(row.favorite?'已收藏 · ':'')+(row.system?'系统通知':row.kind==='group'?'群聊':'好友');kind.removeAttribute('aria-hidden');kind.setAttribute('role','img');kind.setAttribute('aria-label',kind.title);
  const text=document.createElement('div');text.className='text';const name=document.createElement('div');name.className='name';name.textContent=row.name;const preview=document.createElement('div');preview.className='preview';preview.textContent=(row.muted?'◦ ':'')+(row.preview||row.id);text.append(name,preview);item.append(kind,text);
  if(row.unread)item.append(unreadBadge(row.unread,row.muted,row.mention?'@ ':row.reply?'↩ ':''));
  const actions=document.createElement('div');actions.className='row-actions';
  const star=document.createElement('button');star.className='favorite'+(row.favorite?' saved':'');star.append(icon(row.favorite?'star-full':'star-empty'));star.title=row.favorite?'取消收藏':'收藏';star.setAttribute('aria-label',star.title);star.dataset.action='favorite';actions.append(star);
  if(row.kind==='group'){const fold=document.createElement('button');fold.className='fold';fold.append(icon(row.collapsed?'discard':'archive'));fold.title=row.collapsed?'移出收纳箱':'放入收纳箱';fold.setAttribute('aria-label',fold.title);fold.dataset.action='collapse';actions.append(fold);}
  item.append(actions);fragment.append(item);
 }
 results.replaceChildren(fragment);results.scrollTop=scroll;
 if(focused)[...results.children].find(row=>row.dataset.key===selected)?.focus({preventScroll:true});
 document.getElementById('empty').textContent=visible.length?'':input.value.trim()?'没有匹配的会话':collapsed?'收纳箱为空':account?'暂无会话':'请在下方设置中连接 OneBot 服务';
 document.getElementById('count').textContent=input.value.trim()?visible.length+' 个结果':'';
}
function revealActive(){[...results.children].find(row=>row.dataset.key===active)?.scrollIntoView({block:'nearest'});}
function filter(){touched=true;save();render();vscode.postMessage({type:'filter',query:input.value});}
function openChat(key){if(input.value){collapsed=false;input.value='';filter();}send('open',key);}
input.addEventListener('compositionstart',()=>composing=true);input.addEventListener('compositionend',()=>{composing=false;filter()});input.addEventListener('input',()=>{if(!composing)filter()});
document.getElementById('clear').onclick=()=>{input.value='';filter();input.focus()};
const collapsedEntry=document.getElementById('collapsed');if(collapsedEntry)collapsedEntry.onclick=()=>{collapsed=!collapsed;input.value='';filter();save();};
results.onclick=event=>{const row=event.target.closest('.row');if(!row)return;selected=row.dataset.key;const action=event.target.closest('[data-action]')?.dataset.action;if(action)send(action,selected);else openChat(selected)};
document.addEventListener('keydown',event=>{
 if(composing||event.isComposing)return;
 if((event.ctrlKey||event.metaKey)&&event.key==='f'){event.preventDefault();input.focus();input.select();return;}
 if(event.key==='Escape'){event.preventDefault();input.value='';filter();input.focus();return;}
 const items=[...results.children];let index=items.findIndex(row=>row.dataset.key===selected);
 if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();index=document.activeElement===input?(event.key==='ArrowDown'?0:items.length-1):Math.max(0,Math.min(items.length-1,index+(event.key==='ArrowDown'?1:-1)));const row=items[index];if(row){selected=row.dataset.key;render();[...results.children][index].focus();}return;}
 if(event.key==='Enter'&&selected&&document.activeElement.tagName!=='BUTTON'){event.preventDefault();openChat(selected);}
});
window.addEventListener('message',({data})=>{if(data.type==='rows'){const changed=active!==data.active||account!==data.account;rows=data.rows;account=data.account;active=data.active||'';if(changed&&active)selected=active;render();if(changed||data.revealActive)revealActive()}else if(data.type==='active'){if(data.account!==account)return;active=data.key;if(active)selected=active;render();revealActive()}else if(data.type==='filter'||(data.type==='initialFilter'&&!touched)){input.value=data.query;save();render()}else if(data.type==='focus'){input.focus();input.select();vscode.postMessage({type:'focused'})}});
vscode.postMessage({type:'ready'});
</script></body></html>`;
  }
  dispose(): void { this.subscriptions.forEach(d => d.dispose()); }
}
