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
  await vscode.commands.executeCommand('qq.emojis');
  const switching = await ui.webview('#favoriteFaces');
  await until(async () => await switching.evaluate(decoded));
  const staleId = await switching.evaluate(`document.querySelector('#favoriteFaces button').dataset.id`);
  const media = app.transcript!.media, get = media.get.bind(media);
  let release!: () => void, started = false;
  const gate = new Promise<void>(resolve => release = resolve);
  media.get = async ref => { if (!started) { started = true; await gate; } return get(ref); };
  const choosing = app.emojis.handleMessage({ type: 'favoriteFace', account: store.selfId, key: 'group:20002', id: staleId });
  try {
    await until(() => started);
    await app.openChat('group:20001');
    store.setDraft('group:20001', '切换后的草稿', undefined, []); await app.native.sync(vscode.window.activeTextEditor!);
    await until(async () => await switching.evaluate(decoded));
    assert.equal(vscode.window.activeTextEditor!.document.uri.toString(), app.transcript!.uri(store.chats.get('group:20001')!).toString());
    release(); await choosing;
    assert.equal(store.draft('group:20002').text, '', '旧会话的延迟选择不能重新插入表情');
    assert.equal(store.draft('group:20001').text, '切换后的草稿');
    assert.equal((app.emojis as any).view?.visible, true, '旧任务不能关闭新会话的表情面板');
    assert.equal(backend.sent.length, sent);
    checks.push('表情面板随会话切换重新加载，旧选择迟到不能写入草稿或关闭新面板');
  } finally { release(); await choosing; media.get = get; }
  await switching.evaluate(`document.getElementById('closeEmojis').click()`);
  await until(() => !(app.emojis as any).view?.visible);
  store.setDraft('group:20001', '', undefined, []);
  await app.openChat('group:20002');
  await vscode.commands.executeCommand('qq.emojis');
  const cancelled = await ui.webview('#favoriteFaces');
  await until(async () => await cancelled.evaluate(decoded));
  const cancelId = await cancelled.evaluate(`document.querySelector('#favoriteFaces button').dataset.id`);
  let releaseCancelled!: () => void, cancelStarted = false;
  const cancelGate = new Promise<void>(resolve => releaseCancelled = resolve);
  media.get = async ref => { if (!cancelStarted) { cancelStarted = true; await cancelGate; } return get(ref); };
  const cancelledChoice = app.emojis.handleMessage({ type: 'favoriteFace', account: store.selfId, key: 'group:20002', id: cancelId });
  try {
    await until(() => cancelStarted);
    await cancelled.key('Escape', 27); await until(() => !(app.emojis as any).view?.visible);
    releaseCancelled(); await cancelledChoice;
    assert.equal(store.draft('group:20002').text, '', '关闭面板后旧选择不能继续写入草稿');
    assert.equal((app.emojis as any).view?.visible, false);
    checks.push('下载表情期间按 Esc 关闭，迟到任务不再插入附件');
  } finally { releaseCancelled(); await cancelledChoice; media.get = get; }
  checks.push('收藏与最近表情真实解码显示，方向键选择、Enter 插入并关闭，保留草稿且不自动发送');
}
