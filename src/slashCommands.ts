import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import * as os from 'node:os';
import { ChatStore } from './store';
import { OneBotClient, OneBotRequestError } from './onebot';
import { AccountSession } from './accountSession';
import { Transcript } from './transcript';
import { Chat, inline, messageText } from './model';
import { downloadFile } from './download';
import { RequestInbox } from './requestInbox';
import { SlashCommand, SlashContext, SlashField, availableSlashCommands, executeSlashApi, slashCommands, validateSlashField } from './slashCatalog';

interface SlashHost {
  store?: ChatStore; target?: string; client: OneBotClient; session: AccountSession;
  transcript?: Transcript; ready: boolean;
  loadMembers(key: string): Promise<void>;
}
export interface SlashInvocation { uri: string; account: string; generation: number; }
export class SlashCommands implements vscode.Disposable {
  readonly requests = new RequestInbox();
  private results = new Map<string, string>();
  private sensitive = new Set<string>();
  private changed = new vscode.EventEmitter<vscode.Uri>();
  private subscriptions: vscode.Disposable[];
  constructor(private host: SlashHost) {
    this.subscriptions = [this.changed, vscode.workspace.registerTextDocumentContentProvider('qq-result', {
      onDidChange: this.changed.event,
      provideTextDocumentContent: uri => this.results.get(uri.toString()) ?? '// 查询结果已关闭或账号已切换，请重新运行指令。'
    }), vscode.workspace.onDidCloseTextDocument(doc => { if (doc.uri.scheme === 'qq-result') { this.results.delete(doc.uri.toString()); this.sensitive.delete(doc.uri.toString()); } })];
  }
  capture(uri: vscode.Uri): SlashInvocation | undefined {
    return this.host.store && this.host.transcript?.key(uri) ? { uri: uri.toString(), account: this.host.store.selfId, generation: this.host.session.generation } : undefined;
  }
  clearResults(all = false): void {
    for (const key of all ? this.results.keys() : this.sensitive) { this.results.delete(key); this.changed.fire(vscode.Uri.parse(key)); }
    this.sensitive.clear();
  }
  async run(name?: string, invocation?: SlashInvocation): Promise<void> {
    const store = this.host.store, token = this.host.session.capture();
    const active = vscode.window.activeTextEditor;
    const uri = invocation?.uri ? vscode.Uri.parse(invocation.uri) : active?.document.uri;
    const key = uri && this.host.transcript?.key(uri) || (!invocation ? this.host.target : undefined);
    const chat = key && store?.chats.get(key);
    if (!store || !chat || (invocation && (invocation.account !== store.selfId || invocation.generation !== token.generation || active?.document.uri.toString() !== invocation.uri))) throw new Error('会话或连接已变化，请在聊天草稿中重新选择指令');
    const check = () => { if (!token.current() || this.host.store !== store || !store.chats.has(chat.key)) throw new Error('账号或连接已变化，操作已停止，请重新选择指令'); };
    if (!name || name === 'help') {
      return this.host.session.run(JSON.stringify(['slash-menu', chat.key]), async () => {
        const chosen = await vscode.window.showQuickPick(availableSlashCommands(chat.type).filter(c => c.name !== 'help').map(c => ({ label: '/' + c.name, description: c.description, detail: c.category, value: c.name })), { title: `QQ 指令 · ${chat.name}`, placeHolder: '输入英文指令或中文说明搜索', matchOnDescription: true, matchOnDetail: true });
        check(); if (chosen) await this.run(chosen.value, invocation); return;
      });
    }
    const command = slashCommands.find(c => c.name === name && (!c.scope || c.scope === chat.type));
    if (!command) throw new Error('当前会话没有此指令：/' + name);
    return this.host.session.run(JSON.stringify(['slash', name === 'requests' ? store.selfId : chat.key, name]), async () => {
      const context: SlashContext = { key: chat.key, id: chat.id, type: chat.type, name: chat.name, selfId: store.selfId };
      let requested = false;
      const online = () => { check(); if (!this.host.ready || !this.host.client.connected) throw new Error('请先连接 OneBot 服务，再使用 /' + name); };
      const call = async (action: string, params: Record<string, unknown>) => {
        online();
        const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `QQ · ${command.description}`, cancellable: false }, () => { online(); requested = true; return this.host.client.call(action, params); });
        check(); return result;
      };
      try {
        check(); this.host.target = chat.key;
        if (command.local) {
          const args = command.local === 'qq.emojis' ? [{ autoClose: true }] : ['qq.toggleFavorite', 'qq.toggleCollapsed', 'qq.markRead', 'qq.toggleIgnoreUnread'].includes(command.local) ? [chat.key] : [];
          await vscode.commands.executeCommand(command.local, ...args); return;
        }
        if (command.special === 'reply') {
          const value = await this.askMessage(store, chat, check); check();
          if (value && uri) await vscode.commands.executeCommand('qq.reply', uri.toString(), value); return;
        }
        online();
        if (command.special === 'requests') { await this.handleRequests(store, chat, check, call); return; }
        if (command.special === 'files') { await this.browseFiles(chat, check, call); return; }
        if (command.special === 'poke') {
          const target = chat.type === 'private' ? chat.id : await this.askUser(store, chat, check); check();
          if (target && await this.confirm(command, context, { user_id: target })) await call(chat.type === 'group' ? 'group_poke' : 'friend_poke', { ...(chat.type === 'group' ? { group_id: chat.id } : {}), user_id: target });
          return;
        }
        await executeSlashApi(command, context, {
          check: online,
          ask: field => field.kind === 'user' ? this.askUser(store, chat, check) : field.kind === 'message' ? this.askMessage(store, chat, check) : this.askField(field, name),
          confirm: (command, context, params) => this.confirm(command, context, params),
          call,
          result: async (command, result, params) => {
            if (command.mutation) {
              // Update local projections only after the backend confirms success.
              if (name === 'recall') store.recall(chat.key, String(params.message_id));
              if (['card', 'title', 'admin', 'unadmin', 'kick'].includes(name)) { this.host.session.memberLoaded.delete(chat.key); await this.host.loadMembers(chat.key); check(); }
              if (name === 'rename') store.upsert({ ...chat, name: String(params.group_name) });
              if (name === 'friend_remark') store.upsert({ ...chat, name: String(params.remark) || chat.nickname || chat.id, remark: String(params.remark) });
              if (name === 'group_remark') store.upsert({ ...chat, remark: String(params.remark) });
              void vscode.window.showInformationMessage(`QQ · ${command.description}：操作成功`);
            } else await this.showResult(command, result, check);
          }
        });
      } catch (error) {
        if (command.mutation && requested && error instanceof OneBotRequestError && error.kind !== 'rejected') throw new Error(`/${name} 结果未确认，请先在 QQ 检查操作是否生效，再决定是否重试。${error.message}`);
        throw error;
      }
    });
  }
  private async askField(field: SlashField, name: string): Promise<string | boolean | undefined> {
    if (field.kind === 'choice') return (await vscode.window.showQuickPick((field.choices ?? []).map(c => ({ label: c.label, value: c.value })), { title: `/${name} · ${field.label}`, placeHolder: `请选择${field.label}` }))?.value;
    return vscode.window.showInputBox({ title: `/${name} · ${field.label}`, prompt: `请输入${field.label}（按 Enter 确认，Esc 取消）`, value: field.initial, ignoreFocusOut: true, validateInput: value => validateSlashField(field, value) });
  }
  private async askUser(store: ChatStore, chat: Chat, check: () => void): Promise<string | undefined> {
    if (chat.type === 'group') await this.host.loadMembers(chat.key); check();
    const options = chat.type === 'group' ? [...store.members.get(chat.key)?.values() ?? []].map(m => ({ label: m.name, description: m.id, detail: m.nickname, value: m.id }))
      : [...store.chats.values()].filter(c => c.type === 'private').sort((a, b) => Number(b.key === chat.key) - Number(a.key === chat.key)).map(c => ({ label: c.name, description: c.id, detail: c.remark, value: c.id }));
    const chosen = await vscode.window.showQuickPick([...options, { label: '$(edit) 输入 QQ 号…', description: '手动输入指定用户的 QQ 号', value: '' }], { title: `选择用户 · ${chat.name}`, placeHolder: '按名称、备注或 QQ 号筛选，或选择手动输入', matchOnDescription: true, matchOnDetail: true });
    check(); if (!chosen) return;
    return chosen.value || await this.askField({ key: 'user_id', label: 'QQ 号', kind: 'user' }, 'user') as string | undefined;
  }
  private async askMessage(store: ChatStore, chat: Chat, check: () => void): Promise<string | undefined> {
    const options = [...store.displayMessages(chat.key)].filter(m => /^-?\d+$/.test(m.id) && Number(m.id) !== 0).reverse().map(m => ({ label: inline(messageText(m)).slice(0, 100) || '[空消息]', description: `${m.senderName} · ID: ${m.id}`, value: m.id }));
    const chosen = await vscode.window.showQuickPick([...options, { label: '$(edit) 输入消息 ID…', description: '手动输入指定消息的数字 ID', value: '' }], { title: `选择消息 · ${chat.name}`, placeHolder: '按消息正文、发送者或 ID 筛选，或选择手动输入', matchOnDescription: true });
    check(); if (!chosen) return;
    return chosen.value || await this.askField({ key: 'message_id', label: '消息 ID', kind: 'message' }, 'message') as string | undefined;
  }
  private async confirm(command: SlashCommand, context: SlashContext, params: Record<string, unknown>): Promise<boolean> {
    const labels: Record<string, string> = { user_id: 'QQ 号', message_id: '消息 ID', target: '转发目标', duration: '时长（秒）', enable: '启用', is_dismiss: '解散群聊' };
    const details = Object.entries(params).filter(([key]) => key !== 'group_id').map(([key, value]) => `${command.fields?.find(f => f.key === key)?.label ?? labels[key] ?? key}：${String(value)}`).join('；');
    const selected = await vscode.window.showQuickPick([
      { label: '确认', description: command.confirm ?? command.description, detail: details ? `参数：${details}` : undefined, value: true },
      { label: '取消', description: '放弃本次操作并返回草稿', value: false }
    ], { title: `确认操作 · /${command.name} · ${context.name} (${context.id})`, placeHolder: '请确认操作参数并选择是否执行（按 Esc 取消）', matchOnDescription: true, matchOnDetail: true });
    return selected?.value === true;
  }
  private async showResult(command: SlashCommand, data: unknown, check: () => void): Promise<void> {
    check();
    const uri = vscode.Uri.from({ scheme: 'qq-result', path: `/${randomUUID()}/${command.name}.jsonc` });
    this.results.set(uri.toString(), `// ${command.description}\n${JSON.stringify(data ?? null, null, 2)}`);
    if (command.sensitive) this.sensitive.add(uri.toString());
    if (this.results.size > 20) { const oldest = this.results.keys().next().value!; this.results.delete(oldest); this.sensitive.delete(oldest); this.changed.fire(vscode.Uri.parse(oldest)); }
    const doc = await vscode.workspace.openTextDocument(uri);
    check();
    await vscode.window.showTextDocument(doc, { preview: true });
  }
  private async handleRequests(store: ChatStore, chat: Chat, check: () => void, call: (action: string, params: Record<string, unknown>) => Promise<any>): Promise<void> {
    const requests = this.requests.entries(store.selfId);
    if (!requests.length) { void vscode.window.showInformationMessage('暂无待处理申请。此列表收集本次连接收到的申请；服务端群通知可用 /group_requests 查看。'); return; }
    const selected = await vscode.window.showQuickPick(requests.map(r => ({ label: `${r.type === 'friend' ? '好友申请' : r.subType === 'invite' ? '群邀请' : '入群申请'} · ${r.userId}`, description: r.groupId ? `群 ${r.groupId}` : '', detail: r.comment, value: r })), { title: '处理申请', matchOnDescription: true, matchOnDetail: true });
    check(); if (!selected) return;
    const request = selected.value;
    const choice = await vscode.window.showQuickPick([{ label: '同意', value: true }, { label: '拒绝', value: false }], { title: selected.label });
    check(); if (!choice) return;
    const field = request.type === 'friend' ? 'remark' : 'reason';
    const content = await this.askField(textField(field, field === 'remark' ? '好友备注（可留空）' : '拒绝理由（可留空）'), 'requests');
    check(); if (content === undefined) return;
    if (!await this.confirm({ name: 'requests', category: '申请', description: `${choice.label} ${selected.label} · ${request.comment}` }, { key: chat.key, type: request.type === 'group' ? 'group' : 'private', id: request.groupId ?? request.userId, name: request.type === 'group' ? '群申请 / 邀请' : '好友申请', selfId: store.selfId }, { user_id: request.userId, [field === 'remark' ? '好友备注' : '拒绝理由']: content })) return;
    const params = { flag: request.flag, approve: choice.value, ...(request.type === 'friend' ? { remark: content } : { sub_type: request.subType, reason: content }) };
    await call(request.type === 'friend' ? 'set_friend_add_request' : 'set_group_add_request', params);
    this.requests.remove(store.selfId, request.key);
    void vscode.window.showInformationMessage('QQ · 申请已处理');
  }
  private async browseFiles(chat: Chat, check: () => void, call: (action: string, params: Record<string, unknown>) => Promise<any>): Promise<void> {
    let folder: { id: string; name: string } | undefined;
    while (true) {
      const data = await call(folder ? 'get_group_files_by_folder' : 'get_group_root_files', { group_id: chat.id, file_count: 200, ...(folder ? { folder_id: folder.id } : {}) });
      const options: { label: string; description?: string; file?: any; folder?: { id: string; name: string }; back?: boolean }[] = [];
      if (folder) options.push({ label: '$(arrow-left) 返回根目录', back: true });
      for (const item of data?.folders ?? []) if (item.folder_id) options.push({ label: '$(folder) ' + inline(item.folder_name), folder: { id: String(item.folder_id), name: inline(item.folder_name) } });
      for (const item of data?.files ?? []) if (item.file_id) options.push({ label: '$(file) ' + inline(item.file_name), description: `${((Number(item.file_size ?? item.size) || 0) / 1048576).toFixed(2)} MB`, file: item });
      if (!options.length) { void vscode.window.showInformationMessage('此群文件目录为空'); return; }
      const selected = await vscode.window.showQuickPick(options, { title: `群文件 · ${chat.name}${folder ? ' / ' + folder.name : ''}`, placeHolder: '选择文件下载，或进入文件夹；Esc 关闭' });
      check(); if (!selected) return;
      if (selected.back) { folder = undefined; continue; }
      if (selected.folder) { folder = selected.folder; continue; }
      const file = selected.file;
      const save = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(os.homedir(), 'Downloads', inline(file.file_name).replace(/[\\/:*?"<>|]/g, '_') || 'QQ文件')), title: '保存群文件' });
      check(); if (!save) return;
      const dataUrl = await call('get_group_file_url', { group_id: chat.id, file_id: String(file.file_id), busid: file.busid });
      const url = dataUrl?.url ?? dataUrl?.file_url;
      if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) throw new Error('服务端未返回有效下载链接');
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `下载 ${inline(file.file_name)}`, cancellable: true }, async (_progress, cancellation) => {
        check();
        const controller = new AbortController(), changed = cancellation.onCancellationRequested(() => controller.abort());
        const session = this.host.session.capture();
        const stopped = () => controller.abort(); session.signal.addEventListener('abort', stopped, { once: true });
        if (session.signal.aborted || cancellation.isCancellationRequested) controller.abort();
        try { await downloadFile(url, save.fsPath, controller.signal); } finally { changed.dispose(); session.signal.removeEventListener('abort', stopped); }
      });
      check(); void vscode.window.showInformationMessage('QQ · 群文件已保存'); return;
    }
  }
  dispose(): void { this.clearResults(true); this.requests.clear(); this.subscriptions.forEach(d => d.dispose()); }
}
const textField = (key: string, label: string): SlashField => ({ key, label, allowEmpty: true });
