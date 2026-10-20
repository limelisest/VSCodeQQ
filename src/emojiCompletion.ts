import * as vscode from 'vscode';
import type { QQApp } from './extension';
import type { SlashInvocation } from './slashCommands';

export class EmojiCompletion implements vscode.CompletionItemProvider {
  constructor(private app: QQApp) {}
  provideCompletionItems(doc: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): vscode.CompletionItem[] {
    const region = this.app.native.region(doc);
    if (token.isCancellationRequested || !region || doc.offsetAt(position) < region.start) return [];
    const before = doc.lineAt(position.line).text.slice(0, position.character);
    const match = /([!！])([^!！\s]*)$/.exec(before);
    if (!match || !'表情'.startsWith(match[2]) || doc.offsetAt(new vscode.Position(position.line, match.index)) < region.start) return [];
    const invocation = this.app.slash.capture(doc.uri); if (!invocation) return [];
    const label = match[1] + '表情';
    const item = new vscode.CompletionItem({ label, description: '打开表情面板' }, vscode.CompletionItemKind.Function);
    item.range = new vscode.Range(position.line, match.index, position.line, position.character);
    // Accepting the candidate consumes only the trigger text; surrounding draft stays intact.
    item.insertText = ''; item.filterText = label;
    item.command = { command: 'qq.openEmojiPicker', title: '打开表情面板', arguments: [invocation] };
    return [item];
  }
  async open(invocation: SlashInvocation): Promise<void> {
    const store = this.app.store, editor = vscode.window.activeTextEditor;
    const key = editor && this.app.transcript?.key(editor.document.uri);
    if (!store || !key || this.app.session.generation !== invocation.generation || store.selfId !== invocation.account || editor?.document.uri.toString() !== invocation.uri) throw new Error('会话或连接已变化，请重新选择表情');
    this.app.target = key;
    await this.app.emojis.showEmojis(true);
  }
}
