import { languageLabels } from './settingsSchema';
import { AttachmentImporter } from './attachmentImporter';
import * as vscode from 'vscode';
import * as path from 'node:path';
import * as os from 'node:os';
import { OneBotClient } from './onebot';
import { ChatStore, StoreChange } from './store';
import { MediaCache } from './media';
import { Transcript } from './transcript';
import { ChatTree, Section } from './tree';
import { ChatListView } from './chatListView';
import { HistoryQueue } from './historyQueue';
import { ChatTabs } from './chatTabs';
import { EmojiPicker } from './emojiPicker';
import { EmojiCompletion } from './emojiCompletion';
import { ForwardController } from './forwardController';
import { fileTransferNotice } from './fileNotices';
import { SlashCommands, SlashInvocation } from './slashCommands';
import { availableSlashCommands, exactSlashCommand } from './slashCatalog';
import { boundReplies, outgoingReply } from './replies';
import { Configuration } from './configuration';
import { SettingsTree } from './settingsTree';
import { codeLanguages } from './codeStyle';
import { ConnectionSettings } from './settings';
import { AttachmentFiles } from './attachments';
import { downloadFile } from './download';
import { OutboxService, Submission } from './outbox';
import { AccountSession } from './accountSession';
import { NotificationSync, allowsUnread, allowsMessageNotification } from './notifications';
import { ChatEditorController } from './chatEditorController';
import { Attachment, Chat, Message, id, messageText, newChat, parseMessage, splitKey } from './model';

export class QQApp implements vscode.Disposable {
  readonly client = new OneBotClient();
  readonly config: Configuration;
  readonly settings: ConnectionSettings;
  readonly emojis: EmojiPicker;
  readonly emojiCompletion: EmojiCompletion;
  readonly slash: SlashCommands;
  readonly forwards: ForwardController;
  readonly imports = new AttachmentImporter(this);
  readonly editor: ChatEditorController;
  get native() { return this.editor.native; }
  readonly trees: ChatTree[] = [];
  private historyClickTimer?: NodeJS.Timeout;
  private lastMentionClick?: { uri: string; qq: string; time: number };
  private listViews = new Map<Section, ChatListView>();
  private historyQueue = new HistoryQueue();
  private historyLoaded = new Map<string, number>();
  private historyRequests = new Map<string, { reconnect: boolean; since: number }>();
  private tabs: ChatTabs;
  notifications?: NotificationSync;
  private notificationTimer?: NodeJS.Timeout;
  store?: ChatStore;
  transcript?: Transcript;
  attachments?: AttachmentFiles;
  target?: string;
  ready = false;
  private disposables: vscode.Disposable[] = [];
  private output = vscode.window.createOutputChannel('QQ');
  private status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
  private initializationRetry?: NodeJS.Timeout;
  private cacheTimer?: NodeJS.Timeout;
  private cleaningCache?: Promise<number>;
  readonly settingsTree = new SettingsTree(() => this.client.connected);
  private importingMessageImages = new Set<string>();
  private submitting = new Set<string>();
  private tabChanges = new vscode.EventEmitter<vscode.Uri | undefined>();
  private queued: any[] = [];
  readonly session = new AccountSession();
  readonly outbox: OutboxService;
  private get epoch() { return this.session.generation; }
  private openVersion = 0;
  private initialization: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(readonly context: vscode.ExtensionContext) {
    this.config = new Configuration(context);
    this.tabs = new ChatTabs(this, error => this.log(error));
    this.disposables.push(this.tabs);
    const app = this;
    this.outbox = new OutboxService({
      get store() { return app.store; }, get attachments() { return app.attachments; },
      client: this.client, session: this.session, get ready() { return app.ready; }, log: error => this.log(error)
    });
    this.editor = new ChatEditorController(this);
    this.forwards = new ForwardController(this);
    this.disposables.push(this.forwards);
    this.slash = new SlashCommands(this);
    this.disposables.push(this.editor, this.slash);
    this.disposables.push(vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('qq')) {
        this.settingsTree.refresh();
        if (e.affectsConfiguration('qq.mentionColor') || e.affectsConfiguration('qq.replyColor')) this.editor.refreshHighlights();
        if (this.store) this.store.limit = this.config.messageLimit;
        for (const editor of vscode.window.visibleTextEditors) this.editor.decorate(editor);
      }
    }));
    this.settings = new ConnectionSettings(context, this.config, () => this.connect(), () => this.cacheInfo(), () => this.cleanCache(true));
    this.disposables.push(this.settings);
    this.emojis = new EmojiPicker(context, this);
    this.emojiCompletion = new EmojiCompletion(this);
    this.status.command = 'qq.connect'; this.status.name = 'QQ 连接'; this.status.show();
    this.disposables.push(this.tabChanges, vscode.window.registerFileDecorationProvider({
      onDidChangeFileDecorations: this.tabChanges.event,
      provideFileDecoration: uri => this.tabDecoration(uri)
    }));
    this.disposables.push(this.output, this.status);
    const selector = { scheme: 'qqchat', language: 'qq-chat' };
    this.disposables.push(vscode.languages.registerCompletionItemProvider(selector, this.emojiCompletion, '!', '！'));
    this.disposables.push(vscode.languages.registerCompletionItemProvider(selector, {
      provideCompletionItems: async (doc, position, token) => {
        const region = this.native.region(doc);
        if (!region || doc.offsetAt(position) < region.start) return [];
        const before = doc.lineAt(position.line).text.slice(0, position.character);
        const match = /(?:^|\s)(\/[a-z0-9_]*)$/i.exec(before);
        if (!match) {
          const at = /(?:^|[^A-Za-z0-9_])@([^\s@\[\]]*)$/.exec(before);
          const key = this.transcript?.key(doc.uri);
          if (!at || !key?.startsWith('group:')) return [];
          const store = this.store;
          await this.loadMembers(key);
          if (token.isCancellationRequested || store !== this.store) return [];
          const range = new vscode.Range(position.line, before.lastIndexOf('@'), position.line, position.character);
          return [...this.store?.members.get(key)?.values() ?? []].filter(m => `${m.name} ${m.nickname} ${m.id}`.toLowerCase().includes(at[1].toLowerCase())).map(m => {
            const item = new vscode.CompletionItem(m.name, vscode.CompletionItemKind.User);
            item.filterText = `@${m.name} ${m.nickname ?? ''} ${m.id}`; item.detail = `${m.nickname ?? ''} · ${m.id}`; item.range = range; item.insertText = `${store!.reserveMention(key, m.id, m.name)} `; return item;
          });
        }
        const range = new vscode.Range(position.translate(0, -match[1].length), position);
        const key = this.transcript?.key(doc.uri), chat = key && this.store?.chats.get(key);
        const invocation = this.slash.capture(doc.uri);
        if (!chat || !invocation) return [];
        return availableSlashCommands(chat.type).map((command, index) => {
          const label = '/' + command.name;
          const item = new vscode.CompletionItem({ label, description: command.description }, vscode.CompletionItemKind.Function);
          item.detail = command.description;
          item.documentation = new vscode.MarkdownString(`${command.category} · ${command.description}\n\n选择后打开操作或参数选择框，Esc 取消。`);
          item.range = range; item.insertText = ''; item.filterText = label; item.sortText = String(index).padStart(3, '0');
          item.command = { command: 'qq.slash', title: label, arguments: [command.name, invocation] };
          return item;
        });
      }
    }, '/', '@'));
    this.disposables.push(vscode.languages.registerDocumentLinkProvider(selector, {
      provideDocumentLinks: doc => [...(this.native.historyMatches(doc) ? this.transcript?.provideDocumentLinks(doc) ?? [] : []), ...this.native.links(doc)]
    }), vscode.languages.registerHoverProvider(selector, {
      provideHover: async (doc, pos, token) => await this.native.hover(doc, pos) ?? (this.native.historyMatches(doc) ? this.transcript?.provideHover(doc, pos, token) : undefined)
    }), vscode.window.registerWebviewViewProvider('qq.composer', this.emojis),
    vscode.languages.registerDocumentPasteEditProvider(selector, {
      provideDocumentPasteEdits: (doc, ranges, data, _context, token) => this.native.paste(doc, ranges, data, token)
    }, { pasteMimeTypes: ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp'], providedPasteEditKinds: [vscode.DocumentDropOrPasteEditKind.Empty.append('qq', 'image')] }));
    this.disposables.push(vscode.languages.registerDocumentDropEditProvider(selector, {
      provideDocumentDropEdits: async (doc, position, data, token) => {
        try { return await this.native.drop(doc, position, data, token); }
        catch (error: any) { void vscode.window.showErrorMessage(`QQ 文件导入失败：${error.message}`); return new vscode.DocumentDropEdit('', '文件未导入', vscode.DocumentDropOrPasteEditKind.Empty.append('qq', 'file')); }
      }
    }, { dropMimeTypes: ['text/uri-list', 'files'], providedDropEditKinds: [vscode.DocumentDropOrPasteEditKind.Empty.append('qq', 'file')] }));
    for (const section of ['list'] as Section[]) {
      const provider = new ChatTree(section, () => this.store); this.trees.push(provider);
      const view = new ChatListView(provider, () => this.store, query => this.filterList(section, query, false), this.context.extensionUri);
      this.listViews.set(section, view);
      this.disposables.push(provider, view, vscode.window.registerWebviewViewProvider(`qq.${section}`, view));
    }
    this.disposables.push(this.settingsTree, vscode.window.createTreeView('qq.settings', { treeDataProvider: this.settingsTree, showCollapseAll: false }));
    this.commands();
    this.disposables.push(vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('qq.codeLanguage')) {
        for (const key of this.store?.chats.keys() ?? []) this.native.schedule(key, true);
      }
    }));
    this.disposables.push(vscode.window.onDidChangeActiveTextEditor(editor => {
      this.native.updateContext();
      const key = editor && this.transcript?.key(editor.document.uri);
      if (key) { this.target = key; this.emojis.update(); this.editor.decorate(editor!); this.checkRead(); void this.ensureChatLoaded(key, 0); }
    }), vscode.window.onDidChangeWindowState(() => this.checkRead()),
    vscode.window.onDidChangeTextEditorSelection(event => {
      this.native.updateContext();
      clearTimeout(this.historyClickTimer);
      if (event.kind === vscode.TextEditorSelectionChangeKind.Mouse && event.selections.length === 1 && event.selections[0].isEmpty && this.native.historyMatches(event.textEditor.document)) {
        const editor = event.textEditor, position = event.selections[0].active, version = editor.document.version;
        const command = this.transcript?.clickCommand(editor.document, position);
        if (command) this.historyClickTimer = setTimeout(() => {
          // A drag or double click produces a non-empty selection. Let it settle
          // before moving focus to the draft so copying history still works.
          if (this.stopped || vscode.window.activeTextEditor !== editor || editor.document.version !== version || !editor.selection.isEmpty || !editor.selection.active.isEqual(position) || !this.native.historyMatches(editor.document)) return;
          const args = JSON.parse(decodeURIComponent(command.query));
          void vscode.commands.executeCommand(command.path, ...args).then(undefined, error => this.log(error));
        }, 250);
      }
      if (event.kind === vscode.TextEditorSelectionChangeKind.Keyboard || event.kind === vscode.TextEditorSelectionChangeKind.Mouse) this.checkRead();
    }));
    this.disposables.push(vscode.window.tabGroups.onDidChangeTabs(event => {
      this.tabs.refresh();
      for (const tab of event.opened) if (tab.input instanceof vscode.TabInputText) {
        const key = this.transcript?.key(tab.input.uri); if (key) void this.ensureChatLoaded(key, tab.isActive ? 0 : 1);
      }
    }));
    this.client.on('connected', () => {
      const epoch = this.session.advance();
      this.historyQueue.clear(); this.historyLoaded.clear();
      clearTimeout(this.initializationRetry); this.ready = false;
      this.initialization = this.initializeWithRetry(epoch);
    });
    this.client.on('disconnected', () => {
      clearTimeout(this.initializationRetry);
      this.session.advance(); this.historyQueue.clear(); this.historyLoaded.clear(); this.ready = false; this.queued = [];
      this.slash.clearResults(); this.forwards.clear();
      this.notifications?.dispose(); clearInterval(this.notificationTimer); this.updateStatus('未连接');
    });
    this.client.on('event', event => {
      if (!this.ready) { if (this.queued.length < 1000) this.queued.push(event); return; }
      this.onEvent(event);
    });
    this.updateStatus('未连接');
  }
  async start(): Promise<void> {
    const account = this.context.globalState.get<string>('lastAccount');
    if (account && /^\d+$/.test(account)) await this.bindAccount(account);
    if (vscode.workspace.getConfiguration('qq').get('autoConnect', true)) void this.connect().catch(error => this.log(error));
  }
  async connect(): Promise<void> {
    this.updateStatus('连接中');
    await this.client.connect(this.config.url, await this.config.token());
    await this.initialization;
    if (!this.ready) throw new Error('NapCat 初始化未完成，请查看 QQ 输出日志');
  }
  private async initializeWithRetry(epoch: number, attempt = 0): Promise<void> {
    try { this.updateStatus('同步中'); await this.initialize(epoch); }
    catch (error) {
      if (epoch !== this.epoch || this.stopped) return;
      this.ready = false; this.log(error); this.updateStatus('初始化失败 · 等待重试');
      this.initializationRetry = setTimeout(() => {
        if (epoch === this.epoch && this.client.connected && !this.stopped) this.initialization = this.initializeWithRetry(epoch, attempt + 1);
      }, Math.min(30000, 1000 * 2 ** Math.min(attempt, 5)));
    }
  }
  private async initialize(epoch: number): Promise<void> {
    const info = await this.client.call('get_login_info');
    const selfId = id(info?.user_id);
    if (!/^\d+$/.test(selfId)) throw new Error('NapCat 没有返回有效的登录账号');
    if (epoch !== this.epoch || this.stopped) return;
    await this.bindAccount(selfId);
    if (epoch !== this.epoch || this.stopped) return;
    const syncSince = new Map([...this.store!.chats.values()].map(c => [c.key, c.lastTime]));
    this.ready = true;
    const queued = this.queued; this.queued = [];
    for (const event of queued) this.onEvent(event);
    // Restored conversations already have an identity; do not make their
    // history wait for every friend/group-list request to complete.
    void this.syncRecentHistory(epoch, syncSince).catch(error => this.log(error));
    await this.refresh();
    if (epoch !== this.epoch || this.stopped) return;
    this.updateStatus('已连接');
    clearInterval(this.notificationTimer);
    this.notificationTimer = setInterval(() => { if (this.ready) void this.notifications?.refresh(); }, 60000);
    void this.cleanCache().catch(error => this.log(error));
    clearInterval(this.cacheTimer); this.cacheTimer = setInterval(() => { void this.cleanCache().catch(error => this.log(error)); }, 3600000);
    this.output.appendLine('NapCat 连接成功，会话列表已加载。');
  }
  private openChatKeys(): string[] {
    const active = vscode.window.activeTextEditor;
    const uris = [...(active ? [active.document.uri] : []), ...vscode.window.visibleTextEditors.map(e => e.document.uri),
      ...vscode.window.tabGroups.all.flatMap(group => group.tabs.flatMap(tab => tab.input instanceof vscode.TabInputText ? [tab.input.uri] : []))];
    return [...new Set(uris.map(uri => this.transcript?.key(uri)).filter((key): key is string => !!key))];
  }
  private async ensureChatLoaded(key: string, priority = 0): Promise<void> {
    const store = this.store; if (!store?.chats.has(key)) return;
    try {
      await store.load(key);
      if (store !== this.store) return;
      this.native.schedule(key, true);
      if (!this.ready) return;
      if (Date.now() - (this.historyLoaded.get(key) ?? 0) > 30000) await this.loadHistory(key, false, false, undefined, priority);
      if (store === this.store) void this.loadMembers(key);
    } catch (error) { this.log(error); }
  }
  private async syncRecentHistory(epoch: number, since: Map<string, number>): Promise<void> {
    const store = this.store; if (!store) return;
    const open = this.openChatKeys();
    const recent = [...store.chats.values()].filter(c => c.lastTime > 0).sort((a, b) => b.lastTime - a.lastTime).slice(0, 20).map(c => c.key);
    const current = () => epoch === this.epoch && store === this.store && this.ready;
    // Local caches and first pages of open tabs take priority over deep backfill.
    await Promise.allSettled(open.map(async (key, index) => {
      await store.load(key); if (!current()) return;
      this.native.schedule(key, true);
      await this.loadHistory(key, false, true, since.get(key) ?? 0, index === 0 ? 0 : 1, this.config.historyCount);
      if (current()) void this.loadMembers(key);
    }));
    if (!current()) return;
    await Promise.allSettled([...new Set([...open, ...recent])].map(key =>
      this.loadHistory(key, false, true, since.get(key) ?? 0, 2).catch(error => this.log(error))));
  }
  async cacheInfo(): Promise<{ bytes: number; count: number }> { return this.attachments?.cacheInfo() ?? { bytes: 0, count: 0 }; }
  async cleanCache(manual = false): Promise<number> {
    if (this.cleaningCache) return this.cleaningCache;
    const store = this.store, files = this.attachments; if (!store || !files) return 0;
    const task = (async () => {
      const references = await store.attachmentReferences();
      if (store !== this.store) return 0;
      return files.prune(references, manual ? 0 : vscode.workspace.getConfiguration('qq').get('cacheRetentionDays', 7));
    })();
    this.cleaningCache = task;
    try { return await task; } finally { if (this.cleaningCache === task) this.cleaningCache = undefined; }
  }
  private async bindAccount(selfId: string): Promise<void> {
    const token = this.session.capture();
    await this.session.bind(async () => {
      if (!token.current() || this.stopped || this.store?.selfId === selfId) return;
      if (this.store) {
        const oldStore = this.store; this.store = undefined;
        this.notifications?.dispose(); this.transcript?.dispose(); this.transcript = undefined;
        await oldStore.dispose();
      }
      if (!token.current() || this.stopped) return;
      this.slash.requests.clear(); this.slash.clearResults(true); this.forwards.clear();
      this.session.clearAccount(); this.historyLoaded.clear(); this.historyQueue.clear();
      this.target = undefined; this.editor.reset();
      const folder = path.join(this.context.globalStorageUri.fsPath, 'accounts', selfId);
      const store = new ChatStore(folder, selfId, this.config.messageLimit);
      store.on('storageError', error => this.log(error));
      await store.restore();
      if (!token.current() || this.stopped) { await store.dispose(); return; }
      this.store = store;
      this.attachments = new AttachmentFiles(path.join(folder, 'outgoing'));
      const transcript = new Transcript(store, new MediaCache(path.join(folder, 'images'), this.client), this.attachments);
      this.transcript = transcript;
      store.on('change', (key: string, kind: StoreChange) => {
        if (store !== this.store) return;
        if (kind === 'messages' || kind === 'members' || kind === 'chat') this.native.schedule(key, true);
        if (kind !== 'members') {
          this.trees.forEach(tree => tree.refresh());
          const chat = store.chats.get(key); if (chat) this.tabChanges.fire(transcript.uri(chat));
          this.tabs.refresh();
        }
      });
      store.on('draft', (key, replyChanged) => { this.native.schedule(key, !!replyChanged); this.emojis.update(); });
      await this.context.globalState.update('lastAccount', selfId);
      this.trees.forEach(tree => tree.refresh()); this.emojis.update(); this.tabs.refresh();
      for (const key of this.openChatKeys()) void this.ensureChatLoaded(key, 1);
    });
  }
  async refresh(): Promise<void> {
    if (!this.client.connected || !this.store) throw new Error('请先连接 NapCat');
    const store = this.store, epoch = this.epoch;
    const [friends, groups] = await Promise.all([this.client.call('get_friend_list'), this.client.call('get_group_list')]);
    if (store !== this.store || epoch !== this.epoch) return;
    for (const friend of Array.isArray(friends) ? friends : []) {
      if (/^\d+$/.test(id(friend.user_id))) store.upsert({ ...newChat('private', friend.user_id, friend.remark || friend.nickname), remark: friend.remark, nickname: friend.nickname });
    }
    for (const group of Array.isArray(groups) ? groups : []) {
      if (/^\d+$/.test(id(group.group_id))) store.upsert(newChat('group', group.group_id, group.group_name));
    }
    this.notifications?.dispose();
    for (const chat of store.chats.values()) if (chat.type === 'group') store.setNotification(chat.key, 'unknown');
    this.notifications = new NotificationSync(store, this.client);
    void this.notifications.refresh();
  }
  private onEvent(event: any): void {
    const store = this.store;
    if (!store || event.self_id && id(event.self_id) !== store.selfId) return;
    const transferNotice = fileTransferNotice(event, store.selfId);
    if (transferNotice) {
      if (!store.chats.has(transferNotice.chatKey)) store.upsert(newChat('private', event.peer_id, event.peer_id));
      store.add(transferNotice, false);
      this.editor.incoming(transferNotice.chatKey);
      return;
    }
    if (event.post_type === 'request') { this.slash.requests.add(event, store.selfId); return; }
    if (event.post_type === 'notice' && ['group_recall', 'friend_recall'].includes(event.notice_type)) {
      const key = event.notice_type === 'group_recall' ? `group:${id(event.group_id)}` : `private:${id(event.user_id)}`;
      if (store.chats.has(key)) store.recall(key, id(event.message_id));
      else if (id(event.user_id) === store.selfId) for (const chat of store.chats.values()) if (chat.type === 'private') store.recall(chat.key, id(event.message_id));
      return;
    }
    if (!['message', 'message_sent'].includes(event.post_type)) return;
    try {
      const message = parseMessage(event, undefined, store.selfId);
      if (!store.chats.has(message.chatKey)) {
        const key = splitKey(message.chatKey);
        store.upsert(newChat(key.type, key.id, key.type === 'private' ? message.senderName : key.id));
      }
      if (message.senderId === store.selfId && message.fileIds?.length) {
        const local = store.messages.get(message.chatKey)?.find(m => m.id.startsWith('local:') && m.fileIds?.some(f => message.fileIds!.includes(f)));
        if (local) { store.settleOutgoing(message.chatKey, local.id, { ...local, ...message }); return; }
      }
      const added = store.add(message, true);
      if (added && message.senderId !== store.selfId) void this.notifyMessage(store, message);
      if (added && message.senderId !== store.selfId) this.editor.incoming(message.chatKey);
      void this.notifications?.ensure(message.chatKey);
    } catch { this.output.appendLine('跳过一条无法识别的消息事件。'); }
  }
  tabDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const key = this.transcript?.key(uri), chat = key && this.store?.chats.get(key);
    if (!chat || !chat.unread || !allowsUnread(chat)) return;
    return {
      badge: chat.mentioned ? '@' : chat.replied ? '↩' : chat.unread > 99 ? '99' : String(chat.unread),
      tooltip: `${chat.unread} 条未读${chat.mentioned ? ' · 有人 @我' : ''}${chat.replied ? ' · 有人回复我' : ''}`,
      color: new vscode.ThemeColor(chat.mentioned || chat.replied ? 'list.warningForeground' : 'textLink.foreground')
    };
  }
  private async resolveReply(store: ChatStore, message: Message): Promise<boolean> {
    if (!message.replyId || message.senderId === store.selfId) return false;
    if (message.replyToSelf !== undefined) return message.replyToSelf;
    const target = store.messages.get(message.chatKey)?.find(m => m.id === message.replyId);
    const lookup = `${store.selfId}:${message.chatKey}:${message.replyId}`;
    let result: boolean;
    if (target) result = target.senderId === store.selfId;
    else {
      let task = this.session.replyLookups.get(lookup);
      if (!task) {
        task = this.client.call('get_msg', { message_id: message.replyId }, 5000).then(raw => {
          const sender = id(raw?.sender?.user_id ?? raw?.user_id); if (!sender) throw new Error('引用消息不可用');
          return sender === store.selfId;
        });
        this.session.replyLookups.set(lookup, task);
      }
      try { result = await task; } finally { if (this.session.replyLookups.get(lookup) === task) this.session.replyLookups.delete(lookup); }
    }
    if (store === this.store) {
      const current = store.messages.get(message.chatKey)?.find(m => m.id === message.id);
      if (current) store.enrichMessage({ ...current, replyToSelf: result });
    }
    return result;
  }
  private async notifyMessage(store: ChatStore, message: Message): Promise<void> {
    const key = message.chatKey;
    const replyToSelf = await this.resolveReply(store, message).catch(() => false);
    if (store === this.store && replyToSelf) store.markReplyToSelf(key);
    await this.notifications?.ensure(key);
    const chat = store.chats.get(key);
    if (store !== this.store || !chat?.unread || !allowsMessageNotification(chat, message.mentioned, replyToSelf)) return;
    if (!message.mentioned && !replyToSelf && this.isReading(key)) return;
    const mode = vscode.workspace.getConfiguration('qq').get<string>('notifications', 'all');
    if (mode === 'off' || (mode === 'mentions' && !message.mentioned && !replyToSelf)) return;
    const reason = message.mentioned ? '有人 @你' : replyToSelf ? '有人回复你' : '新消息';
    const choice = await vscode.window.showInformationMessage(`${chat.name} · ${reason}：${messageText(message).replace(/\s+/g, ' ').slice(0, 100)}`, '查看');
    if (choice === '查看' && store === this.store) await this.openChat(key);
  }
  async openChat(input: string | Chat): Promise<void> {
    const key = typeof input === 'string' ? input : input.key;
    const store = this.store, transcript = this.transcript;
    const chat = store?.chats.get(key);
    if (!chat || !store || !transcript) throw new Error('当前账号没有这个会话');
    const version = ++this.openVersion;
    await store.load(key);
    if (version !== this.openVersion || store !== this.store) return;
    const doc = await vscode.workspace.openTextDocument(transcript.uri(chat));
    await vscode.languages.setTextDocumentLanguage(doc, 'qq-chat');
    if (version !== this.openVersion || store !== this.store) return;
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    await this.native.sync(editor);
    this.target = key; this.editor.follow(editor, true);
    this.editor.latest(editor); this.editor.decorate(editor); this.emojis.update();
    await this.native.focus(editor);
    void this.ensureChatLoaded(key, 0); this.tabs.refresh();
    this.checkRead();
  }
  loadHistory(key: string, more = false, reconnect = false, reconnectSince?: number, priority = 0, pageCount?: number): Promise<void> {
    const store = this.store; if (!store || !this.ready) return Promise.resolve();
    if (more) for (const editor of vscode.window.visibleTextEditors) if (this.transcript?.key(editor.document.uri) === key) this.editor.follow(editor, false);
    const count = Math.min(store.limit, pageCount ?? (reconnect ? store.limit : more ? (this.session.historyCounts.get(key) ?? this.config.historyCount) + this.config.historyCount : this.config.historyCount));
    const epoch = this.epoch;
    const requestKey = `${epoch}:${key}:${count}`;
    let request = this.historyRequests.get(requestKey);
    if (!request) { request = { reconnect, since: reconnectSince ?? store.chats.get(key)?.lastTime ?? 0 }; this.historyRequests.set(requestKey, request); }
    else if (reconnect) { request.reconnect = true; if (reconnectSince !== undefined) request.since = Math.min(request.since, reconnectSince); }
    const options = request;
    const result = this.historyQueue.request(requestKey, priority, async () => {
      if (store !== this.store || epoch !== this.epoch || !this.ready) return;
      this.transcript?.historyState.set(key, '正在加载聊天记录…'); this.native.schedule(key, true);
      try {
        await this.fetchHistory(store, key, count, epoch, options);
        if (store === this.store && epoch === this.epoch) { this.historyLoaded.set(key, Date.now()); this.transcript?.historyState.delete(key); }
      } catch (error) {
        if (store === this.store && epoch === this.epoch) this.transcript?.historyState.set(key, '历史加载失败，请点击工具栏“加载更多记录”重试');
        throw error;
      } finally { if (store === this.store && epoch === this.epoch) this.native.schedule(key, true); }
    });
    return result.finally(() => { if (this.historyRequests.get(requestKey) === options) this.historyRequests.delete(requestKey); });
  }
  private async fetchHistory(store: ChatStore, key: string, count: number, epoch: number, options: { reconnect: boolean; since: number }): Promise<void> {
    const chat = splitKey(key);
    this.session.historyCounts.set(key, Math.max(count, this.session.historyCounts.get(key) ?? 0));
    const data = await this.client.call(chat.type === 'group' ? 'get_group_msg_history' : 'get_friend_msg_history', { [chat.type === 'group' ? 'group_id' : 'user_id']: chat.id, count }, 10000);
    if (store !== this.store || epoch !== this.epoch) return;
    const messages: Message[] = [];
    for (const raw of Array.isArray(data?.messages) ? data.messages : []) { try { messages.push(parseMessage(raw, key, store.selfId)); } catch {} }
    await store.load(key);
    if (store !== this.store || epoch !== this.epoch) return;
    const unreadReplies = new Set<string>();
    if (options.reconnect && options.since > 0) {
      for (const message of [...messages].sort((a, b) => a.time - b.time)) if (message.time >= options.since) {
        if (store.add(message, true) && message.senderId !== store.selfId && message.replyId) unreadReplies.add(message.id);
      }
    }
    store.history(key, messages);
    // Resolve missing originals in bounded batches; do not block editor opening.
    void (async () => {
      for (let i = 0; i < messages.length; i += 4) {
        if (store !== this.store || epoch !== this.epoch) return;
        await Promise.allSettled(messages.slice(i, i + 4).filter(m => m.replyId).map(async m => {
          const reply = await this.resolveReply(store, m);
          if (reply && unreadReplies.has(m.id) && store === this.store && epoch === this.epoch) store.markReplyToSelf(key);
        }));
      }
    })();
  }
  async loadMembers(key: string): Promise<void> {
    const store = this.store, epoch = this.epoch;
    if (!store || !key.startsWith('group:') || !this.client.connected) return;
    const lookup = `${epoch}:${key}`;
    const pending = this.session.memberLoading.get(lookup); if (pending) return pending;
    if (store.members.has(key) && Date.now() - (this.session.memberLoaded.get(key) ?? 0) < 300000) return;
    const task = (async () => {
      try {
        const members = await this.client.call('get_group_member_list', { group_id: splitKey(key).id }, 10000);
        if (store === this.store && epoch === this.epoch && Array.isArray(members)) {
          store.setMembers(key, members); this.session.memberLoaded.set(key, Date.now());
        }
      } catch { /* Keep cached members; the next completion retries. */ }
    })();
    this.session.memberLoading.set(lookup, task);
    try { await task; } finally { if (this.session.memberLoading.get(lookup) === task) this.session.memberLoading.delete(lookup); }
  }
  private async mentionMember(sender = false): Promise<void> {
    const editor = vscode.window.activeTextEditor, store = this.store;
    const key = editor && this.transcript?.key(editor.document.uri);
    if (!editor || !store || !key?.startsWith('group:')) throw new Error('请先打开群聊，再选择要 @ 的成员');
    let memberId: string | undefined, memberName: string | undefined;
    if (sender) {
      if (!this.native.historyMatches(editor.document)) throw new Error('请等待聊天记录更新后重试');
      const message = this.transcript?.messageAt(editor.document.uri, editor.selection.active.line);
      if (!message || !/^\d+$/.test(message.senderId)) throw new Error('请将光标放在要 @ 的群成员消息上');
      memberId = message.senderId; memberName = store.displayMessages(key).find(m => m.id === message.id)?.senderName || message.senderName;
    } else {
      await this.loadMembers(key);
      if (store !== this.store) return;
      const members = [...store.members.get(key)?.values() ?? []];
      if (!members.length) throw new Error('暂时无法读取群成员，请确认连接后重试');
      const selected = await vscode.window.showQuickPick(members.map(m => ({
        label: m.name, description: m.id, detail: m.nickname, memberId: m.id
      })), { title: '@ 群成员', placeHolder: '搜索群名片、昵称或 QQ 号', matchOnDescription: true, matchOnDetail: true });
      memberId = selected?.memberId; memberName = selected?.label;
    }
    if (!memberId || store !== this.store) return;
    await this.insertMention(editor.document.uri.toString(), memberId, memberName);
  }
  private async insertMention(uri: string, memberId: string, memberName?: string, fromLink = false): Promise<void> {
    const store = this.store, parsed = vscode.Uri.parse(uri), key = this.transcript?.key(parsed);
    if (!store || !key?.startsWith('group:') || !/^(?:\d+|all)$/.test(memberId)) return;
    const last = this.lastMentionClick, now = Date.now();
    if (fromLink && last?.uri === uri && last.qq === memberId && now - last.time < 300) return;
    if (fromLink) this.lastMentionClick = { uri, qq: memberId, time: now };
    const name = store.members.get(key)?.get(memberId)?.name || memberName || (memberId === 'all' ? '全体成员' : memberId);
    const text = `${store.reserveMention(key, memberId, name)} `;
    const editor = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === uri);
    if (!editor) { const draft = store.draft(key); store.setDraft(key, draft.text + text, draft.replyId); return; }
    if (vscode.window.activeTextEditor?.document !== editor.document) {
      const draft = store.draft(key); store.setDraft(key, draft.text + text, draft.replyId); return;
    }
    const active = vscode.window.activeTextEditor!;
    await this.native.sync(active, false);
    if (store !== this.store) return;
    if (vscode.window.activeTextEditor?.document !== active.document) {
      const draft = store.draft(key); store.setDraft(key, draft.text + text, draft.replyId); return;
    }
    const selection = this.native.inDraft(active) ? active.selection : new vscode.Selection(
      active.document.positionAt(active.document.getText().length), active.document.positionAt(active.document.getText().length));
    if (!await active.edit(edit => edit.replace(selection, text))) throw new Error('草稿发生变化，请重新插入 @');
    await this.native.focus(active);
  }
  async sendMessage(key: string, text: string, replyId?: string): Promise<boolean> {
    const submission = await this.submitDraft(key, text, replyId);
    return submission ? submission.completion : false;
  }
  async submitDraft(key: string, text: string, replyId?: string): Promise<Submission | undefined> {
    const store = this.store;
    if (!store || !store.chats.has(key)) throw new Error('发送对象无效');
    const openDoc = vscode.workspace.textDocuments.find(doc => !doc.isClosed && this.transcript?.key(doc.uri) === key);
    if (this.emojis.isImporting(key)) throw new Error('表情仍在导入，请在占位符出现后发送');
    if (openDoc && this.native.isImporting(openDoc)) throw new Error('文件仍在导入，请在占位符出现后发送');
    if (openDoc && !this.native.region(openDoc)) throw new Error('草稿分隔线被修改，发送已暂停。请先重建聊天文档');
    if (!text.trim() && !store.draft(key).attachments.some(a => !a.placeholder)) return;
    if (text.length > 65536) throw new Error('消息过长，请拆分后发送');
    if (!this.ready) throw new Error('NapCat 未连接，草稿已保留');
    const pendingKey = `${store.selfId}:${key}`;
    if (this.submitting.has(pendingKey)) return;
    if (replyId && (!/^-?\d+$/.test(replyId) || replyId === '0')) throw new Error('这条消息暂时无法引用');
    this.submitting.add(pendingKey);
    try {
      const submission = this.outbox.submit(store, key, text, replyId);
      await this.syncOutgoing(store, key, true);
      return submission;
    } finally { this.submitting.delete(pendingKey); }
  }
  private async syncOutgoing(store: ChatStore, key: string, follow = false): Promise<void> {
    if (store !== this.store) return;
    this.emojis.update();
    for (const editor of vscode.window.visibleTextEditors.filter(e => this.transcript?.key(e.document.uri) === key)) {
      if (follow) this.editor.follow(editor, true);
      await this.native.sync(editor, true);
      if (follow) this.editor.latest(editor);
    }
  }
  private isReading(key: string): boolean {
    if (!vscode.window.state.focused) return false;
    return vscode.window.visibleTextEditors.some(editor => this.transcript?.key(editor.document.uri) === key
      && (editor === vscode.window.activeTextEditor || (this.emojis.focused && this.target === key))
      && this.editor.isFollowing(editor));
  }
  checkRead(): void { if (this.target && this.isReading(this.target)) this.store?.markRead(this.target); }
  private commands(): void {
    const register = (command: string, action: (...args: any[]) => unknown) => {
      this.disposables.push(vscode.commands.registerCommand(command, async (...args: any[]) => {
        try { return await action(...args); } catch (error: any) { this.log(error); void vscode.window.showErrorMessage(error.message); throw error; }
      }));
    };
    const currentKey = (item?: (Chat & { account?: string }) | string): string | undefined => typeof item === 'string' ? item : item?.account && item.account !== this.store?.selfId ? undefined : item?.key ?? this.target;
    register('qq.forwardMessage', () => this.forwards.forward());
    register('qq.mergeForward', () => this.forwards.forward(true));
    register('qq.viewForward', () => this.forwards.view());
    register('qq.openForward', (uri: string, messageId: string, index: number) => this.forwards.open(uri, messageId, index));
    register('qq.openForwardImage', (uri: string, messageId: string, index: number) => this.forwards.openImage(uri, messageId, index));
    register('qq.slash', (name?: string, invocation?: SlashInvocation) => this.slash.run(name, invocation));
    register('qq.openEmojiPicker', (invocation: SlashInvocation) => this.emojiCompletion.open(invocation));
    register('qq.connect', () => this.connect());
    register('qq.disconnect', () => this.client.disconnect());
    register('qq.configure', () => this.settings.open());
    register('qq.chooseCodeLanguage', async () => {
      const selected = await vscode.window.showQuickPick(codeLanguages.map(value => ({
        label: languageLabels[value], description: value === this.config.codeLanguage ? '当前风格' : '', value
      })), { title: 'QQ 代码风格', placeHolder: '选择后立即应用，保留当前草稿' });
      if (selected) await vscode.workspace.getConfiguration('qq').update('codeLanguage', selected.value, vscode.ConfigurationTarget.Global);
    });
    register('qq.toggleAutoConnect', async () => {
      const config = vscode.workspace.getConfiguration('qq');
      await config.update('autoConnect', !config.get('autoConnect', true), vscode.ConfigurationTarget.Global);
    });
    for (const page of ['list'] as Section[]) register(`qq.show.${page}`, async () => {
      await vscode.commands.executeCommand(`qq.${page}.focus`);
    });
    register('qq.importConfig', async () => { if (await this.config.import()) await this.connect(); });
    register('qq.refresh', () => this.ready ? this.refresh() : this.connect());
    register('qq.openChat', (item: string | Chat) => this.openChat(item));
    register('qq.toggleCollapsed', (item?: Chat | string) => { const key = currentKey(item); if (key) this.store?.toggleCollapsed(key); });
    register('qq.toggleFavorite', (item?: Chat | string) => { const key = currentKey(item); if (key) this.store?.toggleFavorite(key); });
    register('qq.markRead', (item?: Chat | string) => { const key = currentKey(item); if (key) this.store?.markRead(key); });
    register('qq.toggleIgnoreUnread', (item?: Chat | string) => { const key = currentKey(item); if (key) this.store?.toggleIgnoreUnread(key); });
    register('qq.search.list', () => this.searchList('list'));
    register('qq.clearSearch.list', () => this.filterList('list', ''));
    register('qq.focusInput', () => this.focusInput());
    register('qq.send', async () => {
      const editor = vscode.window.activeTextEditor, key = editor && this.transcript?.key(editor.document.uri);
      if (!editor || !key) return;
      const text = this.native.draft(editor.document), chat = this.store?.chats.get(key);
      const command = chat && exactSlashCommand(outgoingReply({ ...this.store!.draft(key), text }).text, chat.type);
      if (command) {
        const invocation = this.slash.capture(editor.document.uri), region = this.native.region(editor.document);
        const keep = boundReplies(text, this.store!.draft(key).replies).map(reply => reply.token).join('');
        if (invocation && region && await editor.edit(edit => edit.replace(new vscode.Range(editor.document.positionAt(region.start), editor.document.positionAt(region.start + text.length)), keep))) await this.slash.run(command.name, invocation);
        return;
      }
      await this.submitDraft(key, text, this.store?.draft(key).replyId);
    });
    register('qq.newline', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || !this.native.inDraft(editor)) return;
      const applied = await editor.edit(edit => { for (const selection of editor.selections) edit.replace(selection, '\n'); });
      if (applied) {
        if (editor.selection.active.line === editor.document.lineCount - 1) this.editor.latest(editor);
        else editor.revealRange(new vscode.Range(editor.selection.active, editor.selection.active));
      }
    });
    register('qq.retryMessage', async (uri: string, messageId: string) => {
      if (typeof uri !== 'string' || typeof messageId !== 'string') return;
      const store = this.store, key = this.transcript?.key(vscode.Uri.parse(uri));
      const message = key && store?.messages.get(key)?.find(m => m.id === messageId);
      if (!store || !message || !message.outgoing || !['failed', 'uncertain'].includes(message.sendState ?? '')) return;
      if (!this.ready) throw new Error('NapCat 未连接，消息仍保留在记录中');
      const state = message.sendState;
      if (state === 'uncertain' && await vscode.window.showWarningMessage('这条消息的结果未确认，可能已经送达。检查聊天记录后仍要重试吗？', { modal: true }, '仍然重试') !== '仍然重试') return;
      if (store !== this.store || message.sendState !== state) return;
      message.sendState = 'queued'; message.sendError = undefined; store.enrichMessage(message);
      return this.outbox.enqueue(store, message);
    });
    register('qq.cancelMessage', async (uri: string, messageId: string) => {
      const key = this.transcript?.key(vscode.Uri.parse(uri));
      const message = key && this.store?.messages.get(key)?.find(m => m.id === messageId);
      if (message && this.store) await this.outbox.cancel(this.store, message);
    });
    register('qq.insertFile', async () => {
      const store = this.store, files = this.attachments, key = this.target; if (!store || !files || !key) return;
      const selected = await vscode.window.showOpenDialog({ canSelectMany: true, title: '选择要发送的文件' });
      if (!selected?.length || store !== this.store) return;
      const staged: Attachment[] = [];
      try {
        for (const uri of selected) staged.push(await files.stageFilePath(uri.fsPath, path.basename(uri.fsPath)));
        if (store !== this.store) throw new Error('账号已切换，请重新导入');
        await this.attachToDraft(key, staged);
      } catch (error) { await files.discard(staged); throw error; }
    });
    register('qq.restoreTranscript', async () => {
      const editor = vscode.window.activeTextEditor;
      if (editor && this.transcript?.key(editor.document.uri)) { await this.native.sync(editor, true, true); await this.native.focus(editor); }
    });
    register('qq.insertImage', () => this.target ? this.imports.selectImages(this.target) : undefined);
    register('qq.mentionMember', () => this.mentionMember());
    register('qq.mentionSender', () => this.mentionMember(true));
    register('qq.insertMention', (uri: string, qq: string, name?: string) => this.insertMention(uri, qq, name, true));
    register('qq.emojis', () => this.emojis.showEmojis());
    register('qq.cancelReply', async (uri?: string, expectedToken?: string) => {
      const editor = typeof uri === 'string' ? vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === uri) : vscode.window.activeTextEditor;
      const key = editor && this.transcript?.key(editor.document.uri) || (!uri ? this.target : undefined);
      if (!key || !this.store || expectedToken && this.store.draft(key).replyPlaceholder !== expectedToken) return;
      this.store.cancelReply(key);
      if (editor && this.transcript?.key(editor.document.uri) === key) await this.native.sync(editor);
    });
    register('qq.latest', () => this.editor.latest());
    register('qq.loadHistory', () => { if (this.target) return this.loadHistory(this.target, true); });
    register('qq.search', async () => {
      const chats = [...this.store?.chats.values() ?? []];
      const selected = await vscode.window.showQuickPick(chats.map(chat => ({ label: chat.name, description: `${chat.type === 'group' ? '群' : '好友'} ${chat.id}`, detail: `${chat.remark ?? ''} ${chat.nickname ?? ''}`, chat })), { placeHolder: '搜索群聊、好友名称或号码', matchOnDescription: true, matchOnDetail: true });
      if (selected) await this.openChat(selected.chat.key);
    });
    register('qq.reply', async (uri?: string, messageId?: string) => {
      const editor = typeof uri === 'string' ? vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === vscode.Uri.parse(uri).toString()) : vscode.window.activeTextEditor;
      if (!editor || !this.store || !this.transcript) return;
      if (!this.native.historyMatches(editor.document)) throw new Error('历史已在本地修改，请先重建聊天文档再回复');
      const key = this.transcript.key(editor.document.uri);
      const msg = key && typeof messageId === 'string' ? this.store.messages.get(key)?.find(m => m.id === messageId) : this.transcript.messageAt(editor.document.uri, editor.selection.active.line);
      if (!key || !msg) return;
      if (!/^-?\d+$/.test(msg.id)) throw new Error('这条消息暂时无法引用');
      this.target = key; this.store.setReply(key, msg.id, this.store.displayMessages(key).find(m => m.id === msg.id)?.senderName || msg.senderName); await this.native.sync(editor); await this.focusInput();
    });
    register('qq.copyMessage', async () => {
      const editor = vscode.window.activeTextEditor;
      if (editor && !this.native.historyMatches(editor.document)) throw new Error('历史已在本地修改，请先重建聊天文档再复制原文');
      const msg = editor && this.transcript?.messageAt(editor.document.uri, editor.selection.active.line);
      if (msg) await vscode.env.clipboard.writeText(messageText(msg));
    });
    register('qq.downloadFile', async (uri: string, messageId: string, fileIndex: number) => {
      const store = this.store, key = this.transcript?.key(vscode.Uri.parse(uri));
      if (!store || !key || !Number.isInteger(fileIndex) || fileIndex < 0) return;
      const message = store.messages.get(key)?.find(m => m.id === messageId);
      const part = message?.segments.filter(s => s.type === 'file')[fileIndex];
      if (!part || part.type !== 'file') throw new Error('文件消息不在当前记录中');
      const ref = part.file;
      const safeName = ref.name.split(/[\\/]/).pop()?.replace(/[<>:"|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '') || 'QQ文件';
      const destination = await vscode.window.showSaveDialog({ title: '保存 QQ 文件', defaultUri: vscode.Uri.file(path.join(os.homedir(), 'Downloads', safeName)) });
      if (!destination || store !== this.store) return;
      const chat = splitKey(key);
      let url = ref.url;
      if (ref.id && this.client.connected) {
        try {
          const result = await this.client.call(chat.type === 'group' ? 'get_group_file_url' : 'get_private_file_url', { file_id: ref.id, ...(chat.type === 'group' ? { group_id: chat.id, busid: ref.busid } : { user_id: chat.id }) });
          if (typeof result?.url === 'string') url = result.url;
        } catch (error) { if (!url) throw error; }
      }
      if (!url) throw new Error('NapCat 未提供文件下载地址，请检查文件是否已过期');
      const source = url;
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `下载 ${safeName}`, cancellable: true }, async (progress, token) => {
        const controller = new AbortController();
        const listener = token.onCancellationRequested(() => controller.abort());
        let last = 0;
        try {
          if (token.isCancellationRequested) controller.abort();
          await downloadFile(source, destination.fsPath, AbortSignal.any([controller.signal, AbortSignal.timeout(30 * 60 * 1000)]), (bytes, total) => {
            const percent = total ? bytes / total * 100 : 0;
            progress.report({ increment: percent - last, message: `${(bytes / 1048576).toFixed(1)} MB${total ? ` / ${(total / 1048576).toFixed(1)} MB` : ''}` }); last = percent;
          });
        } finally { listener.dispose(); }
      });
      const choice = await vscode.window.showInformationMessage(`文件已保存：${safeName}`, '打开所在文件夹');
      if (choice) await vscode.commands.executeCommand('revealFileInOS', destination);
    });
    register('qq.insertMessageImage', (uri?: string, messageId?: string, imageIndex?: number) => this.insertMessageImage(uri, messageId, imageIndex));
    register('qq.openImage', async (uri: string, messageId: string, imageIndex: number) => {
      if (!this.transcript || typeof uri !== 'string' || typeof messageId !== 'string') return;
      const file = await this.transcript.image(vscode.Uri.parse(uri), messageId, imageIndex);
      await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(file), 'imagePreview.previewEditor', { preview: true, viewColumn: vscode.ViewColumn.Beside });
    });
    register('qq.openDraftImage', async (uri: string, attachmentId: string) => {
      const key = this.transcript?.key(vscode.Uri.parse(uri));
      const attachment = key && this.store?.draft(key).attachments.find(a => a.id === attachmentId);
      if (!attachment || !this.attachments || !attachment.file) return;
      await this.attachments.read(attachment);
      await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(attachment.file), 'imagePreview.previewEditor', { preview: true, viewColumn: vscode.ViewColumn.Beside });
    });
  }
  private async insertMessageImage(uri?: string, messageId?: string, imageIndex?: number): Promise<void> {
    const store = this.store, transcript = this.transcript, files = this.attachments;
    if (!store || !transcript || !files) throw new Error('请先打开 QQ 会话');
    const active = vscode.window.activeTextEditor;
    let source: vscode.Uri;
    if (typeof uri === 'string') source = vscode.Uri.parse(uri);
    else {
      if (!active || !this.native.historyMatches(active.document)) throw new Error('请将光标放到聊天记录的 [图片] 上');
      source = active.document.uri;
      const key = transcript.key(source);
      const span = key && transcript.rendered.get(key)?.images.find(s => s.line === active.selection.active.line && active.selection.active.character >= s.start && active.selection.active.character < s.end);
      if (!span) throw new Error('请将光标放到聊天记录的 [图片] 上');
      messageId = span.messageId; imageIndex = span.imageIndex;
    }
    const key = transcript.key(source);
    if (!key || typeof messageId !== 'string' || !Number.isInteger(imageIndex) || imageIndex! < 0) throw new Error('图片不属于当前账号的会话');
    const operation = `${store.selfId}:${key}:${messageId}:${imageIndex}`;
    if (this.importingMessageImages.has(operation)) return;
    this.importingMessageImages.add(operation);
    let attachment: Attachment | undefined;
    try {
      const file = await transcript.image(source, messageId, imageIndex!);
      const bytes = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(file)));
      if (store !== this.store || transcript !== this.transcript) throw new Error('账号已切换，请重新选择图片');
      const message = store.messages.get(key)?.find(m => m.id === messageId);
      attachment = await files.stage(bytes, '聊天记录图片', message?.localImages?.[imageIndex!]?.sticker);
      if (store !== this.store || transcript !== this.transcript) throw new Error('账号已切换，请重新选择图片');
      // A slow download must not insert into whichever conversation became active later.
      if (active && vscode.window.activeTextEditor === active && transcript.key(active.document.uri) === key) {
        this.target = key;
        await this.native.insert(key, [attachment]);
        if (store === this.store && vscode.window.activeTextEditor === active) {
          if (!this.native.inDraft(active)) await this.native.focus(active);
          this.editor.latest(active, false);
        }
      } else store.attach(key, [attachment]);
    } finally {
      if (attachment && !store.draft(key).attachments.some(a => a.id === attachment!.id)) await files.discard([attachment]);
      this.importingMessageImages.delete(operation);
    }
  }
  attachToDraft(key: string, attachments: Attachment[]): Promise<void> { return this.native.insert(key, attachments); }
  async focusInput(): Promise<void> {
    const key = this.target, chat = key && this.store?.chats.get(key);
    if (!chat || !this.transcript) return;
    const doc = await vscode.workspace.openTextDocument(this.transcript.uri(chat));
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    await this.native.focus(editor);
    this.editor.latest(editor);
  }
  filterList(section: Section, query: string, fromCommand = true): void {
    this.trees.find(t => t.section === section)?.setFilter(query);
    if (fromCommand) this.listViews.get(section)?.setFilter(query);
    void vscode.commands.executeCommand('setContext', `qq.${section}.filtered`, !!query.trim());
  }
  private async searchList(section: Section): Promise<void> {
    await vscode.commands.executeCommand(`qq.${section}.focus`);
    this.listViews.get(section)?.focusSearch();
  }
  private updateStatus(text: string): void {
    this.settingsTree.status = text; this.settingsTree.refresh();
    this.status.text = `$(${this.ready ? 'comment-discussion' : 'debug-disconnect'}) QQ · ${text}`;
    this.status.tooltip = 'NapCat / OneBot v11 · 点击重新连接'; this.emojis.update();
  }
  private log(error: unknown): void { this.output.appendLine(`[${new Date().toISOString()}] ${error instanceof Error ? error.message : String(error)}`); }
  async shutdown(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true; clearTimeout(this.historyClickTimer); this.session.advance(); clearTimeout(this.initializationRetry); clearInterval(this.cacheTimer); clearInterval(this.notificationTimer); this.notifications?.dispose(); this.historyQueue.clear();
    this.client.dispose(); await this.store?.dispose(); this.transcript?.dispose();
    this.disposables.forEach(d => d.dispose());
  }
  dispose(): void { void this.shutdown(); }
}

let app: QQApp | undefined;
export async function activate(context: vscode.ExtensionContext): Promise<{ app: QQApp }> {
  app = new QQApp(context); context.subscriptions.push(app); await app.start(); return { app };
}
export async function deactivate(): Promise<void> { await app?.shutdown(); app = undefined; }
