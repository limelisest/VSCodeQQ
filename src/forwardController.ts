import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { ChatStore } from './store';
import { Transcript } from './transcript';
import { AccountSession } from './accountSession';
import { OneBotClient, OneBotRequestError } from './onebot';
import { Message, inline, messageText, parseMessage } from './model';
import { Rendered, renderTranscript } from './transcriptRenderer';
import { configuredCodeLanguage } from './configuration';
import { imagePreviewMarkup } from './imageHover';
import { deliverForward } from './forwardDelivery';
import { parseForwardMessages } from './forwardMessages';
interface Host { store?: ChatStore; transcript?: Transcript; target?: string; session: AccountSession; client: OneBotClient; ready: boolean; }
interface Page { messages: Message[]; rendered: Rendered; key: string; account: string; }
export class ForwardController implements vscode.Disposable {
  private pages = new Map<string, Page>();
  private changed = new vscode.EventEmitter<vscode.Uri>();
  private disposables: vscode.Disposable[];
  private forwarding = false;
  private output = vscode.window.createOutputChannel('QQ 转发诊断');
  constructor(private host: Host) {
    const selector = { scheme: 'qq-forward' };
    this.disposables = [this.changed, this.output,
      vscode.workspace.registerTextDocumentContentProvider('qq-forward', { onDidChange: this.changed.event, provideTextDocumentContent: uri => this.page(uri)?.rendered.text ?? '// 内容已关闭或连接已变化，请重新打开。' }),
      vscode.workspace.onDidCloseTextDocument(doc => this.pages.delete(doc.uri.toString())),
      vscode.languages.registerDocumentLinkProvider(selector, { provideDocumentLinks: doc => {
        const page = this.page(doc.uri); if (!page) return [];
        return [...page.rendered.forwards.map(s => this.link(doc.uri, s, 'qq.openForward', s.forwardIndex, '查看嵌套合并转发')),
          ...page.rendered.images.map(s => this.link(doc.uri, s, 'qq.openForwardImage', s.imageIndex, '打开图片'))];
      } }),
      vscode.languages.registerHoverProvider(selector, { provideHover: async (doc, pos, token) => {
        const page = this.page(doc.uri), span = page?.rendered.images.find(s => s.line === pos.line && pos.character >= s.start && pos.character < s.end);
        if (!span) return;
        const md = new vscode.MarkdownString();
        try {
          const file = await this.image(doc.uri, span.messageId, span.imageIndex);
          if (token.isCancellationRequested || !this.page(doc.uri)) return;
          md.supportHtml = true; md.appendMarkdown(imagePreviewMarkup(file, await fs.readFile(file), doc));
        } catch (error) { md.appendText(error instanceof Error ? error.message : '图片加载失败'); }
        return new vscode.Hover(md);
      } })];
  }
  private page(uri: vscode.Uri): Page | undefined {
    const page = this.pages.get(uri.toString());
    return page?.account === this.host.store?.selfId ? page : undefined;
  }
  private link(uri: vscode.Uri, s: { line: number; start: number; end: number; messageId: string }, command: string, index: number, tooltip: string): vscode.DocumentLink {
    const link = new vscode.DocumentLink(new vscode.Range(s.line, s.start, s.line, s.end), vscode.Uri.parse(`command:${command}?${encodeURIComponent(JSON.stringify([uri.toString(), s.messageId, index]))}`));
    link.tooltip = tooltip; return link;
  }
  private context(source?: string) {
    const store = this.host.store, token = this.host.session.capture();
    const editor = vscode.window.activeTextEditor;
    const uri = source ? vscode.Uri.parse(source) : editor?.document.uri;
    const key = uri && (this.host.transcript?.key(uri) ?? this.page(uri)?.key) || (!source ? this.host.target : undefined);
    const chat = key && store?.chats.get(key);
    if (!store || !chat) throw new Error('请先打开当前账号的聊天会话');
    const check = () => { if (store !== this.host.store || !token.current() || !this.host.ready || !this.host.client.connected) throw new Error('账号或连接已变化，请重新操作'); };
    check(); return { store, chat, uri, check };
  }
  private sourceMessages(uri: vscode.Uri): Message[] {
    const key = this.host.transcript?.key(uri);
    return key ? this.host.store?.messages.get(key) ?? [] : this.page(uri)?.messages ?? [];
  }
  private pickMessages<T extends vscode.QuickPickItem>(items: T[], multiple: boolean): Promise<readonly T[] | undefined> {
    return new Promise(resolve => {
      const picker = vscode.window.createQuickPick<T>();
      picker.title = multiple ? '选择合并转发消息（最多 100 条）' : '选择要转发的消息';
      picker.canSelectMany = multiple;
      picker.matchOnDescription = true;
      picker.items = items;
      if (multiple) picker.selectedItems = items.filter(item => item.picked);
      const accept = picker.onDidAccept(() => { resolve([...picker.selectedItems]); picker.hide(); });
      const hide = picker.onDidHide(() => { resolve(undefined); accept.dispose(); hide.dispose(); picker.dispose(); });
      picker.show();
      // Keep chronological order and start at the latest message, without selecting it.
      picker.activeItems = items.slice(-1);
    });
  }
  async forward(merged = false): Promise<void> {
    if (this.forwarding) return;
    this.forwarding = true;
    try {
      const { store, chat, check } = this.context();
      const editor = vscode.window.activeTextEditor;
      const current = editor && this.host.transcript?.messageAt(editor.document.uri, editor.selection.active.line);
      const candidates = store.displayMessages(chat.key).filter(m => /^-?\d+$/.test(m.id) && m.id !== '0' && !m.recalled && (!m.sendState || m.sendState === 'sent'));
      const options = candidates.map(m => ({ label: inline(messageText(m)).slice(0, 100) || '[空消息]', description: `${m.senderName} · ${m.id}`, value: m, picked: m.id === current?.id }));
      if (!options.length) { void vscode.window.showInformationMessage('当前会话没有可转发的消息'); return; }
      const selected = merged ? await this.pickMessages(options, true)
        : current && candidates.some(m => m.id === current.id) ? [options.find(o => o.value.id === current.id)!]
        : await this.pickMessages(options, false);
      check(); if (!selected?.length) return;
      const ids = new Set(selected.map(s => s.value.id));
      const messages = candidates.filter(m => ids.has(m.id)); // Preserve transcript order, not click order.
      if (messages.length > 100) throw new Error('一次最多合并转发 100 条消息');
      const target = await vscode.window.showQuickPick([...store.chats.values()].sort((a, b) => b.lastTime - a.lastTime || a.name.localeCompare(b.name, 'zh-CN')).map(c => ({ label: c.name, description: `${c.type === 'group' ? '群' : '好友'} ${c.id}`, value: c })), { title: '转发到哪个会话', matchOnDescription: true });
      check(); if (!target) return;
      const confirmed = await vscode.window.showQuickPick([{ label: '取消', value: false }, { label: '确认转发', value: true, detail: messages.map(m => `${m.senderName}：${inline(messageText(m)).slice(0, 80)}`).slice(0, 3).join('；') }], { title: `${merged ? '合并转发' : '转发'} ${messages.length} 条 → ${target.value.name} (${target.value.id})` });
      check(); if (!confirmed?.value) return;
      const latest = messages.map(m => store.messages.get(chat.key)?.find(value => value.id === m.id));
      if (latest.some(m => !m)) throw new Error('所选消息已不在当前记录中，请重新选择');
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '正在转发消息' }, () => {
        check();
        return deliverForward(this.host, target.value, latest as Message[], merged, error => this.output.appendLine(String(error)));
      });
      check(); void vscode.window.showInformationMessage(`已转发到 ${target.value.name}`);
    } finally { this.forwarding = false; }
  }
  async view(): Promise<void> {
    const { uri, check } = this.context();
    if (!uri) return;
    const options = this.sourceMessages(uri).flatMap(m => m.segments.filter(s => s.type === 'forward').map((s, index) => ({ label: `${m.senderName}：合并转发`, description: m.id, messageId: m.id, index })));
    const selected = await vscode.window.showQuickPick([...options, { label: '输入合并转发 ID…', description: '', messageId: '', index: 0 }], { title: '查看合并转发', matchOnDescription: true });
    check(); if (!selected) return;
    if (selected.messageId) return this.open(uri.toString(), selected.messageId, selected.index);
    const id = await vscode.window.showInputBox({ title: '合并转发 ID', ignoreFocusOut: true, validateInput: s => s.trim() ? undefined : '请输入合并转发 ID' });
    check(); if (id?.trim()) await this.load(uri.toString(), id.trim());
  }
  async open(source: string, messageId: string, index: number): Promise<void> {
    if (typeof source !== 'string' || typeof messageId !== 'string' || !Number.isInteger(index) || index < 0) return;
    const uri = vscode.Uri.parse(source), message = this.sourceMessages(uri).find(m => m.id === messageId);
    const segment = message?.segments.filter(s => s.type === 'forward')[index];
    if (!segment || segment.type !== 'forward' || (!segment.id && !segment.content)) throw new Error('合并转发 ID 缺失或消息已失效，请重新加载历史');
    await this.load(source, segment.id, segment.content, messageId, index);
  }
  private async load(source: string, id: string, content?: unknown[], messageId?: string, index = 0): Promise<void> {
    const { store, chat, check } = this.context(source);
    const data = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '正在读取合并转发' }, async () => {
      this.output.appendLine(`[${new Date().toISOString()}] 读取合并转发：ID类型=${/^-?\d+$/.test(id) ? '数字' : '资源ID'}，内嵌条数=${content?.length ?? '无'}，来源=${vscode.Uri.parse(source).scheme}`);
      if (content) return { messages: content };
      try { return await this.host.client.call('get_forward_msg', { message_id: id }); }
      catch (error) {
        this.output.appendLine(`初次查询失败：${error instanceof Error ? error.message : String(error)}`);
        check();
        // Numeric IDs of nested nodes cannot be queried by NapCat. Only refresh real chat messages.
        if (!(error instanceof OneBotRequestError) || error.kind !== 'rejected' || !messageId || !/^-?\d+$/.test(messageId)) throw error;
        this.output.appendLine('尝试刷新原消息 get_msg');
        const raw = await this.host.client.call('get_msg', { message_id: messageId });
        check();
        const refreshed = parseMessage(raw, chat.key).segments.filter(s => s.type === 'forward')[index];
        this.output.appendLine(`刷新结果：转发段=${refreshed?.type === 'forward'}，内嵌条数=${refreshed?.type === 'forward' ? refreshed.content?.length ?? '无' : '无'}，ID变化=${refreshed?.type === 'forward' && refreshed.id !== id}`);
        if (refreshed?.type !== 'forward') throw error;
        if (refreshed.content) return { messages: refreshed.content };
        const alternatives = [...new Set([
          ...(refreshed.id && refreshed.id !== id ? [refreshed.id] : []),
          // NapCat can resolve a top-level forward through the original message's
          // cached peer/history even when its resource-ID protocol fallback fails.
          ...(index === 0 && messageId !== id ? [messageId] : [])
        ])];
        let lastError: unknown = error;
        for (const candidate of alternatives) {
          check();
          const route = candidate === messageId ? '原消息 ID' : '刷新后的资源 ID';
          this.output.appendLine(`尝试通过${route}读取 get_forward_msg`);
          try {
            const result = await this.host.client.call('get_forward_msg', { message_id: candidate });
            check();
            this.output.appendLine(`${route}读取成功`);
            return result;
          } catch (nextError) {
            this.output.appendLine(`${route}读取失败：${nextError instanceof Error ? nextError.message : String(nextError)}`);
            if (!(nextError instanceof OneBotRequestError) || nextError.kind !== 'rejected') throw nextError;
            lastError = nextError;
          }
        }
        throw lastError;
      }
    }).then(undefined, (error: unknown) => {
      this.output.appendLine(`读取结束：${error instanceof Error ? error.message : String(error)}`);
      if (error instanceof OneBotRequestError && error.kind === 'rejected') {
        throw new Error('NapCat 无法读取这条合并转发。请在 QQ 中查看；错误详情见“输出 → QQ 转发诊断”。');
      }
      throw error;
    });
    check();
    const messages = parseForwardMessages(data, chat.key);
    const rendered = renderTranscript({ ...chat, name: `合并转发 · ${chat.name}` }, messages, store.selfId, configuredCodeLanguage());
    rendered.text = rendered.text.replace('底部草稿 Enter 发送 · Shift/Ctrl+Enter 换行 · 右键回复 · 图片悬浮预览', '只读合并转发 · 图片悬浮预览 · 链接打开图片或嵌套转发');
    const uri = vscode.Uri.from({ scheme: 'qq-forward', authority: store.selfId, path: `/${randomUUID()}/合并转发.qqchat` });
    this.pages.set(uri.toString(), { messages, rendered, key: chat.key, account: store.selfId });
    if (this.pages.size > 20) { const oldest = this.pages.keys().next().value!; this.pages.delete(oldest); this.changed.fire(vscode.Uri.parse(oldest)); }
    const doc = await vscode.workspace.openTextDocument(uri); check();
    await vscode.window.showTextDocument(doc, { preview: false });
  }
  private async image(uri: vscode.Uri, messageId: string, index: number): Promise<string> {
    this.context(uri.toString());
    const segment = this.page(uri)?.messages.find(m => m.id === messageId)?.segments.filter(s => s.type === 'image')[index];
    if (!segment || segment.type !== 'image') throw new Error('图片已失效');
    return this.host.transcript!.media.get(segment.image);
  }
  async openImage(source: string, messageId: string, index: number): Promise<void> {
    if (typeof source !== 'string' || typeof messageId !== 'string' || !Number.isInteger(index) || index < 0) return;
    const { check } = this.context(source);
    const file = await this.image(vscode.Uri.parse(source), messageId, index); check();
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(file));
  }
  clear(): void { for (const uri of this.pages.keys()) { this.pages.delete(uri); this.changed.fire(vscode.Uri.parse(uri)); } }
  dispose(): void { this.clear(); this.disposables.forEach(d => d.dispose()); }
}
