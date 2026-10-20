import * as vscode from 'vscode';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ChatStore } from './store';
import { Attachment } from './model';
import { AttachmentFiles, basicFaces } from './attachments';
import { OneBotClient } from './onebot';
import { Transcript } from './transcript';
import { imageExtension } from './media';
import { RecentEmoji, rememberEmoji } from './recentEmojis';
import { AccountSession } from './accountSession';

export interface EmojiPickerHost {
  readonly emojiBackend?: string;
  session: AccountSession;
  store?: ChatStore; target?: string; ready: boolean;
  attachments?: AttachmentFiles; client: OneBotClient; transcript?: Transcript;
  checkRead(): void;
  attachToDraft(key: string, attachments: Attachment[]): Promise<void>;
  focusInput(): Promise<void>;
}
export class EmojiPicker implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private favoriteSources = new Map<string, { url?: string; file?: string; account: string }>();
  private favoriteRequest = 0;
  private choosing?: object;
  private panelContext = '';
  private panelRevision = 0;
  focused = false;
  private wantEmojis = false;
  private autoClose = false;
  private webviewReady = false;
  private imports = new Map<string, object>();
  private backendInfo?: { generation: number; value: Promise<string> };
  private preference?: { key: string; account: string };
  private orders = new Map<string, string>();
  private async backend(): Promise<string> {
    const generation = this.host.session.generation;
    if (this.backendInfo?.generation !== generation) this.backendInfo = { generation, value: this.host.client.call('get_version_info', {}, 1500).then(info => String(info?.app_name ?? ''), () => '') };
    return JSON.stringify([this.host.emojiBackend ?? '', await this.backendInfo.value]);
  }
  private async allFavorites(current: () => boolean): Promise<string[] | undefined> {
    // count is a prefix length, not an offset. Read a complete snapshot before
    // reversing or paginating it; some backends ignore count and return all.
    for (let count = 512; current(); count *= 2) {
      const faces = await this.host.client.call('fetch_custom_face', { count });
      if (!current()) return;
      if (!Array.isArray(faces)) throw new Error('收藏表情列表格式不正确');
      if (faces.length < count) return faces.filter((u: unknown): u is string => typeof u === 'string' && /^https?:\/\//i.test(u));
      if (count >= 2 ** 30) throw new Error('无法确认收藏表情列表已读取完整，请刷新重试');
    }
  }
  constructor(private context: vscode.ExtensionContext, private host: EmojiPickerHost) {}
  isImporting(key: string): boolean { return this.imports.has(key); }
  private invalidate(): void {
    this.panelRevision++; this.favoriteRequest++;
    this.favoriteSources.clear(); this.choosing = undefined; this.imports.clear();
    this.preference = undefined;
  }
  private async rememberImage(account: string, bytes: Buffer, label: string): Promise<void> {
    const ext = imageExtension(bytes); if (!ext) return;
    const hash = createHash('sha256').update(bytes).digest('hex');
    const folder = this.recentFolder(account); await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, hash + ext), bytes);
    await this.remember(account, { id: hash, kind: 'image', label, file: hash + ext });
  }
  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.webviewReady = false;
    this.favoriteSources.clear(); this.panelContext = '';
    const webview = view.webview;
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    webview.options = { enableScripts: true, localResourceRoots: [media, this.context.globalStorageUri] };
    const nonce = randomBytes(24).toString('hex');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(media, 'composer.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(media, 'composer.css'));
    webview.html = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${style}"></head><body><section id="emojiPanel"><nav role="tablist" aria-label="表情分类"><button id="tabFavorites" role="tab" aria-selected="true" aria-controls="stickerList">表情包</button><button id="tabBasic" role="tab" aria-selected="false" aria-controls="basicFaces">QQ 表情</button><span class="spacer"></span><label class="order-label" for="emojiOrder">收藏排序</label><select id="emojiOrder" aria-label="收藏表情排序" disabled><option value="original">原顺序</option><option value="reverse">反向顺序</option></select><button id="reloadFaces" title="刷新收藏表情" aria-label="刷新收藏表情">↻</button><button id="closeEmojis" title="关闭" aria-label="关闭表情">×</button></nav><div id="stickerList" role="tabpanel" aria-label="表情包"><section id="recentSection"><h3 class="emoji-heading">最近使用</h3><div id="recentFaces" class="faceGrid" aria-label="最近使用"></div></section><section id="favoriteSection"><h3 class="emoji-heading">收藏表情</h3><div id="favoriteStatus" role="status" hidden></div><div id="favoriteFaces" class="faceGrid" aria-label="收藏表情"></div></section></div><div id="basicFaces" class="faceGrid basicGrid" role="tabpanel" aria-label="QQ 表情" hidden></div><div id="error" role="status" hidden></div></section><script nonce="${nonce}" src="${script}"></script></body></html>`;
    view.onDidDispose(() => { if (this.view === view) { this.view = undefined; this.focused = false; this.invalidate(); } });
    view.onDidChangeVisibility(() => { if (!view.visible) this.invalidate(); });
    webview.onDidReceiveMessage(data => { void this.handleMessage(data).catch((error: Error) => this.post({ type: 'error', account: data?.account, key: data?.key, requestId: data?.requestId, message: error.message })); });
  }
  private post(data: unknown): void { void this.view?.webview.postMessage(data); }
  async handleMessage(data: any): Promise<void> {
    if (data?.type === 'ready') { this.webviewReady = true; this.update(); if (this.wantEmojis) { this.post({ type: 'showEmojis' }); this.wantEmojis = false; } return; }
    if (data?.type === 'focus') { this.focused = !!data.value; this.host.checkRead(); return; }
    if (data?.type === 'closeEmojis') { this.invalidate(); await this.close(); return; }
    const store = this.host.store, files = this.host.attachments;
    if (!store || data?.account !== store.selfId || typeof data.key !== 'string' || !store.chats.has(data.key)) return;
    const key: string = data.key, revision = this.panelRevision, session = this.host.session.capture();
    const current = () => store === this.host.store && session.current() && revision === this.panelRevision && key === this.host.target;
    if (!current()) return;
    if (data.type === 'emojiOrder') {
      const pref = this.preference;
      if (!pref || pref.account !== store.selfId || pref.key !== data.preferenceKey || !['original', 'reverse'].includes(data.order)) return;
      this.orders.set(pref.key, data.order);
      await this.context.globalState.update(pref.key, data.order);
      if (current()) this.post({ type: 'emojiOrder', account: store.selfId, key, order: data.order });
    } else if (data.type === 'basicFace') {
      const face = basicFaces.find(face => face.id === data.id); if (!face) return;
      if (this.choosing) return;
      const choice = {}; this.choosing = choice;
      try {
        await this.host.attachToDraft(key, [{ id: randomUUID(), kind: 'face', label: face.name, faceId: face.id }]);
        if (!current() || this.choosing !== choice) return;
        await this.remember(store.selfId, { id: `face:${face.id}`, kind: 'face', label: face.name, faceId: face.id });
        if (current() && this.choosing === choice) await this.selectionComplete(store.selfId, key);
      } finally { if (this.choosing === choice) this.choosing = undefined; }
    } else if (data.type === 'faces') {
      return this.host.session.run(JSON.stringify(['favorite-faces', key, revision, data.requestId]), async () => {
        if (!current()) return;
        const request = ++this.favoriteRequest;
        this.post({ type: 'basicFaces', account: store.selfId, key, requestId: data.requestId, faces: basicFaces });
        this.favoriteSources.clear();
        this.postRecent(store.selfId, key, data.requestId);
        if (!this.host.ready) throw new Error('请先连接 OneBot 服务后读取收藏表情');
        const faces = await this.allFavorites(() => current() && request === this.favoriteRequest);
        if (!faces) return;
        const backend = await this.backend();
        if (!current() || request !== this.favoriteRequest) return;
        const preferenceKey = `emojiOrder.${store.selfId}.${createHash('sha256').update(backend).digest('hex')}`;
        this.preference = { key: preferenceKey, account: store.selfId };
        const order = this.orders.get(preferenceKey) ?? this.context.globalState.get(preferenceKey, vscode.workspace.getConfiguration('qq').get('emojiOrder', 'original'));
        const entries = faces.map((url: string, i: number) => {
          const id = 'favorite:' + createHash('sha256').update(JSON.stringify([store.selfId, backend, url, i])).digest('hex'); this.favoriteSources.set(id, { url, account: store.selfId }); return { id, label: `收藏表情 ${i + 1}` };
        });
        this.post({ type: 'favoriteFaces', account: store.selfId, key, requestId: data.requestId, entries, order, preferenceKey });
      });
    } else if (data.type === 'favoritePreview' || data.type === 'favoriteFace') {
      const source = this.favoriteSources.get(data.id);
      if (!source || source.account !== store.selfId || !this.host.transcript || !files) return;
      if (data.type === 'favoriteFace' && this.choosing) return;
      const choice = {};
      if (data.type === 'favoriteFace') { this.choosing = choice; this.imports.set(key, choice); }
      const valid = () => current() && this.favoriteSources.get(data.id) === source && (data.type === 'favoritePreview' || this.choosing === choice);
      let attachment: Attachment | undefined;
      try {
      const file = source.file ?? await this.host.transcript.media.get({ file: '', url: source.url });
      if (!valid()) return;
      if (data.type === 'favoritePreview') {
        // Local Webview resource URLs can fail even for files under the allowed
        // storage root. Inline the requested preview so display does not depend
        // on that resource endpoint. Do not impose a preview file-size cap.
        const bytes = await fs.readFile(file);
        const mime: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' };
        if (!valid()) return;
        const ext = imageExtension(bytes); if (!ext) throw new Error('表情图片格式不受支持');
        this.post({ type: 'favoritePreview', account: store.selfId, key, id: data.id, src: `data:${mime[ext]};base64,${bytes.toString('base64')}` });
      }
      else {
        attachment = await files.stage(await fs.readFile(file), '收藏表情', true);
        if (!valid()) return;
        await this.host.attachToDraft(key, [attachment]);
        if (!valid()) return;
        await this.rememberImage(store.selfId, await fs.readFile(file), '收藏表情');
        if (valid()) await this.selectionComplete(store.selfId, key);
      }
      } catch (error: any) {
        if (!valid()) return;
        if (data.type === 'favoritePreview') this.post({ type: 'favoritePreviewError', account: store.selfId, key, id: data.id, message: error.message });
        else throw error;
      } finally {
        if (attachment && !store.draft(key).attachments.some(item => item.id === attachment!.id)) await files.discard([attachment]);
        if (this.imports.get(key) === choice) this.imports.delete(key);
        if (this.choosing === choice) this.choosing = undefined;
      }
    }
  }
  private recentFolder(account: string): string { return path.join(this.context.globalStorageUri.fsPath, 'accounts', account, 'recent-emojis'); }
  private recent(account: string): RecentEmoji[] { return this.context.globalState.get<RecentEmoji[]>(`recentEmojis.${account}`, []).slice(0, 10); }
  private async remember(account: string, item: RecentEmoji): Promise<void> {
    const previous = this.recent(account), next = rememberEmoji(previous, item);
    await this.context.globalState.update(`recentEmojis.${account}`, next);
    for (const old of previous) if (old.file && path.basename(old.file) === old.file && !next.some(e => e.file === old.file)) await fs.unlink(path.join(this.recentFolder(account), old.file)).catch(() => {});
  }
  private postRecent(account: string, key: string, requestId?: string): void {
    const entries = this.recent(account).flatMap<{ id: string; label: string; faceId?: string; icon?: string }>(item => {
      if (item.kind === 'face') {
        const face = basicFaces.find(face => face.id === item.faceId);
        return face ? [{ id: item.id, label: face.name, faceId: face.id, icon: face.icon }] : [];
      }
      if (!item.file || path.basename(item.file) !== item.file) return [];
      const id = `recent:${item.id}`;
      this.favoriteSources.set(id, { account, file: path.join(this.recentFolder(account), item.file) });
      return [{ id, label: item.label }];
    });
    this.post({ type: 'recentFaces', account, key, requestId, entries });
  }
  private async selectionComplete(account: string, key: string): Promise<void> {
    if (this.autoClose) { await this.close(); return; }
    this.postRecent(account, key);
    this.post({ type: 'selectionComplete', account, key });
  }
  private async close(): Promise<void> {
    if (this.view?.visible) await vscode.commands.executeCommand('workbench.action.closePanel');
    await this.host.focusInput();
  }
  update(): void {
    if (!this.view) return;
    const store = this.host.store;
    const key = this.host.target;
    const chat = key && store?.chats.get(key);
    const context = JSON.stringify([store?.selfId, key, this.host.ready]);
    if (context !== this.panelContext) {
      this.panelContext = context; this.invalidate();
    }
    this.post({ type: 'state', account: store?.selfId, key,
      name: chat ? `${chat.name}（${chat.type === 'group' ? '群' : '好友'} ${chat.id}）` : '', ready: this.host.ready, visible: this.view.visible });
  }
  async focus(): Promise<void> { await this.host.focusInput(); }
  async showEmojis(autoClose = false): Promise<void> {
    this.autoClose = autoClose; this.invalidate();
    this.wantEmojis = true;
    await vscode.commands.executeCommand('qq.composer.focus');
    this.view?.show(false); this.update();
    if (this.webviewReady && this.wantEmojis) { this.wantEmojis = false; this.post({ type: 'showEmojis' }); }
  }
}
