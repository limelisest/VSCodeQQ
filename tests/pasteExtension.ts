import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { QQApp } from '../src/extension';
import { MockNapCat, png, until } from './fixture';
import { TestUI } from './ui';

export async function testPaste(app: QQApp, backend: MockNapCat, ui: TestUI, checks: string[]): Promise<void> {
  const key = 'private:10001', folder = path.join(app.store!.folder, 'paste-fixtures');
  await fs.mkdir(folder, { recursive: true });
  const present = path.join(folder, '图片 with spaces.png'), missing = path.join(folder, 'missing.png');
  await fs.writeFile(present, png);
  const beforeSends = backend.sent.length, cancellation = new vscode.CancellationTokenSource();
  const reset = async (text = '') => {
    await app.openChat(key);
    const editor = vscode.window.activeTextEditor!;
    await until(() => !app.native.isImporting(editor.document) && !app.native.isUpdating(editor.document));
    app.store!.setDraft(key, text, undefined, []);
    await app.native.sync(editor); await app.native.focus(editor);
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    await ui.waitFor(`document.activeElement?.classList.contains('inputarea')`);
    return editor;
  };
  const imageItem = (uri?: vscode.Uri): vscode.DataTransferItem => ({
    asFile: () => ({ name: 'clipboard.png', uri, data: async () => png }),
    asString: async () => ''
  }) as unknown as vscode.DataTransferItem;
  const importData = async (data: vscode.DataTransfer, expected = png) => {
    const editor = await reset(), pos = editor.selection.active;
    const edits = await app.native.paste(editor.document, [new vscode.Range(pos, pos)], data, cancellation.token);
    assert.ok(edits?.length);
    assert.equal(await editor.edit(edit => edit.insert(pos, String(edits[0].insertText))), true);
    await until(() => !app.native.isImporting(editor.document));
    const draft = app.store!.draft(key);
    assert.match(draft.text, /^\[图片:\d+\]$/);
    assert.equal(draft.attachments.length, 1);
    assert.deepEqual(await app.attachments!.read(draft.attachments[0]), expected);
  };
  try {
    // Exercise VS Code's real paste provider selection and plain-path fallback.
    // The DOM clipboard payload is synthetic; editor and extension hooks are real.
    let editor = await reset();
    await ui.evaluate(`(() => {
      const data = new DataTransfer();
      data.setData('text/plain', ${JSON.stringify(missing)});
      data.setData('text/uri-list', ${JSON.stringify(vscode.Uri.file(missing).toString())});
      data.items.add(new File([Uint8Array.from(atob(${JSON.stringify(png.toString('base64'))}), c => c.charCodeAt(0))], 'clipboard.png', { type: 'image/png' }));
      document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    })()`);
    await until(() => !!app.native.draft(editor.document));
    assert.match(app.native.draft(editor.document), /^\[图片:\d+\]$/, '失效路径不能抢占剪贴板中的图片数据');
    assert.equal(app.store!.draft(key).attachments.length, 1);
    assert.deepEqual(await app.attachments!.read(app.store!.draft(key).attachments[0]), png);
    checks.push('注册的粘贴处理器在临时路径失效时使用图片数据，不回退成路径');

    const duplicate = new vscode.DataTransfer();
    duplicate.set('text/uri-list', new vscode.DataTransferItem(vscode.Uri.file(present).toString()));
    duplicate.set('image/png', imageItem());
    await importData(duplicate);
    checks.push('图片路径和图片数据并存时只插入一次');

    const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
    const gifPath = path.join(folder, 'original.gif'); await fs.writeFile(gifPath, gif);
    duplicate.set('text/uri-list', new vscode.DataTransferItem(vscode.Uri.file(gifPath).toString()));
    await importData(duplicate, gif);
    checks.push('GIF 原文件可读取时保留原始文件，不被剪贴板 PNG 替换');

    const fileWithUri = new vscode.DataTransfer();
    fileWithUri.set('image/png', imageItem(vscode.Uri.file(missing)));
    await importData(fileWithUri);
    checks.push('剪贴板文件 URI 不可读时使用文件数据');

    const unavailableFile = new vscode.DataTransfer();
    unavailableFile.set('application/octet-stream', {
      asFile: () => ({ name: 'missing.png', uri: vscode.Uri.file(missing), data: async () => { throw new Error('file no longer available'); } }),
      asString: async () => ''
    } as unknown as vscode.DataTransferItem);
    unavailableFile.set('image/png', imageItem());
    await importData(unavailableFile);
    checks.push('剪贴板文件项失效时仍能使用独立的 PNG 数据');

    const html = new vscode.DataTransfer();
    html.set('text/plain', new vscode.DataTransferItem(present));
    html.set('text/html', new vscode.DataTransferItem(`<img src="${vscode.Uri.file(present)}">`));
    await importData(html);
    const htmlOnly = new vscode.DataTransfer();
    htmlOnly.set('text/html', html.get('text/html')!); await importData(htmlOnly);
    checks.push('HTML 本地图片和带空格中文路径均可粘贴为图片');

    editor = await reset('保留草稿');
    const multiple = new vscode.DataTransfer();
    multiple.set('text/uri-list', new vscode.DataTransferItem([present, missing].map(file => vscode.Uri.file(file).toString()).join('\r\n')));
    multiple.set('image/png', imageItem());
    const cached = new Set(await fs.readdir(app.attachments!.folder)), pos = editor.selection.active;
    const failed = await app.native.paste(editor.document, [new vscode.Range(pos, pos)], multiple, cancellation.token);
    assert.equal(failed?.[0].insertText, '');
    assert.equal(app.native.draft(editor.document), '保留草稿');
    assert.equal(app.store!.draft(key).attachments.length, 0);
    assert.deepEqual(new Set(await fs.readdir(app.attachments!.folder)), cached);
    await ui.waitFor(`document.body.textContent.includes('粘贴失败')`);
    await vscode.commands.executeCommand('notifications.clearAll');
    checks.push('多文件粘贴部分失败时清理已暂存文件，不以一张图片替代整个列表');

    editor = await reset('保留草稿');
    const region = app.native.region(editor.document)!;
    editor.selection = new vscode.Selection(editor.document.positionAt(region.start), editor.document.positionAt(editor.document.getText().length));
    const cacheBefore = new Set(await fs.readdir(app.attachments!.folder));
    await vscode.env.clipboard.writeText(missing);
    await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
    await ui.waitFor(`document.body.textContent.includes('粘贴失败')`);
    assert.equal(app.native.draft(editor.document), '保留草稿', '失败不能以路径替换选中的草稿');
    assert.equal(app.store!.draft(key).attachments.length, 0);
    assert.deepEqual(new Set(await fs.readdir(app.attachments!.folder)), cacheBefore);
    await vscode.commands.executeCommand('notifications.clearAll');
    checks.push('原生粘贴遇到失效图片路径时提示失败，保留选中文字和附件缓存');

    for (const value of [present, '/help', '普通文字']) {
      editor = await reset();
      await vscode.env.clipboard.writeText(value);
      await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
      await until(() => !!app.native.draft(editor.document));
      if (value === present) {
        assert.match(app.native.draft(editor.document), /^\[图片:\d+\]$/);
        assert.deepEqual(await app.attachments!.read(app.store!.draft(key).attachments[0]), png);
      } else assert.equal(app.native.draft(editor.document), value);
    }
    checks.push('原生粘贴正常图片路径生成图片，普通文字和指令保持文本');

    editor = await reset('保留草稿');
    const cancel = new vscode.CancellationTokenSource(), slow = new vscode.DataTransfer();
    slow.set('text/uri-list', new vscode.DataTransferItem(vscode.Uri.file(missing).toString()));
    slow.set('image/png', {
      asFile: () => ({ name: 'cancel.png', data: async () => { cancel.cancel(); return png; } }),
      asString: async () => ''
    } as unknown as vscode.DataTransferItem);
    const beforeCancel = new Set(await fs.readdir(app.attachments!.folder)), end = editor.selection.active;
    assert.equal(await app.native.paste(editor.document, [new vscode.Range(end, end)], slow, cancel.token), undefined);
    assert.equal(app.native.draft(editor.document), '保留草稿');
    assert.deepEqual(new Set(await fs.readdir(app.attachments!.folder)), beforeCancel);
    cancel.dispose();
    checks.push('图片数据回退期间取消粘贴会清理临时文件并保留草稿');
    assert.equal(backend.sent.length, beforeSends);
  } finally {
    cancellation.dispose(); app.store!.setDraft(key, '', undefined, []);
    await fs.rm(folder, { recursive: true, force: true });
  }
}
