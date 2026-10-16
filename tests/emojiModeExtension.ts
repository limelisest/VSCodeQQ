import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import type { QQApp } from '../src/extension';
import { MockNapCat, until } from './fixture';
import { TestUI } from './ui';

export async function testEmojiOpenModes(app: QQApp, backend: MockNapCat, ui: TestUI, checks: string[]): Promise<void> {
  const key = 'group:20002'; await app.openChat(key);
  const editor = vscode.window.activeTextEditor!, store = app.store!, before = backend.sent.length;
  store.setDraft(key, '入口模式测试', undefined, []); await app.native.sync(editor);
  const open = async (action: () => PromiseLike<unknown>) => {
    await action();
    const panel = await ui.webview('#favoriteFaces');
    await until(async () => {
      const ids: string[] = await panel.evaluate(`!document.getElementById('favoriteFaces').hidden && [...document.querySelectorAll('#favoriteFaces img')].every(image => image.complete && image.naturalWidth > 0 && !image.hidden) ? [...document.querySelectorAll('#favoriteFaces button')].map(button => button.dataset.id) : []`);
      return ids.length === 2 && ids.every(id => (app.emojis as any).favoriteSources.has(id));
    });
    await panel.evaluate(`(() => {
      window.__qqSelections = 0;
      if (!window.__qqSelectionListener) {
        window.__qqSelectionListener = true;
        window.addEventListener('message', ({data}) => { if (data.type === 'selectionComplete') window.__qqSelections++; });
      }
    })()`);
    return panel;
  };
  // Editor title buttons pass the current resource URI to their command.
  const manual = () => vscode.commands.executeCommand('qq.emojis', editor.document.uri);
  const slash = () => app.slash.run('emoji', app.slash.capture(editor.document.uri));
  let panel = await open(manual);
  await panel.evaluate(`document.querySelector('#favoriteFaces button').click()`);
  await until(async () => await panel.evaluate(`window.__qqSelections === 1`));
  assert.equal(store.draft(key).attachments.length, 1);
  assert.equal((app.emojis as any).view?.visible, true);
  await panel.evaluate(`document.getElementById('tabRecent').click()`);
  await until(async () => await panel.evaluate(`!!document.querySelector('#recentFaces img')?.naturalWidth`));
  await panel.evaluate(`document.querySelector('#recentFaces img').closest('button').click()`);
  await until(async () => await panel.evaluate(`window.__qqSelections === 2`));
  assert.equal(await panel.evaluate(`document.activeElement === document.querySelector('#recentFaces button')`), true, '最近表情重排后保留键盘焦点');
  await panel.key('Enter', 13);
  await until(async () => await panel.evaluate(`window.__qqSelections === 3`));
  await panel.evaluate(`document.getElementById('tabBasic').click(); document.querySelector('#basicFaces button').click()`);
  await until(async () => await panel.evaluate(`window.__qqSelections === 4`));
  assert.equal(store.draft(key).attachments.length, 4);
  assert.equal((app.emojis as any).view?.visible, true);
  assert.ok(store.draft(key).text.includes('入口模式测试'));
  checks.push('标题栏图标打开时连续插入收藏、最近和 QQ 表情，面板保持展开且草稿保留');

  await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
  panel = await open(slash);
  await panel.evaluate(`document.querySelector('#favoriteFaces button').click()`);
  await until(() => !(app.emojis as any).view?.visible);
  assert.equal(store.draft(key).attachments.length, 5);
  // Replace an already open command-mode panel with the manual entry.
  await open(slash); panel = await open(manual);
  await panel.evaluate(`document.querySelector('#favoriteFaces button').click()`);
  await until(async () => await panel.evaluate(`window.__qqSelections === 1`));
  assert.equal((app.emojis as any).view?.visible, true);
  await panel.key('Escape', 27); await until(() => !(app.emojis as any).view?.visible);
  checks.push('/emoji 插入后收起，图标与指令重新打开时采用本次入口的模式');

  for (const trigger of ['!', '！']) {
    store.setDraft(key, trigger, undefined, []); await app.native.sync(editor);
    const end = editor.document.positionAt(editor.document.getText().length);
    const list = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', editor.document.uri, end, trigger);
    const command = list.items.find(item => item.command?.command === 'qq.openEmojiPicker')!.command!;
    assert.ok(command);
    await editor.edit(edit => edit.delete(new vscode.Range(editor.document.positionAt(app.native.region(editor.document)!.start), end)));
    panel = await open(() => vscode.commands.executeCommand(command.command, ...command.arguments!));
    await panel.evaluate(`document.getElementById('tabBasic').click(); document.querySelector('#basicFaces button').click()`);
    await until(() => !(app.emojis as any).view?.visible);
    assert.equal(store.draft(key).attachments.length, 1);
  }
  assert.equal(backend.sent.length, before, '选择表情只插入草稿，不自动发送');
  store.setDraft(key, '', undefined, []); await app.native.sync(editor);
  checks.push('! / ！补全入口插入后自动收起，两种模式均不自动发送 QQ 消息');
}
