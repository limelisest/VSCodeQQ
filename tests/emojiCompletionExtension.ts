import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import type { QQApp } from '../src/extension';
import { MockNapCat, until } from './fixture';
import { TestUI } from './ui';
const label = (item: vscode.CompletionItem) => typeof item.label === 'string' ? item.label : item.label.label;

export async function testEmojiShortcuts(app: QQApp, backend: MockNapCat, ui: TestUI, checks: string[]): Promise<void> {
  await app.openChat('group:20002');
  const key = 'group:20002', before = backend.sent.length;
  await vscode.commands.executeCommand('workbench.action.closePanel');
  for (const trigger of ['!', '！']) {
    const editor = vscode.window.activeTextEditor!;
    app.store!.setDraft(key, '左边右边', undefined, []);
    await until(() => app.native.draft(editor.document) === '左边右边' && !app.native.isUpdating(editor.document));
    const position = editor.document.positionAt(app.native.region(editor.document)!.start + 2);
    editor.selection = new vscode.Selection(position, position);
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    const beforeFetch = backend.calls.filter(c => c.action === 'fetch_custom_face').length;
    await ui.call('Input.insertText', { text: trigger });
    await until(() => app.native.draft(editor.document) === '左边' + trigger + '右边');
    await ui.waitFor(`!!document.querySelector('.suggest-widget.visible')`);
    const list = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', editor.document.uri, editor.selection.active, trigger, 20);
    const entries = list.items.filter(item => item.command?.command === 'qq.openEmojiPicker');
    assert.equal(entries.length, 1);
    assert.equal(label(entries[0]), trigger + '表情');
    assert.ok(!entries[0].documentation, '补全不能包含表情图片详情');
    assert.equal(backend.calls.filter(c => c.action === 'fetch_custom_face').length, beforeFetch, '候选生成不能提前读取收藏表情');
    assert.equal((app.emojis as any).view?.visible ?? false, false, '只输入触发符不能打开面板');
    await vscode.commands.executeCommand('hideSuggestWidget');
    assert.equal(app.native.draft(editor.document), '左边' + trigger + '右边');
    assert.equal((app.emojis as any).view?.visible ?? false, false, '取消补全不能打开面板');
    await vscode.commands.executeCommand('editor.action.triggerSuggest');
    await ui.waitFor(`document.querySelector('.suggest-widget.visible')?.textContent.includes(${JSON.stringify(trigger + '表情')})`);
    await ui.enter();
    await until(() => (app.emojis as any).view?.visible === true && app.native.draft(editor.document) === '左边右边');
    const panel = await ui.webview();
    await until(async () => await panel.evaluate(`!document.getElementById('favoriteFaces').hidden && document.querySelectorAll('#favoriteFaces button').length === 2 && [...document.querySelectorAll('#favoriteFaces img')].every(i => i.complete && i.naturalWidth > 0 && !i.hidden)`));
    await until(async () => await panel.evaluate(`document.activeElement === document.querySelector('#recentFaces button, #favoriteFaces button')`));
    await panel.key('ArrowRight', 39);
    assert.equal(await panel.evaluate(`document.activeElement === document.querySelectorAll('#recentFaces button, #favoriteFaces button')[1]`), true);
    const selectedId = await panel.evaluate(`document.activeElement.dataset.id`) as string;
    await panel.key('Enter', 13);
    try { await until(() => {
      const attachment = app.store!.draft(key).attachments[0];
      return !!attachment?.placeholder && app.native.draft(editor.document) === `左边${attachment.placeholder}右边` && !(app.emojis as any).view?.visible;
    }); }
    catch (error) {
      console.log('快捷表情插入失败', JSON.stringify({ trigger, draft: app.native.draft(editor.document), stored: app.store!.draft(key).text, visible: (app.emojis as any).view?.visible, selection: editor.selection, focused: await panel.evaluate(`({tag:document.activeElement?.tagName,id:document.activeElement?.dataset.id,parent:document.activeElement?.parentElement?.id,error:document.getElementById('error')?.textContent})`).catch(() => undefined) }));
      throw error;
    }
    const attachment = app.store!.draft(key).attachments.at(-1)!;
    if (selectedId.startsWith('face:')) {
      assert.equal(attachment.kind, 'face'); assert.equal(attachment.faceId, selectedId.slice(5));
    } else { assert.equal(attachment.kind, 'image'); assert.equal(attachment.sticker, true); }
    assert.equal(backend.sent.length, before, '打开面板及选择表情都不能自动发送');
    app.store!.setDraft(key, '', undefined, []);
    await until(() => app.native.draft(editor.document) === '' && !app.native.isUpdating(editor.document));
  }
  const editor = vscode.window.activeTextEditor!;
  app.store!.setDraft(key, '！表情', undefined, []);
  await until(() => app.native.draft(editor.document) === '！表情' && !app.native.isUpdating(editor.document));
  assert.equal((app.emojis as any).view?.visible ?? false, false, '手动输入完整文字不能打开面板');
  const list = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', editor.document.uri, editor.document.positionAt(editor.document.getText().length), '！');
  const invocation = list.items.find(item => item.command?.command === 'qq.openEmojiPicker')!.command!.arguments![0];
  await assert.rejects(app.emojiCompletion.open({ ...invocation, generation: -1 }), /会话或连接/);
  assert.equal((app.emojis as any).view?.visible ?? false, false);
  app.store!.setDraft(key, '!hello', undefined, []);
  await until(() => app.native.draft(editor.document) === '!hello' && !app.native.isUpdating(editor.document));
  const unrelated = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', editor.document.uri, editor.document.positionAt(editor.document.getText().length), '!');
  assert.ok(!unrelated.items.some(item => item.command?.command === 'qq.openEmojiPicker'));
  app.store!.setDraft(key, '', undefined, []);
  checks.push('! / ！仅补全 !表情 / ！表情，选择才打开收藏面板；原生方向键选图、Enter 插入并关闭，保留光标处文字且不发送');
  checks.push('感叹号和手动完整文字不自动打开面板；Esc 取消不打开，候选不加载图片，过期会话不能打开');
}
