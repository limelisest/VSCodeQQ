import * as vscode from 'vscode';
import { ChatStore } from './store';
import { Transcript } from './transcript';
import { AttachmentFiles } from './attachments';
import { NativeEditor } from './nativeEditor';
import { reminderColors, draftActions } from './settingsSchema';
interface EditorHost {
  store?: ChatStore; transcript?: Transcript; attachments?: AttachmentFiles;
  checkRead(): void;
  refreshUnreadStatus(): void;
}
type Anchor = { messageId?: string; offset: number; character: number; draftOffset?: number };
type ViewSnapshot = { editor: vscode.TextEditor; follow: boolean; top: Anchor; selections: { anchor: Anchor; active: Anchor }[] };
export class ChatEditorController implements vscode.Disposable {
  private imageDecoration = vscode.window.createTextEditorDecorationType({ color: new vscode.ThemeColor('textLink.foreground'), textDecoration: 'underline' });
  private fieldDecoration = vscode.window.createTextEditorDecorationType({ textDecoration: 'underline', rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed });
  private ownDecoration = vscode.window.createTextEditorDecorationType({ isWholeLine: true, backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'), borderWidth: '0 0 0 2px', borderStyle: 'solid', borderColor: new vscode.ThemeColor('editorGutter.addedBackground') });
  private recalledDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true, color: '#F14C4C', backgroundColor: '#F14C4C18',
    borderWidth: '0 0 0 2px', borderStyle: 'solid', borderColor: '#F14C4C',
    overviewRulerColor: '#F14C4C', overviewRulerLane: vscode.OverviewRulerLane.Right,
    light: { color: '#B42318', backgroundColor: '#B4231818', borderColor: '#B42318', overviewRulerColor: '#B42318' },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
  });
  private decorationCache = new WeakMap<vscode.TextEditor, Map<string, { signature: string; ranges: vscode.Range[] }>>();
  private following = new Map<vscode.TextEditor, boolean>();
  private attentionLenses = new vscode.EventEmitter<void>();
  private attentionAnchors = new Map<string, string>();
  private attentionLensState = '';
  private attentionTimer?: NodeJS.Timeout;
  private scrollGuards = new Map<string, NodeJS.Timeout>();
  private snapshots = new Map<string, ViewSnapshot[]>();
  private mentionDecoration!: vscode.TextEditorDecorationType;
  private replyDecoration!: vscode.TextEditorDecorationType;
  private extraDecorations = new Map<string, vscode.TextEditorDecorationType>();
  readonly native: NativeEditor;
  private disposables: vscode.Disposable[] = [];
  constructor(private host: EditorHost) {
    this.native = new NativeEditor({
      get store() { return host.store; }, get transcript() { return host.transcript; }, get attachments() { return host.attachments; },
      beforeHistoryChange: uri => this.beforeHistoryChange(uri),
      afterHistoryChange: (doc, applied) => this.afterHistoryChange(doc, applied)
    });
    this.refreshHighlights();
    this.disposables.push(this.native, this.imageDecoration, this.fieldDecoration, this.ownDecoration, this.recalledDecoration, this.attentionLenses,
      vscode.languages.registerCodeLensProvider({ scheme: 'qqchat' }, { onDidChangeCodeLenses: this.attentionLenses.event, provideCodeLenses: doc => this.provideCodeLenses(doc) }),
      vscode.workspace.registerFileSystemProvider('qqchat', this.native, { isCaseSensitive: true }),
      vscode.workspace.onDidCloseTextDocument(doc => this.native.release(doc)),
      vscode.window.onDidChangeTextEditorVisibleRanges(({ textEditor: editor }) => {
        const uri = editor.document.uri.toString(), key = host.transcript?.key(editor.document.uri);
        if (!key || this.snapshots.has(uri) || this.scrollGuards.has(uri)) return;
        const bottom = this.atBottom(editor); this.following.set(editor, bottom);
        host.checkRead(); this.updateUnreadStatus(); this.refreshAttention();
      }),
      vscode.window.onDidChangeVisibleTextEditors(editors => {
        for (const editor of this.following.keys()) if (!editors.includes(editor)) this.following.delete(editor);
        for (const editor of editors) {
          this.decorationCache.delete(editor);
          const key = host.transcript?.key(editor.document.uri);
          if (key) this.native.schedule(key, true);
          this.decorate(editor);
        }
      }),
      vscode.window.onDidChangeActiveTextEditor(() => { this.native.updateContext(); this.updateUnreadStatus(); this.refreshAttention(); }),
      vscode.window.onDidChangeWindowState(() => this.refreshAttention()),
      vscode.workspace.onDidChangeTextDocument(event => {
        if (!event.contentChanges.length) return;
        for (const editor of vscode.window.visibleTextEditors.filter(editor => editor.document === event.document)) {
          const cached = this.decorationCache.get(editor);
          for (const [key, entry] of cached ?? []) if (event.contentChanges.some(change => entry.ranges.some(range => change.range.start.isBeforeOrEqual(range.end)))) cached!.delete(key);
        }
        this.native.changed(event.document, event.contentChanges); this.documentChanged(event.document);
      }));
  }
  isFollowing(editor: vscode.TextEditor): boolean { return this.following.get(editor) ?? this.atBottom(editor); }
  follow(editor: vscode.TextEditor, value: boolean): void { this.following.set(editor, value); }
  reset(): void {
    clearTimeout(this.attentionTimer); this.attentionAnchors.clear(); this.attentionLensState = ''; this.attentionLenses.fire();
    this.native.reset(); this.decorationCache = new WeakMap(); this.following.clear(); this.snapshots.clear();
    for (const timer of this.scrollGuards.values()) clearTimeout(timer);
    this.scrollGuards.clear(); this.updateUnreadStatus();
  }
  private atBottom(editor: vscode.TextEditor): boolean {
    return editor.visibleRanges.some(range => range.end.line >= editor.document.lineCount - 3);
  }
  private visibleTop(editor: vscode.TextEditor): vscode.Position {
    const range = editor.visibleRanges[0];
    if (!range) return new vscode.Position(0, 0);
    // A partly visible wrapped line can become the next line after a layout
    // update. Anchor the first complete line instead of revealing that fragment
    // again, which adds VS Code's surrounding/sticky lines to the scroll.
    return range.start.character > 0 && range.start.line < range.end.line
      ? new vscode.Position(range.start.line + 1, 0) : range.start;
  }
  latest(editor = vscode.window.activeTextEditor, markRead = true): void {
    const key = editor && this.host.transcript?.key(editor.document.uri);
    if (!editor || !key) return;
    this.attentionAnchors.delete(key); this.refreshAttention();
    this.following.set(editor, true);
    const last = editor.document.lineAt(editor.document.lineCount - 1).range.end;
    const uri = editor.document.uri.toString();
    clearTimeout(this.scrollGuards.get(uri));
    this.scrollGuards.set(uri, setTimeout(() => { this.scrollGuards.delete(uri); }, 80));
    if (vscode.workspace.getConfiguration('editor', editor.document).get('scrollBeyondLastLine', true)) {
      // Default only reveals an off-screen line; a visible draft can drift upwards
      // after history trimming. Queue both reveals together, on this editor (even
      // when a panel has focus), so the final reveal approaches EOF from above.
      editor.revealRange(new vscode.Range(0, 0, 0, 0), vscode.TextEditorRevealType.AtTop);
      editor.revealRange(new vscode.Range(last, last), vscode.TextEditorRevealType.Default);
    } else {
      // With no scrollable space after EOF, AtTop clamps to the actual bottom.
      editor.revealRange(new vscode.Range(last, last), vscode.TextEditorRevealType.AtTop);
    }
    if (markRead) this.host.checkRead(); this.updateUnreadStatus();
  }
  private updateUnreadStatus(): void {
    this.host.refreshUnreadStatus();
  }
  refreshAttention(): void {
    clearTimeout(this.attentionTimer);
    const editor = vscode.window.activeTextEditor, store = this.host.store;
    const key = editor && this.host.transcript?.key(editor.document.uri);
    const target = key && store?.unseenAttention(key).at(-1);
    const state = JSON.stringify([editor?.document.uri.toString(), target && target.id, key && this.attentionAnchors.get(key), vscode.workspace.getConfiguration('qq').get('statusBarButtons')]);
    if (state !== this.attentionLensState) { this.attentionLensState = state; this.attentionLenses.fire(); }
    this.updateUnreadStatus();
    if (!editor || !key || !store || !vscode.window.state.focused) return;
    this.attentionTimer = setTimeout(() => {
      if (editor !== vscode.window.activeTextEditor || store !== this.host.store || !vscode.window.state.focused || !this.native.historyMatches(editor.document) || this.snapshots.has(editor.document.uri.toString())) return;
      const rendered = this.host.transcript?.rendered.get(key); if (!rendered) return;
      // Use visible body lines, not a partially visible date/header. Also remember
      // ordinary replies already seen before their original is resolved.
      const bodies = new Map(rendered.actions.filter(a => a.kind === 'reply').map(a => [a.messageId, a.line]));
      const seen = new Set<string>();
      for (const range of editor.visibleRanges) for (let line = range.start.line; line <= range.end.line; line++) {
        const id = rendered.messages.get(line), body = id === undefined ? undefined : bodies.get(id);
        if (id && body !== undefined && line >= body) seen.add(id);
      }
      store.markViewed(key, seen);
    }, 180);
  }
  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const key = this.host.transcript?.key(doc.uri), region = this.native.region(doc);
    if (!key || !region || vscode.window.activeTextEditor?.document !== doc || !this.native.historyMatches(doc)) return [];
    const draftLine = doc.positionAt(region.start).line - 1, uri = doc.uri.toString();
    const selected = vscode.workspace.getConfiguration('qq').get<string[]>('statusBarButtons', ['emojis', 'image', 'file', 'forward']);
    const lenses = Object.entries(draftActions).filter(([key]) => selected.includes(key)).map(([key, entry]) => new vscode.CodeLens(new vscode.Range(draftLine, 0, draftLine, 0), {
      title: entry.label, command: entry.command,
      arguments: key === 'image' || key === 'file' ? [uri] : 'arguments' in entry ? [...entry.arguments] : []
    }));
    const target = this.host.store?.unseenAttention(key).at(-1);
    if (target) {
      const anchor = this.attentionAnchors.get(key), rendered = this.host.transcript?.rendered.get(key);
      const line = (anchor ? rendered?.starts.get(anchor) : undefined) ?? draftLine;
      lenses.push(new vscode.CodeLens(new vscode.Range(line, 0, line, 0), { title: '↑ 上一个 @ 或回复', command: 'qq.previousAttention', arguments: [uri, target.id], tooltip: '上一个 @ 或回复' }));
    }
    return lenses;
  }
  async previousAttention(uri?: string, messageId?: string): Promise<void> {
    const editor = vscode.window.activeTextEditor, store = this.host.store, transcript = this.host.transcript;
    const key = editor && transcript?.key(editor.document.uri);
    if (!editor || !key || !store || !transcript) return;
    if (uri && editor.document.uri.toString() !== vscode.Uri.parse(uri).toString()) return;
    if (!this.native.historyMatches(editor.document)) throw new Error('历史已在本地修改，请先重建聊天文档再定位');
    await this.native.sync(editor, true);
    if (store !== this.host.store || transcript !== this.host.transcript || editor !== vscode.window.activeTextEditor || !this.native.historyMatches(editor.document)) return;
    const rendered = transcript.rendered.get(key);
    const pending = store.unseenAttention(key);
    const target = messageId ? pending.find(m => m.id === messageId) : pending.at(-1);
    const start = target && rendered?.starts.get(target.id);
    if (!target || start === undefined || !rendered) { this.refreshAttention(); return; }
    const body = rendered.actions.find(a => a.messageId === target.id && a.kind === 'reply');
    const position = new vscode.Position(body?.line ?? start, body?.start ?? 0);
    this.following.set(editor, false);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
    this.attentionAnchors.set(key, target.id);
    store.markViewed(key, new Set([target.id]));
    this.refreshAttention();
  }
  async openReplyOriginal(uri: string, messageId: string): Promise<void> {
    const editor = vscode.window.activeTextEditor, transcript = this.host.transcript, store = this.host.store;
    if (!editor || editor.document.uri.toString() !== vscode.Uri.parse(uri).toString() || !transcript || !store) return;
    const key = transcript.key(editor.document.uri); if (!key) return;
    if (!this.native.historyMatches(editor.document)) throw new Error('历史已在本地修改，请先重建聊天文档再定位');
    await this.native.sync(editor, true);
    if (transcript !== this.host.transcript || store !== this.host.store || editor !== vscode.window.activeTextEditor || !this.native.historyMatches(editor.document)) return;
    const rendered = transcript.rendered.get(key), start = rendered?.starts.get(messageId);
    if (start === undefined || !rendered) throw new Error('原消息不在当前缓存中，请先加载更早记录');
    const body = rendered.actions.find(a => a.kind === 'reply' && a.messageId === messageId);
    const position = new vscode.Position(body?.line ?? start, body?.start ?? 0);
    this.following.set(editor, false); editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
    this.refreshAttention();
  }
  refreshHighlights(): void {
    const cfg = vscode.workspace.getConfiguration('qq');
    const color = (key: string, fallback: string) => { const value = cfg.get(key, fallback); return /^#[0-9a-f]{6}$/i.test(value) ? value : fallback; };
    this.mentionDecoration?.dispose(); this.replyDecoration?.dispose();
    this.ownDecoration.dispose(); this.recalledDecoration.dispose();
    for (const decoration of this.extraDecorations.values()) decoration.dispose(); this.extraDecorations.clear();
    this.decorationCache = new WeakMap();
    const make = (value: string) => vscode.window.createTextEditorDecorationType({ isWholeLine: true, backgroundColor: value + '22', borderColor: value, borderStyle: 'solid', borderWidth: '0 0 0 2px', overviewRulerColor: value, overviewRulerLane: vscode.OverviewRulerLane.Right });
    this.mentionDecoration = make(color('mentionColor', '#E5A030'));
    this.replyDecoration = make(color('replyColor', '#409CFF'));
    this.ownDecoration = make(color('ownColor', reminderColors.ownColor.default));
    const recalled = color('recalledColor', reminderColors.recalledColor.default);
    this.recalledDecoration = vscode.window.createTextEditorDecorationType({ isWholeLine: true, color: recalled, backgroundColor: recalled + '18', borderColor: recalled, borderStyle: 'solid', borderWidth: '0 0 0 2px', rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed });
    for (const key of ['allMentionColor', 'failedColor', 'uncertainColor', 'systemColor'] as const) this.extraDecorations.set(key, make(color(key, reminderColors[key].default)));
  }
  private setDecorations(editor: vscode.TextEditor, type: vscode.TextEditorDecorationType, ranges: vscode.Range[]): void {
    let cached = this.decorationCache.get(editor);
    if (!cached) { cached = new Map(); this.decorationCache.set(editor, cached); }
    const signature = ranges.map(range => `${range.start.line}:${range.start.character}:${range.end.line}:${range.end.character}`).join(';');
    if (cached.get(type.key)?.signature === signature) return;
    editor.setDecorations(type, ranges); cached.set(type.key, { signature, ranges });
  }
  decorate(editor: vscode.TextEditor): void {
    const key = this.host.transcript?.key(editor.document.uri);
    if (!key || !this.host.transcript) return;
    const reliable = this.native.historyMatches(editor.document);
    const allMentions = new Set(reliable ? this.host.transcript.rendered.get(key)?.allMentionLines : []);
    this.setDecorations(editor, this.mentionDecoration, reliable ? (this.host.transcript.rendered.get(key)?.mentionLines ?? []).filter(line => !allMentions.has(line)).map(line => new vscode.Range(line, 0, line, 0)) : []);
    this.setDecorations(editor, this.replyDecoration, reliable ? (this.host.transcript.rendered.get(key)?.replyLines ?? []).map(line => new vscode.Range(line, 0, line, 0)) : []);
    this.setDecorations(editor, this.ownDecoration, reliable ? (this.host.transcript.rendered.get(key)?.ownLines ?? []).map(line => new vscode.Range(line, 0, line, 0)) : []);
    const recalledLines = reliable ? this.host.transcript.rendered.get(key)?.recalledLines ?? [] : [];
    this.setDecorations(editor, this.recalledDecoration, recalledLines.map(line => editor.document.lineAt(line).range));
    const recalled = new Set(recalledLines);
    const content = reliable ? this.host.transcript.rendered.get(key) : undefined;
    for (const [color, field] of [['allMentionColor', 'allMentionLines'], ['failedColor', 'failedLines'], ['uncertainColor', 'uncertainLines'], ['systemColor', 'systemLines']] as const) {
      const emphasized = new Set([...(content?.mentionLines ?? []), ...(content?.replyLines ?? [])]);
      this.setDecorations(editor, this.extraDecorations.get(color)!, (content?.[field] ?? []).filter(line => color !== 'systemColor' || !emphasized.has(line)).map(line => new vscode.Range(line, 0, line, 0)));
    }
    this.setDecorations(editor, this.fieldDecoration, [
      ...content?.mentions.filter(span => span.kind === 'sender') ?? [],
      ...content?.actions.filter(span => span.kind === 'reply') ?? []
    ].filter(span => !recalled.has(span.line)).map(span => new vscode.Range(span.line, span.start, span.line, span.end)));
    const draftLinks = this.native.links(editor.document);
    this.setDecorations(editor, this.imageDecoration, [
      ...(reliable ? this.host.transcript.provideDocumentLinks(editor.document).map(link => link.range) : []),
      ...draftLinks.map(link => link.range)
    ].filter(range => !recalled.has(range.start.line)));
  }
  beforeHistoryChange(uri: vscode.Uri): void {
    const key = this.host.transcript?.key(uri); if (!key) return;
    const rendered = this.host.transcript?.rendered.get(key);
    const anchor = (doc: vscode.TextDocument, p: vscode.Position): Anchor => {
      const region = this.native.region(doc), offset = doc.offsetAt(p);
      if (region && offset >= region.start) return { offset: 0, character: 0, draftOffset: offset - region.start };
      const messageId = rendered?.messages.get(p.line);
      return { messageId, offset: p.line - (messageId ? rendered?.starts.get(messageId) ?? 0 : 0), character: p.character };
    };
    this.snapshots.set(uri.toString(), vscode.window.visibleTextEditors.filter(editor => editor.document.uri.toString() === uri.toString()).map(editor => ({
      editor, follow: this.following.get(editor) ?? this.atBottom(editor),
      top: anchor(editor.document, this.visibleTop(editor)),
      selections: editor.selections.map(s => ({ anchor: anchor(editor.document, s.anchor), active: anchor(editor.document, s.active) }))
    })));
  }
  afterHistoryChange(doc: vscode.TextDocument, applied: boolean): void {
    const uri = doc.uri.toString();
    if (!applied) { this.snapshots.delete(uri); this.documentChanged(doc); return; }
    const key = this.host.transcript?.key(doc.uri); if (!key) { this.snapshots.delete(uri); return; }
    const rendered = this.host.transcript?.rendered.get(key);
    const position = (a: Anchor): vscode.Position => {
      const region = this.native.region(doc);
      if (a.draftOffset !== undefined && region) return doc.positionAt(region.start + Math.min(a.draftOffset, region.text.length));
      const line = Math.max(0, Math.min(doc.lineCount - 1, (a.messageId ? rendered?.starts.get(a.messageId) ?? 0 : 0) + a.offset));
      return new vscode.Position(line, Math.min(a.character, doc.lineAt(line).text.length));
    };
    for (const snapshot of this.snapshots.get(doc.uri.toString()) ?? []) {
      const editor = snapshot.editor;
      if (!vscode.window.visibleTextEditors.includes(editor)) continue;
      editor.selections = snapshot.selections.map(s => new vscode.Selection(position(s.anchor), position(s.active)));
      if (snapshot.follow) this.latest(editor, false);
      else {
        const top = position(snapshot.top);
        if (this.visibleTop(editor).line !== top.line) editor.revealRange(new vscode.Range(top, top), vscode.TextEditorRevealType.AtTop);
      }
      this.following.set(editor, snapshot.follow);
    }
    this.snapshots.delete(doc.uri.toString());
    clearTimeout(this.scrollGuards.get(uri));
    this.scrollGuards.set(uri, setTimeout(() => { this.scrollGuards.delete(uri); }, 80));
    this.updateUnreadStatus();
    this.documentChanged(doc);
  }
  private documentChanged(doc: vscode.TextDocument): void {
    for (const editor of vscode.window.visibleTextEditors) if (editor.document === doc) this.decorate(editor);
    this.refreshAttention();
  }
  dispose(): void {
    this.reset(); this.mentionDecoration.dispose(); this.replyDecoration.dispose();
    this.ownDecoration.dispose(); this.recalledDecoration.dispose(); for (const decoration of this.extraDecorations.values()) decoration.dispose();
    this.disposables.forEach(d => d.dispose());
  }
}
