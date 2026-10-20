import { Rendered, Span, renderTranscript } from './transcriptRenderer';
import * as vscode from 'vscode';
import { ChatStore } from './store';
import { MediaCache } from './media';
import { AttachmentFiles } from './attachments';
import { imagePreviewMarkup } from './imageHover';
import { configuredCodeLanguage } from './configuration';
import { Chat, Message, splitKey } from './model';

export class Transcript implements vscode.DocumentLinkProvider, vscode.HoverProvider, vscode.Disposable {
  readonly historyState = new Map<string, string>();
  readonly rendered = new Map<string, Rendered>();
  private uris = new Map<string, vscode.Uri>();
  private linkCache = new Map<string, { rendered: Rendered; links: vscode.DocumentLink[] }>();
  constructor(readonly store: ChatStore, readonly media: MediaCache, private attachments?: AttachmentFiles) {}
  uri(chat: Chat): vscode.Uri {
    let value = this.uris.get(chat.key);
    if (!value) {
      const name = chat.name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
      value = vscode.Uri.from({ scheme: 'qqchat', authority: this.store.selfId, path: `/${chat.type}/${chat.id}/${name}.qqchat` });
      this.uris.set(chat.key, value);
    }
    return value;
  }
  key(uri: vscode.Uri): string | undefined {
    if (uri.scheme !== 'qqchat' || uri.authority !== this.store.selfId) return;
    const parts = uri.path.split('/');
    const key = `${parts[1]}:${parts[2]}`;
    try { splitKey(key); return this.store.chats.has(key) ? key : undefined; } catch { return; }
  }
  project(uri: vscode.Uri): { text: string; rendered?: Rendered } {
    const key = this.key(uri); const chat = key && this.store.chats.get(key);
    if (!chat || !key) return { text: '// 当前账号中没有这个会话，请从 QQ 列表重新打开。' };
    this.uris.set(key, uri);
    const content = renderTranscript(chat, this.store.displayMessages(key), this.store.selfId, configuredCodeLanguage());
    const state = this.historyState.get(key);
    return { text: content.text + (state && !this.store.messages.get(key)?.length ? `\n// ${state}\n` : ''), rendered: content };
  }
  provideTextDocumentContent(uri: vscode.Uri): string {
    const projection = this.project(uri), key = this.key(uri);
    if (key && projection.rendered) this.rendered.set(key, projection.rendered);
    return projection.text;
  }
  messageAt(uri: vscode.Uri, line: number): Message | undefined {
    const key = this.key(uri); if (!key) return;
    const id = this.rendered.get(key)?.messages.get(line);
    return this.store.messages.get(key)?.find(m => m.id === id);
  }
  private range(span: { line: number; start: number; end: number }): vscode.Range { return new vscode.Range(span.line, span.start, span.line, span.end); }
  private imageArgs(uri: vscode.Uri, span: Span): unknown[] { return [uri.toString(), span.messageId, span.imageIndex]; }
  private command(uri: vscode.Uri, span: Span): vscode.Uri {
    return vscode.Uri.parse(`command:qq.openImage?${encodeURIComponent(JSON.stringify(this.imageArgs(uri, span)))}`);
  }
  provideDocumentLinks(doc: vscode.TextDocument): vscode.DocumentLink[] {
    const key = this.key(doc.uri); if (!key) return [];
    const rendered = this.rendered.get(key); if (!rendered) return [];
    const cached = this.linkCache.get(doc.uri.toString());
    if (cached?.rendered === rendered) return cached.links;
    const links = (rendered.images ?? []).map(span => {
      const link = new vscode.DocumentLink(this.range(span), this.command(doc.uri, span));
      link.tooltip = '打开图片'; return link;
    });
    for (const span of rendered.replyLinks) {
      const target = vscode.Uri.parse(`command:qq.openReplyOriginal?${encodeURIComponent(JSON.stringify([doc.uri.toString(), span.messageId]))}`);
      const link = new vscode.DocumentLink(this.range(span), target); link.tooltip = '查看原消息'; links.push(link);
    }
    for (const span of this.rendered.get(key)?.videos ?? []) {
      const target = vscode.Uri.parse(`command:qq.openVideo?${encodeURIComponent(JSON.stringify([doc.uri.toString(), span.messageId, span.videoIndex]))}`);
      const link = new vscode.DocumentLink(this.range(span), target); link.tooltip = '打开视频'; links.push(link);
    }
    for (const span of this.rendered.get(key)?.forwards ?? []) {
      const target = vscode.Uri.parse(`command:qq.openForward?${encodeURIComponent(JSON.stringify([doc.uri.toString(), span.messageId, span.forwardIndex]))}`);
      const link = new vscode.DocumentLink(new vscode.Range(span.line, span.start, span.line, span.end), target);
      link.tooltip = '查看合并转发'; links.push(link);
    }
    for (const span of this.rendered.get(key)?.files ?? []) {
      const target = vscode.Uri.parse(`command:qq.downloadFile?${encodeURIComponent(JSON.stringify([doc.uri.toString(), span.messageId, span.fileIndex]))}`);
      const link = new vscode.DocumentLink(new vscode.Range(span.line, span.start, span.line, span.end), target);
      link.tooltip = '下载文件 / 另存为'; links.push(link);
    }
    for (const span of this.rendered.get(key)?.mentions ?? []) {
      if (span.kind === 'sender') continue; // Native field clicks do not need delayed document-link styling.
      const link = new vscode.DocumentLink(new vscode.Range(span.line, span.start, span.line, span.end), this.mentionCommand(doc.uri, span.qq, span.name));
      link.tooltip = '提及'; links.push(link);
    }
    for (const action of this.rendered.get(key)?.actions ?? []) {
      if (action.kind === 'reply') continue;
      const target = action.kind === 'cancel' ? vscode.Uri.parse(`command:qq.cancelMessage?${encodeURIComponent(JSON.stringify([doc.uri.toString(), action.messageId]))}`) : this.retryCommand(doc.uri, action.messageId);
      const link = new vscode.DocumentLink(new vscode.Range(action.line, action.start, action.line, action.end), target);
      link.tooltip = action.kind === 'cancel' ? '取消发送' : '重试'; links.push(link);
    }
    const identity = (link: vscode.DocumentLink) => JSON.stringify([link.range.start.line, link.range.start.character, link.range.end.line, link.range.end.character, link.target?.toString(), link.tooltip]);
    const previous = new Map(cached?.links.map(link => [identity(link), link]));
    const stable = links.map(link => previous.get(identity(link)) ?? link);
    this.linkCache.set(doc.uri.toString(), { rendered, links: stable });
    return stable;
  }
  private mentionCommand(uri: vscode.Uri, qq: string, name: string): vscode.Uri {
    return vscode.Uri.parse(`command:qq.insertMention?${encodeURIComponent(JSON.stringify([uri.toString(), qq, name]))}`);
  }
  clickCommand(doc: vscode.TextDocument, pos: vscode.Position): vscode.Uri | undefined {
    const key = this.key(doc.uri), content = key && this.rendered.get(key);
    if (!content) return;
    const contains = (span: { line: number; start: number; end: number }) => span.line === pos.line && span.start <= pos.character && pos.character < span.end;
    const reference = content.replyLinks.find(contains);
    if (reference) return vscode.Uri.parse(`command:qq.openReplyOriginal?${encodeURIComponent(JSON.stringify([doc.uri.toString(), reference.messageId]))}`);
    const forward = content.forwards.find(contains);
    if (forward) return vscode.Uri.parse(`command:qq.openForward?${encodeURIComponent(JSON.stringify([doc.uri.toString(), forward.messageId, forward.forwardIndex]))}`);
    const mention = content.mentions.find(contains);
    if (mention) return this.mentionCommand(doc.uri, mention.qq, mention.name);
    const reply = content.actions.find(a => a.kind === 'reply' && contains(a));
    if (reply) return this.replyCommand(doc.uri, reply.messageId);
  }
  private replyCommand(uri: vscode.Uri, messageId: string): vscode.Uri {
    return vscode.Uri.parse(`command:qq.reply?${encodeURIComponent(JSON.stringify([uri.toString(), messageId]))}`);
  }
  private retryCommand(uri: vscode.Uri, messageId: string): vscode.Uri {
    return vscode.Uri.parse(`command:qq.retryMessage?${encodeURIComponent(JSON.stringify([uri.toString(), messageId]))}`);
  }
  async image(uri: vscode.Uri, messageId: string, imageIndex: number): Promise<string> {
    const key = this.key(uri);
    if (!key || !Number.isInteger(imageIndex) || imageIndex < 0) throw new Error('图片不属于当前会话');
    const msg = this.store.messages.get(key)?.find(m => m.id === messageId);
    const local = msg?.localImages?.[imageIndex];
    if (local?.file && this.attachments) {
      try { return await this.attachments.filePath(local); } catch { /* Fall back to server media. */ }
    }
    const segment = msg?.segments.filter(s => s.type === 'image')[imageIndex];
    if (!segment || segment.type !== 'image') throw new Error('图片消息已不在当前记录中');
    return this.media.get(segment.image);
  }
  async provideHover(doc: vscode.TextDocument, pos: vscode.Position, token: vscode.CancellationToken): Promise<vscode.Hover | undefined> {
    const key = this.key(doc.uri); if (!key) return;
    const video = this.rendered.get(key)?.videos.find(span => this.range(span).contains(pos));
    if (video) {
      const md = new vscode.MarkdownString(`[打开视频](command:qq.openVideo?${encodeURIComponent(JSON.stringify([doc.uri.toString(), video.messageId, video.videoIndex]))})`);
      md.isTrusted = { enabledCommands: ['qq.openVideo'] }; return new vscode.Hover(md, this.range(video));
    }
    const mention = this.rendered.get(key)?.mentions.find(s => s.line === pos.line && pos.character >= s.start && pos.character < s.end);
    if (mention) {
      const md = new vscode.MarkdownString(); md.appendText(`@ ${mention.name} · ${mention.qq}`);
      md.appendMarkdown(`\n\n[提及](${this.mentionCommand(doc.uri, mention.qq, mention.name).toString()})`);
      md.isTrusted = { enabledCommands: ['qq.insertMention'] };
      return new vscode.Hover(md, new vscode.Range(mention.line, mention.start, mention.line, mention.end));
    }
    const file = this.rendered.get(key)?.files.find(f => f.line === pos.line && pos.character >= f.start && pos.character <= f.end);
    if (file) {
      const message = this.store.messages.get(key)?.find(m => m.id === file.messageId);
      const ref = message?.segments.filter(s => s.type === 'file')[file.fileIndex];
      const md = new vscode.MarkdownString();
      if (ref?.type === 'file') md.appendText(`${ref.file.name}${ref.file.size ? ` · ${ref.file.size.toLocaleString()} 字节` : ''}`);
      md.appendMarkdown(`\n\n[下载 / 另存为](command:qq.downloadFile?${encodeURIComponent(JSON.stringify([doc.uri.toString(), file.messageId, file.fileIndex]))})`);
      md.isTrusted = { enabledCommands: ['qq.downloadFile'] }; return new vscode.Hover(md);
    }
    const span = this.rendered.get(key)?.images.find(s => this.range(s).contains(pos));
    if (!span) {
      const message = this.messageAt(doc.uri, pos.line);
      if (message?.outgoing && ['failed', 'uncertain'].includes(message.sendState ?? '')) {
        const md = new vscode.MarkdownString(); md.appendText(message.sendError || '发送失败');
        md.appendMarkdown(`\n\n[重试](${this.retryCommand(doc.uri, message.id).toString()})`);
        md.isTrusted = { enabledCommands: ['qq.retryMessage'] }; return new vscode.Hover(md);
      }
      if (message?.recalled) return new vscode.Hover('消息已撤回');
      const action = this.rendered.get(key)?.actions.find(a => a.kind === 'reply' && a.line === pos.line && pos.character >= a.start && pos.character < a.end);
      if (!message || !action) return;
      const md = new vscode.MarkdownString(`[回复](${this.replyCommand(doc.uri, message.id).toString()})`);
      md.isTrusted = { enabledCommands: ['qq.reply'] };
      return new vscode.Hover(md, this.range(action));
    }
    const md = new vscode.MarkdownString();
    md.isTrusted = { enabledCommands: ['qq.openImage', 'qq.insertMessageImage'] };
    try {
      const file = await this.image(doc.uri, span.messageId, span.imageIndex);
      if (token.isCancellationRequested) return;
      md.supportHtml = true;
      md.appendMarkdown((await imagePreviewMarkup(file, doc)) + '\n\n');
    } catch (error: any) { md.appendText(error.message); md.appendMarkdown('\n\n'); }
    const insert = vscode.Uri.parse(`command:qq.insertMessageImage?${encodeURIComponent(JSON.stringify(this.imageArgs(doc.uri, span)))}`);
    md.appendMarkdown(`[打开大图](${this.command(doc.uri, span).toString()}) · [引用](${insert.toString()})`);
    return new vscode.Hover(md, this.range(span));
  }
  dispose(): void { this.linkCache.clear(); this.rendered.clear(); this.uris.clear(); }
}
