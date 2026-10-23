import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { attachmentPattern, Attachment, inline, messageText } from './model';
import { ChatStore } from './store';
import { Transcript } from './transcript';
import { AttachmentFiles } from './attachments';
import { imagePreviewMarkup } from './imageHover';
import { ResourceClipboard, RESOURCE_MIME, ResourceSpan } from './resourceClipboard';
import { transferFiles } from './transferFiles';
import { mentionPattern } from './mentions';
import { historyEdits } from './historyEdits';

const LEGACY_DRAFT_DIVIDER = '// ─── 草稿 · Enter 发送 · Shift/Ctrl+Enter 换行 ───';
export const DRAFT_DIVIDER = '// ─── Enter 发送 · Shift/Ctrl+Enter 换行 ───';
const DRAFT_DIVIDERS = [DRAFT_DIVIDER, LEGACY_DRAFT_DIVIDER + ' [发送]', LEGACY_DRAFT_DIVIDER];
function draftDivider(text: string): string | undefined {
  return DRAFT_DIVIDERS.map(marker => `\n${marker}\n`).find(divider => text.includes(divider));
}
interface Host {
  store?: ChatStore; transcript?: Transcript; attachments?: AttachmentFiles;
  beforeHistoryChange(uri: vscode.Uri): void;
  afterHistoryChange(doc: vscode.TextDocument, applied: boolean): void;
}

// VS Code has no public per-range read-only API. Only the explicit draft region is sent.
// This filesystem is local draft storage; saving a document NEVER sends a QQ message.
export class NativeEditor implements vscode.FileSystemProvider, vscode.Disposable {
  readonly clipboard = new ResourceClipboard();
  private events = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.events.event;
  private buffers = new Map<string, Uint8Array>();
  private prefixes = new Map<string, string>();
  private pending = new Map<string, boolean>();
  private timer?: NodeJS.Timeout;
  private saveTimers = new Map<string, NodeJS.Timeout>();
  private updating = new Map<string, Promise<void>>();
  private expectedEdits = new Map<string, { text: string; prefix: string; publish: () => void }>();
  private importing = new Map<string, { placeholders?: string[] }>();
  private importTimers = new Set<NodeJS.Timeout>();
  private repairs = new Set<string>();
  constructor(private host: Host) {}
  watch(): vscode.Disposable { return new vscode.Disposable(() => {}); }
  stat(uri: vscode.Uri): vscode.FileStat { return { type: vscode.FileType.File, ctime: 0, mtime: 0, size: this.readFile(uri).length }; }
  readDirectory(): [string, vscode.FileType][] { return []; }
  createDirectory(): void { throw vscode.FileSystemError.NoPermissions(); }
  delete(): void { throw vscode.FileSystemError.NoPermissions(); }
  rename(): void { throw vscode.FileSystemError.NoPermissions(); }
  readFile(uri: vscode.Uri): Uint8Array {
    const key = this.host.transcript?.key(uri), store = this.host.store;
    if (!key || !store) throw vscode.FileSystemError.Unavailable('请连接对应 QQ 账号后重新打开会话');
    const cached = this.buffers.get(uri.toString()); if (cached) return cached;
    const prefix = this.prefix(uri, key);
    const bytes = Buffer.from(prefix + store.draft(key).text, 'utf8');
    this.buffers.set(uri.toString(), bytes); return bytes;
  }
  writeFile(uri: vscode.Uri, content: Uint8Array): void {
    if (!this.host.transcript?.key(uri)) throw vscode.FileSystemError.NoPermissions('账号已切换');
    this.buffers.set(uri.toString(), content);
  }
  private prefix(uri: vscode.Uri, key: string): string {
    const history = this.host.transcript!.provideTextDocumentContent(uri);
    const prefix = `${history}\n\n${DRAFT_DIVIDER}\n`;
    this.prefixes.set(uri.toString(), prefix); return prefix;
  }
  region(doc: vscode.TextDocument): { boundary: number; start: number; text: string } | undefined {
    const text = doc.getText();
    const prefix = this.prefixes.get(doc.uri.toString());
    if (prefix && text.startsWith(prefix)) return { boundary: prefix.lastIndexOf('\n', prefix.length - 2), start: prefix.length, text: text.slice(prefix.length) };
    const divider = draftDivider(text); if (!divider) return;
    const boundary = text.indexOf(divider);
    if (boundary < 0 || text.indexOf(divider, boundary + divider.length) >= 0) return;
    const start = boundary + divider.length;
    return { boundary, start, text: text.slice(start) };
  }
  inDraft(editor: vscode.TextEditor): boolean {
    if (!this.host.transcript?.key(editor.document.uri)) return false;
    const region = this.region(editor.document);
    return !!region && editor.selections.every(s => editor.document.offsetAt(s.start) >= region.start);
  }
  historyMatches(doc: vscode.TextDocument): boolean {
    const region = this.region(doc);
    return !!region && doc.getText().slice(0, region.start) === this.prefixes.get(doc.uri.toString());
  }
  changed(doc: vscode.TextDocument, changes: readonly vscode.TextDocumentContentChangeEvent[] = []): void {
    const key = this.host.transcript?.key(doc.uri), store = this.host.store;
    if (!key || !store) return;
    const uri = doc.uri.toString(), text = doc.getText();
    const importing = this.importing.get(uri);
    if (importing?.placeholders?.length && importing.placeholders.every(p => this.region(doc)?.text.includes(p))) {
      this.importing.delete(uri); this.schedule(key, true);
    }
    const expected = this.expectedEdits.get(uri), internal = expected?.text === text;
    // A user may type while a history edit is in flight. The draft can then
    // differ from the expected snapshot while its new history is already valid.
    if (expected && text.startsWith(expected.prefix)) expected.publish();
    if (internal) this.expectedEdits.delete(uri);
    const replacesPage = !internal && !!this.region(doc) && changes.some(change => change.rangeOffset === 0 && DRAFT_DIVIDERS.some(marker => change.text.includes(`\n${marker}\n`)));
    if (!internal && changes.length && (!this.historyMatches(doc) || replacesPage)) {
      const old = Buffer.from(this.buffers.get(uri) ?? []).toString('utf8');
      const divider = draftDivider(old), boundary = divider ? old.indexOf(divider) : -1;
      const start = divider === undefined || boundary < 0 ? -1 : boundary + divider.length;
      // VS Code may reapply an older complete page from its hot-exit backup.
      // That page is a projection, not a draft edit: folding its replacement
      // text across the divider would copy history (including failed sends)
      // into the current draft. Persisted draft state owns page restoration.
      const pageSnapshot = replacesPage || !!this.region(doc) && changes.some(change => change.rangeOffset < start && !!divider && change.text.includes(divider));
      let draft = pageSnapshot ? store.draft(key).text : start >= 0 ? old.slice(start) : store.draft(key).text;
      if (!pageSnapshot && start >= 0) for (const change of [...changes].sort((a, b) => b.rangeOffset - a.rangeOffset)) {
        const end = change.rangeOffset + change.rangeLength;
        if (end < start || (end === start && change.rangeOffset < start)) continue;
        const from = Math.max(0, change.rangeOffset - start), to = Math.max(0, end - start);
        draft = draft.slice(0, from) + change.text + draft.slice(to);
      }
      if (draft !== store.draft(key).text) store.editDraft(key, draft);
      this.repairs.add(uri);
      const editor = vscode.window.visibleTextEditors.find(e => e.document === doc);
      if (editor) void this.sync(editor, true, true).then(() => {
        if (changes.some(c => c.rangeOffset + c.rangeLength >= start) && vscode.window.activeTextEditor === editor) return this.focus(editor);
      }).catch(() => {});
      return;
    }
    this.buffers.set(doc.uri.toString(), Buffer.from(doc.getText(), 'utf8'));
    const region = this.region(doc);
    // A programmatic render may finish after a newer draft was queued. Its
    // document event must not write that older snapshot back into the store.
    if (!internal && region && region.text !== store.draft(key).text) store.editDraft(key, region.text);
    clearTimeout(this.saveTimers.get(uri));
    this.saveTimers.set(uri, setTimeout(() => {
      this.saveTimers.delete(uri); if (!doc.isClosed && doc.isDirty) void doc.save();
    }, 500));
    this.updateContext();
  }
  updateContext(): void {
    const editor = vscode.window.activeTextEditor;
    void vscode.commands.executeCommand('setContext', 'qq.inDraft', !!editor && this.inDraft(editor));
  }
  schedule(key: string, history = false): void {
    this.pending.set(key, history || !!this.pending.get(key));
    if (!this.timer) this.timer = setTimeout(() => {
      this.timer = undefined;
      const pending = [...this.pending]; this.pending.clear();
      for (const [key, history] of pending) {
        const editor = vscode.window.visibleTextEditors.find(e => this.host.transcript?.key(e.document.uri) === key);
        if (editor) void this.sync(editor, history).catch(() => {});
      }
    }, 40);
  }
  async sync(editor: vscode.TextEditor, history = true, restore = false): Promise<void> {
    const uri = editor.document.uri.toString();
    if (this.importing.has(uri)) { const key = this.host.transcript?.key(editor.document.uri); if (key) this.schedule(key, history); return; }
    const previous = this.updating.get(uri) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(async () => {
      if (this.importing.has(uri)) { const key = this.host.transcript?.key(editor.document.uri); if (key) this.schedule(key, history); return; }
      const doc = editor.document, key = this.host.transcript?.key(doc.uri), store = this.host.store;
      if (!key || !store || doc.isClosed) return;
      restore ||= this.repairs.has(uri);
      const region = this.region(doc);
      if (!region && !restore) return;
      const transcript = this.host.transcript!;
      const previousRendered = transcript.rendered.get(key), previousPrefix = this.prefixes.get(uri);
      const changesHistory = history || restore;
      let committed = false, appliedChange = false;
      if (changesHistory) this.host.beforeHistoryChange(doc.uri);
      try {
        const projection = changesHistory ? transcript.project(doc.uri) : undefined;
        const prefix = projection ? `${projection.text}\n\n${DRAFT_DIVIDER}\n` : doc.getText().slice(0, region!.start);
        const publish = () => {
          if (this.host.store !== store || this.host.transcript !== transcript || doc.isClosed) return;
          this.prefixes.set(uri, prefix);
          if (projection?.rendered) transcript.rendered.set(key, projection.rendered);
        };
        const draft = store.draft(key).text;
        if (doc.getText() === prefix + draft) { publish(); committed = true; this.repairs.delete(uri); return; }
        // Keep the old projection usable until VS Code actually applies the edit.
        const expected = { text: prefix + draft, prefix, publish };
        this.expectedEdits.set(uri, expected);
        const applied = await editor.edit(edit => {
          if (restore) edit.replace(new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), prefix + draft);
          else {
            if (region!.text !== draft) edit.replace(new vscode.Range(doc.positionAt(region!.start), doc.positionAt(doc.getText().length)), draft);
            const oldPrefix = doc.getText().slice(0, region!.start);
            if (oldPrefix !== prefix) {
              for (const change of historyEdits(oldPrefix, prefix, previousRendered, projection?.rendered)) {
                edit.replace(new vscode.Range(doc.positionAt(change.start), doc.positionAt(change.end)), change.text);
              }
            }
          }
        }, { undoStopBefore: false, undoStopAfter: false });
        if (this.expectedEdits.get(uri) === expected) this.expectedEdits.delete(uri);
        committed = applied; appliedChange = applied;
        if (applied) { publish(); this.repairs.delete(uri); }
        else this.expectedEdits.delete(uri);
        if (!applied) this.schedule(key, history);
      } finally {
        if (!committed) {
          this.expectedEdits.delete(uri);
          if (previousPrefix === undefined) this.prefixes.delete(uri); else this.prefixes.set(uri, previousPrefix);
          if (previousRendered === undefined) transcript.rendered.delete(key); else transcript.rendered.set(key, previousRendered);
        }
        if (changesHistory) this.host.afterHistoryChange(doc, committed && appliedChange);
      }
    });
    this.updating.set(uri, task);
    try { await task; } finally { if (this.updating.get(uri) === task) this.updating.delete(uri); }
  }
  isImporting(doc: vscode.TextDocument): boolean { return this.importing.has(doc.uri.toString()); }
  isUpdating(doc: vscode.TextDocument): boolean {
    const key = this.host.transcript?.key(doc.uri);
    return this.updating.has(doc.uri.toString()) || !!key && this.pending.has(key);
  }
  async focus(editor: vscode.TextEditor): Promise<void> {
    const region = this.region(editor.document);
    if (!region) throw new Error('草稿分隔线被修改，请使用“QQ: 重建聊天文档”（恢复已缓存草稿）');
    const end = editor.document.positionAt(editor.document.getText().length);
    editor.selection = new vscode.Selection(end, end);
    editor.revealRange(new vscode.Range(end, end)); this.updateContext();
  }
  draft(doc: vscode.TextDocument): string {
    const region = this.region(doc);
    if (!region) throw new Error('草稿分隔线被修改，发送已暂停。请使用“QQ: 重建聊天文档”恢复');
    return region.text;
  }
  async insert(key: string, attachments: Attachment[]): Promise<void> {
    const store = this.host.store; if (!store) return;
    const editor = vscode.window.visibleTextEditors.find(e => this.host.transcript?.key(e.document.uri) === key);
    if (!editor) { store.attach(key, attachments); return; }
    await this.sync(editor, false);
    if (store !== this.host.store || this.host.transcript?.key(editor.document.uri) !== key) return;
    const region = this.region(editor.document);
    if (!region) throw new Error('请先重建聊天文档，再导入图片或表情');
    const prepared = store.prepareAttachments(key, attachments);
    const selection = this.inDraft(editor) ? editor.selection : new vscode.Selection(editor.document.positionAt(editor.document.getText().length), editor.document.positionAt(editor.document.getText().length));
    const applied = await editor.edit(edit => edit.replace(selection, prepared.map(a => a.placeholder).join('')));
    if (!applied) throw new Error('文档在导入时发生变化，请重试');
    if (vscode.window.activeTextEditor?.document !== editor.document || vscode.window.activeTextEditor?.viewColumn !== editor.viewColumn) {
      await vscode.window.showTextDocument(editor.document, editor.viewColumn);
    }
    this.updateContext();
  }
  private attachmentAt(doc: vscode.TextDocument, pos: vscode.Position): { attachment: Attachment; range: vscode.Range } | undefined {
    const key = this.host.transcript?.key(doc.uri), region = this.region(doc);
    if (!key || !region || doc.offsetAt(pos) < region.start) return;
    for (const match of region.text.matchAll(attachmentPattern)) {
      const start = region.start + match.index!;
      const range = new vscode.Range(doc.positionAt(start), doc.positionAt(start + match[0].length));
      const attachment = this.host.store?.draft(key).attachments.find(a => a.placeholder === match[0]);
      if (range.contains(pos) && attachment) return { attachment, range };
    }
  }
  async hover(doc: vscode.TextDocument, pos: vscode.Position): Promise<vscode.Hover | undefined> {
    const key = this.host.transcript?.key(doc.uri), region = this.region(doc), draft = key ? this.host.store?.draft(key) : undefined;
    if (key && region && draft?.replyPlaceholder && draft.replyId) {
      const index = region.text.indexOf(draft.replyPlaceholder);
      const range = new vscode.Range(doc.positionAt(region.start + index), doc.positionAt(region.start + index + draft.replyPlaceholder.length));
      if (index >= 0 && range.contains(pos)) {
        const target = this.host.store!.displayMessages(key).find(m => m.id === draft.replyId);
        const md = new vscode.MarkdownString(); md.supportHtml = true;
        md.appendText(target ? `${inline(target.senderName)}：${messageText(target).slice(0, 500)}` : `回复消息 ${draft.replyId}`);
        for (let index = 0; index < Math.min(2, target?.segments.filter(s => s.type === 'image').length ?? 0); index++) {
          try {
            const file = await this.host.transcript!.image(doc.uri, draft.replyId, index);
            if (this.host.transcript?.key(doc.uri) !== key) return;
            md.appendMarkdown('\n\n' + (await imagePreviewMarkup(file, doc)));
          } catch { md.appendText('\n[图片预览暂不可用]'); }
        }
        return new vscode.Hover(md, range);
      }
    }
    const item = this.attachmentAt(doc, pos); if (!item) return;
    const md = new vscode.MarkdownString(); md.appendText(item.attachment.label);
    if (item.attachment.kind === 'image' && this.host.attachments && item.attachment.file) {
      const file = await this.host.attachments.filePath(item.attachment);
      md.supportHtml = true;
      md.appendMarkdown(`\n\n${await imagePreviewMarkup(file, doc)}`);
    }
    if (item.attachment.kind === 'file') md.appendText(`\n大小：${(item.attachment.size ?? 0).toLocaleString()} 字节`);
    return new vscode.Hover(md, item.range);
  }
  links(doc: vscode.TextDocument): vscode.DocumentLink[] {
    const region = this.region(doc); if (!region) return [];
    const result: vscode.DocumentLink[] = [];
    const key = this.host.transcript?.key(doc.uri), draft = key ? this.host.store?.draft(key) : undefined;
    if (draft?.replyPlaceholder && draft.replyId) {
      const index = region.text.indexOf(draft.replyPlaceholder);
      if (index >= 0) {
        const range = new vscode.Range(doc.positionAt(region.start + index), doc.positionAt(region.start + index + draft.replyPlaceholder.length));
        const link = new vscode.DocumentLink(range, vscode.Uri.parse(`command:qq.cancelReply?${encodeURIComponent(JSON.stringify([doc.uri.toString(), draft.replyPlaceholder]))}`));
        link.tooltip = '取消回复'; result.push(link);
      }
    }
    for (const match of region.text.matchAll(/\[(?:图片|视频):\d+\]/g)) {
      const item = this.attachmentAt(doc, doc.positionAt(region.start + match.index!));
      if (item?.attachment.file) {
        const command = item.attachment.kind === 'video' ? 'qq.openDraftVideo' : 'qq.openDraftImage';
        const link = new vscode.DocumentLink(item.range, vscode.Uri.parse(`command:${command}?${encodeURIComponent(JSON.stringify([doc.uri.toString(), item.attachment.id]))}`));
        link.tooltip = item.attachment.kind === 'video' ? '打开待发送视频' : '预览待发送图片'; result.push(link);
      }
    }
    return result;
  }
  private beginImport(doc: vscode.TextDocument, key: string) {
    const uri = doc.uri.toString();
    if (this.importing.has(uri)) throw new Error('请等待当前附件导入完成');
    const operation: { placeholders?: string[] } = {};
    this.importing.set(uri, operation);
    return {
      operation,
      finish: () => {
        // Keep history stable until VS Code applies the returned paste/drop edit.
        const timer = setTimeout(() => {
          this.importTimers.delete(timer);
          if (this.importing.get(uri) === operation) { this.importing.delete(uri); this.schedule(key, true); }
        }, 250);
        this.importTimers.add(timer);
      }
    };
  }
  async prepareCopy(doc: vscode.TextDocument, ranges: readonly vscode.Range[], data: vscode.DataTransfer, token: vscode.CancellationToken): Promise<void> {
    const store = this.host.store, key = this.host.transcript?.key(doc.uri);
    if (!store || !key || token.isCancellationRequested) return;
    const region = this.region(doc), candidates: ResourceSpan[] = [];
    const draft = store.draft(key);
    if (region) {
      for (const match of region.text.matchAll(attachmentPattern)) {
        const attachment = draft.attachments.find(a => a.placeholder === match[0]);
        if (attachment) candidates.push({ start: region.start + match.index!, end: region.start + match.index! + match[0].length, identity: `attachment:${attachment.id}`, resource: { kind: 'attachment', attachment } });
      }
      for (const match of region.text.matchAll(mentionPattern)) {
        const qq = match[1] || draft.mentions?.[match[0]];
        if (qq) candidates.push({ start: region.start + match.index!, end: region.start + match.index! + match[0].length, identity: `mention:${qq}`, resource: { kind: 'mention', qq, name: match[0].startsWith('[@:') ? match[0].slice(3, -1) : qq } });
      }
    }
    if (this.historyMatches(doc)) {
      const rendered = this.host.transcript?.rendered.get(key);
      for (const span of rendered?.images ?? []) {
        const message = store.messages.get(key)?.find(m => m.id === span.messageId);
        const image = message?.segments.filter(s => s.type === 'image')[span.imageIndex];
        if (image?.type === 'image') candidates.push({ start: doc.offsetAt(new vscode.Position(span.line, span.start)), end: doc.offsetAt(new vscode.Position(span.line, span.end)), identity: `image:${span.messageId}:${span.imageIndex}`, resource: { kind: 'image', image: image.image, local: message?.localImages?.[span.imageIndex] } });
      }
      for (const span of rendered?.videos ?? []) {
        const message = store.messages.get(key)?.find(m => m.id === span.messageId);
        const video = message?.segments.filter(s => s.type === 'video')[span.videoIndex];
        if (video?.type === 'video') candidates.push({ start: doc.offsetAt(new vscode.Position(span.line, span.start)), end: doc.offsetAt(new vscode.Position(span.line, span.end)), identity: `video:${span.messageId}:${span.videoIndex}`, resource: { kind: 'video', video: video.video, local: message?.localVideos?.[span.videoIndex] } });
      }
      for (const span of rendered?.files ?? []) {
        const message = store.messages.get(key)?.find(m => m.id === span.messageId);
        const file = message?.segments.filter(s => s.type === 'file')[span.fileIndex];
        if (file?.type === 'file') {
          const local = message?.outgoing?.attachments.filter(a => a.kind === 'file')[span.fileIndex];
          candidates.push({ start: doc.offsetAt(new vscode.Position(span.line, span.start)), end: doc.offsetAt(new vscode.Position(span.line, span.end)), identity: `file:${span.messageId}:${span.fileIndex}`, resource: local ? { kind: 'attachment', attachment: local } : { kind: 'file', file: file.file, key } });
        }
      }
      for (const span of rendered?.mentions ?? []) {
        const start = doc.offsetAt(new vscode.Position(span.line, span.start)), end = doc.offsetAt(new vscode.Position(span.line, span.end));
        if (doc.getText(new vscode.Range(doc.positionAt(start), doc.positionAt(end))).startsWith('[@:')) candidates.push({ start, end, identity: `mention:${span.qq}`, resource: { kind: 'mention', qq: span.qq, name: span.name } });
      }
    }
    let text = ''; const spans: ResourceSpan[] = [];
    for (const range of ranges) {
      if (text) text += '\n';
      const from = doc.offsetAt(range.start), to = doc.offsetAt(range.end), offset = text.length;
      text += doc.getText(range);
      for (const span of candidates) if (span.start >= from && span.end <= to) spans.push({ ...span, start: offset + span.start - from, end: offset + span.end - from });
    }
    if (!spans.length || token.isCancellationRequested) return;
    const handle = this.clipboard.put({ account: store.selfId, key, text, spans: spans.sort((a, b) => a.start - b.start) });
    data.set(RESOURCE_MIME, new vscode.DataTransferItem(handle));
  }
  private async pasteResources(doc: vscode.TextDocument, range: vscode.Range, data: vscode.DataTransfer, token: vscode.CancellationToken): Promise<vscode.DocumentPasteEdit[] | undefined> {
    const store = this.host.store, key = this.host.transcript?.key(doc.uri), files = this.host.attachments, region = this.region(doc);
    if (!store || !key || !files || !region) return;
    const handle = await data.get(RESOURCE_MIME)?.asString(), text = await data.get('text/plain')?.asString();
    const copy = handle && text !== undefined ? this.clipboard.get(handle, store.selfId, text) : undefined;
    if (!copy) throw new Error('复制的 QQ 资源已失效或不属于当前账号，请重新复制');
    const version = doc.version, { operation, finish } = this.beginImport(doc, key);
    const staged: Attachment[] = [], attachments = new Map<string, Attachment>(), replacements = new Map<string, string>();
    const check = () => { if (token.isCancellationRequested || store !== this.host.store || doc.version !== version || doc.isClosed) throw new Error('粘贴已取消或草稿发生变化，请重新粘贴'); };
    try {
      for (const span of copy.spans) {
        check(); if (attachments.has(span.identity) || span.resource.kind === 'mention') continue;
        const source = span.resource.kind === 'attachment' ? span.resource.attachment : span.resource.kind === 'file' ? undefined : span.resource.local;
        let attachment: Attachment;
        if (source?.kind === 'face') attachment = { ...source, id: randomUUID(), placeholder: undefined };
        else if (source?.kind === 'video') attachment = await files.stageAutoPath(await files.filePath(source), source.label);
        else if (source?.kind === 'file') attachment = await files.stageFilePath(await files.filePath(source), source.label);
        else if (source) attachment = await files.stage(await files.read(source), source.label, source.sticker);
        else if (span.resource.kind === 'image' && this.host.transcript) {
          const image = await this.host.transcript.media.get(span.resource.image); check();
          attachment = await files.stage(await fs.readFile(image), '复制的图片');
        } else if (span.resource.kind === 'video' && this.host.transcript) {
          const video = await this.host.transcript.media.getVideo(span.resource.video); check();
          attachment = await files.stageAutoPath(video, span.resource.video.name || '复制的视频' + path.extname(video));
        } else if (span.resource.kind === 'file' && this.host.transcript) {
          const file = await this.host.transcript.media.getFile(span.resource.file, span.resource.key); check();
          attachment = await files.stageFilePath(file, span.resource.file.name);
        } else throw new Error('复制的附件已不可用，请重新复制');
        staged.push(attachment); attachments.set(span.identity, attachment);
      }
      check();
      const prepared = staged.length ? store.prepareAttachments(key, staged) : [];
      const identities = [...attachments.keys()];
      for (let i = 0; i < prepared.length; i++) replacements.set(identities[i], prepared[i].placeholder!);
      for (const span of copy.spans) if (span.resource.kind === 'mention' && !replacements.has(span.identity)) {
        replacements.set(span.identity, key === copy.key ? store.reserveMention(key, span.resource.qq, span.resource.name) : '@' + span.resource.name);
      }
      let result = copy.text;
      for (const span of [...copy.spans].sort((a, b) => b.start - a.start)) result = result.slice(0, span.start) + replacements.get(span.identity)! + result.slice(span.end);
      operation.placeholders = prepared.map(a => a.placeholder!);
      return [new vscode.DocumentPasteEdit(result, '粘贴 QQ 资源', vscode.DocumentDropOrPasteEditKind.Empty.append('qq', 'resources'))];
    } catch (error) { await files.discard(staged); throw error; }
    finally { finish(); }
  }
  private async importTransfer(doc: vscode.TextDocument, range: vscode.Range, data: vscode.DataTransfer, token: vscode.CancellationToken): Promise<{ text: string; image: boolean } | undefined> {
    const key = this.host.transcript?.key(doc.uri), region = this.region(doc), store = this.host.store, files = this.host.attachments;
    if (!key || !region || !store || !files || doc.offsetAt(range.start) < region.start) return;
    const version = doc.version, { operation, finish } = this.beginImport(doc, key);
    let attachments: Attachment[] = [];
    try {
      const check = () => { if (token.isCancellationRequested || store !== this.host.store || doc.version !== version || doc.isClosed) throw new Error('导入已取消或草稿发生变化，请重新导入'); };
      attachments = await transferFiles(data, files, this.host.transcript?.media, check);
      if (!attachments.length) return;
      check();
      const prepared = store.prepareAttachments(key, attachments);
      operation.placeholders = prepared.map(a => a.placeholder!);
      return { text: prepared.map(a => a.placeholder).join(''), image: prepared.every(a => a.kind === 'image') };
    } catch (error) { await files.discard(attachments); if (token.isCancellationRequested) return; throw error; }
    finally { finish(); }
  }
  async drop(doc: vscode.TextDocument, position: vscode.Position, data: vscode.DataTransfer, token: vscode.CancellationToken): Promise<vscode.DocumentDropEdit | undefined> {
    const imported = await this.importTransfer(doc, new vscode.Range(position, position), data, token);
    if (imported) return new vscode.DocumentDropEdit(imported.text, imported.image ? '插入 QQ 图片' : '插入 QQ 附件', vscode.DocumentDropOrPasteEditKind.Empty.append('qq', imported.image ? 'image' : 'file'));
  }
  async paste(doc: vscode.TextDocument, ranges: readonly vscode.Range[], data: vscode.DataTransfer, token: vscode.CancellationToken): Promise<vscode.DocumentPasteEdit[] | undefined> {
    const region = this.region(doc);
    if (!region || ranges.some(r => doc.offsetAt(r.start) < region.start)) return;
    if (ranges.length !== 1) return;
    try {
      if (data.get(RESOURCE_MIME)) return await this.pasteResources(doc, ranges[0], data, token);
      const imported = await this.importTransfer(doc, ranges[0], data, token);
      if (imported) return [new vscode.DocumentPasteEdit(imported.text, imported.image ? '作为 QQ 图片粘贴' : '作为 QQ 附件粘贴', vscode.DocumentDropOrPasteEditKind.Empty.append('qq', imported.image ? 'image' : 'file'))];
    } catch (error) {
      if (token.isCancellationRequested) return;
      void vscode.window.showErrorMessage(`粘贴失败：${error instanceof Error ? error.message : String(error)}`);
      // Throwing lets VS Code choose its plain text/path edit. Return an unchanged
      // selection instead, so a failed import cannot replace a draft with a path.
      return [new vscode.DocumentPasteEdit(doc.getText(ranges[0]), '保留草稿', vscode.DocumentDropOrPasteEditKind.Empty.append('qq', 'resources'))];
    }
  }

  release(doc: vscode.TextDocument): void {
    const uri = doc.uri.toString();
    clearTimeout(this.saveTimers.get(uri)); this.saveTimers.delete(uri);
    this.buffers.delete(uri); this.prefixes.delete(uri); this.expectedEdits.delete(uri); this.repairs.delete(uri);
  }
  reset(): void {
    clearTimeout(this.timer); this.timer = undefined; this.pending.clear();
    for (const timer of this.saveTimers.values()) clearTimeout(timer);
    for (const timer of this.importTimers) clearTimeout(timer);
    this.saveTimers.clear(); this.importTimers.clear(); this.importing.clear();
    this.buffers.clear(); this.prefixes.clear(); this.expectedEdits.clear(); this.repairs.clear();
  }
  dispose(): void { this.clipboard.clear(); this.reset(); this.events.dispose(); }
}
