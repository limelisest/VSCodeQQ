import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { QQApp } from '../src/extension';
import { parseMessage } from '../src/model';
import { RESOURCE_MIME } from '../src/resourceClipboard';
import { MockNapCat, until, png, widePng, videoBytes } from './fixture';
import { TestUI } from './ui';

export async function testResources(app: QQApp, backend: MockNapCat, ui: TestUI, checks: string[]): Promise<void> {
  const source = 'group:20002', target = 'private:10001', cancellation = new vscode.CancellationTokenSource();
  const sendsBefore = backend.sent.length;
  const paste = async (key: string, data: vscode.DataTransfer) => {
    await app.openChat(key); const editor = vscode.window.activeTextEditor!;
    await until(() => !app.native.isUpdating(editor.document) && !app.native.isImporting(editor.document));
    const position = editor.document.positionAt(editor.document.getText().length);
    const edits = await app.native.paste(editor.document, [new vscode.Range(position, position)], data, cancellation.token);
    assert.ok(edits?.length);
    assert.equal(await editor.edit(edit => edit.insert(position, String(edits![0].insertText))), true);
    await until(() => !app.native.isImporting(editor.document));
    return editor;
  };
  try {
    await app.openChat(source);
    app.store!.setDraft(source, '', undefined, []);
    app.store!.add(parseMessage({ message_id: 99100, user_id: 10001, message: [
      { type: 'image', data: { file: 'first-image', url: backend.imageUrl + '?tall' } },
      { type: 'image', data: { file: 'second-image', url: backend.imageUrl + '?wide' } },
      { type: 'video', data: { file: 'video-resource', name: '示例.mp4', url: backend.imageUrl + '?video' } },
      { type: 'file', data: { file_id: 'resource-file', name: '录音.mp3', url: backend.imageUrl } }
    ] }, source), false);
    let editor = vscode.window.activeTextEditor!; await app.native.sync(editor);
    const image = app.transcript!.rendered.get(source)!.images.find(s => s.messageId === '99100' && s.imageIndex === 1)!;
    const range = new vscode.Range(image.line, image.start, image.line, image.end);
    const copied = new vscode.DataTransfer(); copied.set('text/plain', new vscode.DataTransferItem(editor.document.getText(range)));
    await app.native.prepareCopy(editor.document, [range], copied, cancellation.token);
    assert.ok(copied.get(RESOURCE_MIME));
    app.store!.setDraft(target, '', undefined, []);
    editor = await paste(target, copied);
    const received = app.store!.draft(target).attachments.find(a => a.kind === 'image')!;
    assert.deepEqual(await app.attachments!.read(received), widePng, '复制第二张图片必须保留第二张资源');
    assert.ok(app.native.links(editor.document).some(l => l.target?.path === 'qq.openDraftImage'));
    assert.equal(backend.sent.length, sendsBefore, '复制和粘贴不能发送消息');
    checks.push('历史 [图片] 跨会话复制携带对应资源，重新生成占位符且仍可预览');

    // Verify the registered VS Code copy/paste hooks, not only direct provider calls.
    await app.openChat(source); editor = vscode.window.activeTextEditor!; await app.native.sync(editor);
    editor.selection = new vscode.Selection(range.start, range.end);
    await vscode.commands.executeCommand('editor.action.clipboardCopyAction');
    app.store!.setDraft(target, '', undefined, []); await app.openChat(target);
    editor = vscode.window.activeTextEditor!; await app.native.focus(editor);
    await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
    await until(() => app.store!.draft(target).attachments.some(a => a.kind === 'image') && /\[图片:\d+\]/.test(app.native.draft(editor.document)));
    checks.push('VS Code 原生复制粘贴命令使用资源元数据，不插入裸 [图片]');
    const original = app.store!.draft(target).attachments.at(-1)!;
    const collisionEditor = await paste(target, copied);
    const activeImages = app.store!.draft(target).attachments.filter(a => app.store!.draft(target).text.includes(a.placeholder!));
    assert.equal(activeImages.length, 2); assert.notEqual(activeImages[0].placeholder, activeImages[1].placeholder);
    assert.notEqual(activeImages[0].file, activeImages[1].file);
    assert.equal(activeImages[0].id, original.id);
    assert.equal(app.native.draft(collisionEditor.document), activeImages.map(a => a.placeholder).join(''));


    await app.openChat(source); editor = vscode.window.activeTextEditor!;
    const at = app.store!.reserveMention(source, '10001', '同名用户'); app.store!.setDraft(source, at); await app.native.sync(editor);
    const draftStart = app.native.region(editor.document)!.start;
    const atRange = new vscode.Range(editor.document.positionAt(draftStart), editor.document.positionAt(draftStart + at.length));
    const atData = new vscode.DataTransfer(); atData.set('text/plain', new vscode.DataTransferItem(at));
    await app.native.prepareCopy(editor.document, [atRange], atData, cancellation.token);
    app.store!.setDraft(source, '', undefined, []); await paste(source, atData);
    assert.equal(app.store!.draft(source).mentions?.[app.store!.draft(source).text], '10001');
    app.store!.setDraft(target, '', undefined, []); await paste(target, atData);
    assert.equal(app.store!.draft(target).text, '@同名用户');
    checks.push('@ 在原会话粘贴保留 QQ 绑定，跨会话转成普通文字');

    await app.openChat(source); editor = vscode.window.activeTextEditor!; await app.native.sync(editor);
    const video = app.transcript!.rendered.get(source)!.videos.find(v => v.messageId === '99100' && editor.document.lineAt(v.line).text.includes('video_1'))!;
    const videoRange = new vscode.Range(video.line, video.start, video.line, video.end);
    const videoData = new vscode.DataTransfer(); videoData.set('text/plain', new vscode.DataTransferItem(editor.document.getText(videoRange)));
    await app.native.prepareCopy(editor.document, [videoRange], videoData, cancellation.token);
    app.store!.setDraft(target, '', undefined, []); editor = await paste(target, videoData);
    assert.ok(app.native.links(editor.document).some(l => l.target?.path === 'qq.openDraftVideo'));
    const links = await vscode.commands.executeCommand<vscode.DocumentLink[]>('vscode.executeLinkProvider', app.transcript!.uri(app.store!.chats.get(source)!));
    assert.ok(links.some(l => l.target?.path === 'qq.openVideo'));
    assert.equal(await app.sendMessage(target, app.store!.draft(target).text), true);
    const segment = backend.sent.at(-1).message.find((s: any) => s.type === 'video');
    assert.ok(segment); assert.deepEqual(backend.uploadedBytes.get(segment.data.file), videoBytes);
    checks.push('视频显示链接并可跨会话复制成 [视频:n]，实际按 video 段上传发送');

    await app.openChat(source); editor = vscode.window.activeTextEditor!; await app.native.sync(editor);
    const sourceView = app.transcript!.rendered.get(source)!;
    assert.ok(editor.document.getText().includes('char *video_1 = "[视频:示例.mp4]";'));
    const file = sourceView.files.find(f => f.messageId === '99100' && editor.document.lineAt(f.line).text.includes('file_1'))!;
    const fileRange = new vscode.Range(file.line, file.start, file.line, file.end);
    const fileData = new vscode.DataTransfer(); fileData.set('text/plain', new vscode.DataTransferItem(editor.document.getText(fileRange)));
    await app.native.prepareCopy(editor.document, [fileRange], fileData, cancellation.token);
    app.store!.setDraft(target, '', undefined, []); await paste(target, fileData);
    const importedFile = app.store!.draft(target).attachments.at(-1)!;
    assert.equal(importedFile.kind, 'file'); assert.equal(importedFile.label, '录音.mp3');
    assert.deepEqual(await app.attachments!.read(importedFile), png);
    checks.push('视频和文件的详情显示为指针变量，复制历史文件资源仍保留原名及文件发送类型');

    app.store!.setDraft(target, '', undefined, []); await app.openChat(target); editor = vscode.window.activeTextEditor!;
    await until(() => !app.native.isUpdating(editor.document) && !app.native.isImporting(editor.document));
    const sourceFile = path.join(app.store!.folder, 'external-picture.tmp'); await fs.writeFile(sourceFile, png);
    const external = new vscode.DataTransfer(); external.set('text/plain', new vscode.DataTransferItem('"' + sourceFile + '"'));
    editor = await paste(target, external);
    assert.equal(app.store!.draft(target).attachments.at(-1)!.kind, 'image');
    assert.ok(!app.store!.draft(target).text.includes(sourceFile));
    checks.push('外部应用提供的图片路径按文件头识别为图片，不粘贴路径文字');
    app.store!.setDraft(target, '', undefined, []); await app.native.sync(editor);
    await until(() => !app.native.isUpdating(editor.document));
    const ordinary = new vscode.DataTransfer(); ordinary.set('text/plain', new vscode.DataTransferItem('/help'));
    const end = editor.document.positionAt(editor.document.getText().length);
    assert.equal(await app.native.paste(editor.document, [new vscode.Range(end, end)], ordinary, cancellation.token), undefined);
    await until(() => !app.native.isImporting(editor.document));
    const dropData = new vscode.DataTransfer(); dropData.set('text/uri-list', new vscode.DataTransferItem(vscode.Uri.file(sourceFile).toString()));
    const dropped = await app.native.drop(editor.document, end, dropData, cancellation.token);
    assert.match(String(dropped!.insertText), /^\[图片:\d+\]$/);
    assert.equal(await editor.edit(edit => edit.insert(end, String(dropped!.insertText))), true);
    await until(() => !app.native.isImporting(editor.document));
    app.store!.setDraft(target, '/', undefined, []); await app.native.sync(editor);
    const completions = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', editor.document.uri, editor.document.positionAt(editor.document.getText().length), '/');
    assert.ok(completions.items.some(item => (typeof item.label === 'string' ? item.label : item.label.label).includes('/video')));
    checks.push('外部图片拖放生成图片占位符，普通 /help 粘贴保持文本，/video 提供原生补全');
    await fs.unlink(sourceFile);
  } finally {
    cancellation.dispose(); app.store!.setDraft(source, '', undefined, []); app.store!.setDraft(target, '', undefined, []);
  }
}
