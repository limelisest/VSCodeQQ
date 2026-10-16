import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import type { QQApp } from '../src/extension';
import { MockNapCat, until } from './fixture';
import { TestUI } from './ui';

export async function testEmojiPreviews(app: QQApp, backend: MockNapCat, ui: TestUI, checks: string[]): Promise<void> {
  await app.openChat('group:20002');
  const editor = vscode.window.activeTextEditor!, store = app.store!;
  store.setDraft('group:20002', '表情选择保留文字'); await app.native.sync(editor);
  const sent = backend.sent.length;
  await vscode.commands.executeCommand('qq.emojis');
  const panel = await ui.webview('#favoriteFaces');
  await until(async () => await panel.evaluate(`document.querySelectorAll('#favoriteFaces button').length === 2`));
  const decoded = `document.querySelectorAll('#favoriteFaces img').length === 2 && [...document.querySelectorAll('#favoriteFaces img')].every(image => image.complete && image.naturalWidth > 0 && !image.hidden)`;
  try { await until(async () => await panel.evaluate(decoded)); }
  catch (error) {
    console.log('Emoji preview DOM:', await panel.evaluate(`JSON.stringify([...document.querySelectorAll('#favoriteFaces img')].map(image => ({ src: image.src, complete: image.complete, width: image.naturalWidth, hidden: image.hidden, hint: image.parentElement.textContent })))`));
    throw error;
  }
  assert.equal(await panel.evaluate(`document.activeElement === document.querySelector('#favoriteFaces button')`), true);
  await panel.key('ArrowRight', 39);
  assert.equal(await panel.evaluate(`document.activeElement === document.querySelectorAll('#favoriteFaces button')[1]`), true);
  await panel.key('Enter', 13);
  await until(() => store.draft('group:20002').attachments.length === 1);
  await until(() => !(app.emojis as any).view?.visible);
  assert.ok(store.draft('group:20002').text.includes('表情选择保留文字'));
  assert.equal(backend.sent.length, sent);
  await vscode.commands.executeCommand('qq.emojis');
  const reopened = await ui.webview('#recentFaces');
  await reopened.evaluate(`document.getElementById('tabRecent').click()`);
  await until(async () => await reopened.evaluate(`document.querySelectorAll('#recentFaces img').length === 1 && [...document.querySelectorAll('#recentFaces img')].every(image => image.complete && image.naturalWidth > 0 && !image.hidden)`));
  await reopened.key('Escape', 27);
  await until(() => !(app.emojis as any).view?.visible);
  store.setDraft('group:20002', '', undefined, []); await app.native.sync(editor);
  checks.push('收藏与最近表情真实解码显示，方向键选择、Enter 插入并关闭，保留草稿且不自动发送');
}
