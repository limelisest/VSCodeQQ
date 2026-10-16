import * as vscode from 'vscode';
import { ChatStore } from './store';
import { Transcript } from './transcript';
import { AttachmentFiles } from './attachments';
import { NativeEditor } from './nativeEditor';
interface EditorHost {
  store?: ChatStore; transcript?: Transcript; attachments?: AttachmentFiles;
  checkRead(): void;
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
  private pendingMessages = new Map<string, number>();
  private newMessagesStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 9);
  private scrollGuards = new Map<string, NodeJS.Timeout>();
  private snapshots = new Map<string, ViewSnapshot[]>();
  private mentionDecoration!: vscode.TextEditorDecorationType;
  private replyDecoration!: vscode.TextEditorDecorationType;
  readonly native: NativeEditor;
  private disposables: vscode.Disposable[] = [];
  constructor(private host: EditorHost) {
    this.native = new NativeEditor({
      get store() { return host.store; }, get transcript() { return host.transcript; }, get attachments() { return host.attachments; },
      beforeHistoryChange: uri => this.beforeHistoryChange(uri),
      afterHistoryChange: (doc, applied) => this.afterHistoryChange(doc, applied)
    });
    this.refreshHighlights();
    this.newMessagesStatus.command = 'qq.latest'; this.newMessagesStatus.name = 'QQ 新消息';
    this.disposables.push(this.native, this.imageDecoration, this.fieldDecoration, this.ownDecoration, this.recalledDecoration, this.newMessagesStatus,
      vscode.workspace.registerFileSystemProvider('qqchat', this.native, { isCaseSensitive: true }),
      vscode.workspace.onDidCloseTextDocument(doc => this.native.release(doc)),
      vscode.window.onDidChangeTextEditorVisibleRanges(({ textEditor: editor }) => {
        const uri = editor.document.uri.toString(), key = host.transcript?.key(editor.document.uri);
        if (!key || this.snapshots.has(uri) || this.scrollGuards.has(uri)) return;
        const bottom = this.atBottom(editor); this.following.set(editor, bottom);
        if (bottom) this.pendingMessages.delete(key);
        host.checkRead(); this.updateNewMessages();
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
      vscode.window.onDidChangeActiveTextEditor(() => { this.native.updateContext(); this.updateNewMessages(); }),
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
  incoming(key: string): void {
    if (vscode.window.visibleTextEditors.some(e => this.host.transcript?.key(e.document.uri) === key && !this.isFollowing(e))) {
      this.pendingMessages.set(key, (this.pendingMessages.get(key) ?? 0) + 1); this.updateNewMessages();
    }
  }
  reset(): void {
    this.native.reset(); this.decorationCache = new WeakMap(); this.following.clear(); this.pendingMessages.clear(); this.snapshots.clear();
    for (const timer of this.scrollGuards.values()) clearTimeout(timer);
    this.scrollGuards.clear(); this.updateNewMessages();
  }
  private atBottom(editor: vscode.TextEditor): boolean {
    return editor.visibleRanges.some(range => range.end.line >= editor.document.lineCount - 3);
  }
  latest(editor = vscode.window.activeTextEditor, markRead = true): void {
    const key = editor && this.host.transcript?.key(editor.document.uri);
    if (!editor || !key) return;
    this.following.set(editor, true);
    this.pendingMessages.delete(key);
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
    if (markRead) this.host.checkRead(); this.updateNewMessages();
  }
  private updateNewMessages(): void {
    const editor = vscode.window.activeTextEditor, key = editor && this.host.transcript?.key(editor.document.uri);
    const count = key ? this.pendingMessages.get(key) ?? 0 : 0;
    if (!key || !editor || this.following.get(editor) !== false) { this.newMessagesStatus.hide(); return; }
    this.newMessagesStatus.text = count ? `$(arrow-down) 新消息 · ${count} 条` : '$(arrow-down) 返回最新';
    this.newMessagesStatus.tooltip = '点击回到底部并恢复自动跟随'; this.newMessagesStatus.show();
  }
  refreshHighlights(): void {
    const cfg = vscode.workspace.getConfiguration('qq');
    const color = (key: string, fallback: string) => { const value = cfg.get(key, fallback); return /^#[0-9a-f]{6}$/i.test(value) ? value : fallback; };
    this.mentionDecoration?.dispose(); this.replyDecoration?.dispose();
    const make = (value: string) => vscode.window.createTextEditorDecorationType({ isWholeLine: true, backgroundColor: value + '22', borderColor: value, borderStyle: 'solid', borderWidth: '0 0 0 2px', overviewRulerColor: value, overviewRulerLane: vscode.OverviewRulerLane.Right });
    this.mentionDecoration = make(color('mentionColor', '#E5A030'));
    this.replyDecoration = make(color('replyColor', '#409CFF'));
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
    this.setDecorations(editor, this.mentionDecoration, reliable ? (this.host.transcript.rendered.get(key)?.mentionLines ?? []).map(line => new vscode.Range(line, 0, line, 0)) : []);
    this.setDecorations(editor, this.replyDecoration, reliable ? (this.host.transcript.rendered.get(key)?.replyLines ?? []).map(line => new vscode.Range(line, 0, line, 0)) : []);
    this.setDecorations(editor, this.ownDecoration, reliable ? (this.host.transcript.rendered.get(key)?.ownLines ?? []).map(line => new vscode.Range(line, 0, line, 0)) : []);
    const recalledLines = reliable ? this.host.transcript.rendered.get(key)?.recalledLines ?? [] : [];
    this.setDecorations(editor, this.recalledDecoration, recalledLines.map(line => editor.document.lineAt(line).range));
    const recalled = new Set(recalledLines);
    const content = reliable ? this.host.transcript.rendered.get(key) : undefined;
    this.setDecorations(editor, this.fieldDecoration, [
      ...content?.mentions.filter(span => span.kind === 'sender') ?? [],
      ...content?.actions.filter(span => span.kind === 'reply') ?? []
    ].filter(span => !recalled.has(span.line)).map(span => new vscode.Range(span.line, span.start, span.line, span.end)));
    this.setDecorations(editor, this.imageDecoration, [
      ...(reliable ? this.host.transcript.provideDocumentLinks(editor.document).map(link => link.range) : []),
      ...this.native.links(editor.document).map(link => link.range)
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
      top: anchor(editor.document, editor.visibleRanges[0]?.start ?? new vscode.Position(0, 0)),
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
        if (editor.visibleRanges[0]?.start.line !== top.line) editor.revealRange(new vscode.Range(top, top), vscode.TextEditorRevealType.AtTop);
      }
      this.following.set(editor, snapshot.follow);
    }
    this.snapshots.delete(doc.uri.toString());
    clearTimeout(this.scrollGuards.get(uri));
    this.scrollGuards.set(uri, setTimeout(() => { this.scrollGuards.delete(uri); }, 80));
    this.updateNewMessages();
    this.documentChanged(doc);
  }
  private documentChanged(doc: vscode.TextDocument): void {
    for (const editor of vscode.window.visibleTextEditors) if (editor.document === doc) this.decorate(editor);
  }
  dispose(): void {
    this.reset(); this.mentionDecoration.dispose(); this.replyDecoration.dispose();
    this.disposables.forEach(d => d.dispose());
  }
}
