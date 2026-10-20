import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import type { QQApp } from '../src/extension';
import { MockNapCat, png, sendEventTimeout, until } from './fixture';
import { TestUI } from './ui';

export async function testOperationLocks(app: QQApp, backend: MockNapCat, ui: TestUI, checks: string[]): Promise<void> {
  const calls = (action: string) => backend.calls.filter(c => c.action === action).length;
  const key = 'group:20002';
  await app.openChat(key);
  backend.failSend = true;
  const failed = app.outbox.submit(app.store!, key, 'operation-lock-retry'); await failed.completion;
  backend.failSend = false; backend.sendDelay = 150;
  const beforeSend = calls('send_msg'), uri = vscode.window.activeTextEditor!.document.uri.toString();
  try {
    await Promise.all(Array.from({ length: 10 }, () => vscode.commands.executeCommand('qq.retryMessage', uri, failed.messageIds[0])));
    assert.equal(calls('send_msg') - beforeSend, 1);
    await vscode.commands.executeCommand('qq.retryMessage', uri, failed.messageIds[0]);
    assert.equal(calls('send_msg') - beforeSend, 1, '成功后的旧重发链接无效');
  } finally { backend.sendDelay = 0; }
  checks.push('重复点击重发只发送一次，成功后的旧重发链接不能再次发送');

  for (const echoDelay of [0, 150]) {
    const image = await app.attachments!.stage(png, 'timeout-echo.png'); app.store!.attach(key, [image]);
    const before = calls('send_msg');
    backend.sendFailure = { retcode: 1200, message: sendEventTimeout }; backend.emitSentDelay = echoDelay;
    try {
      const submission = app.outbox.submit(app.store!, key, app.store!.draft(key).text + `timeout-echo-${echoDelay}`);
      const complete = await submission.completion;
      if (!echoDelay) assert.equal(complete, true);
      await until(() => !app.store!.messages.get(key)?.some(m => m.id === submission.messageIds[0]));
      const matching = app.store!.messages.get(key)!.filter(m => m.segments.some(s => s.type === 'text' && s.text === `timeout-echo-${echoDelay}`));
      assert.equal(matching.length, 1); assert.equal(matching[0].sendState, 'sent'); assert.equal(matching[0].sendError, undefined);
      assert.equal(calls('send_msg') - before, 1); assert.equal(app.store!.draft(key).text, '');
      await vscode.commands.executeCommand('qq.retryMessage', uri, submission.messageIds[0]);
      assert.equal(calls('send_msg') - before, 1);
    } finally { backend.sendFailure = undefined; backend.emitSentDelay = 0; }
  }
  checks.push('图片文字已发出但 NTEvent 超时时，早到或迟到的自身回显合并为一条成功消息，不重发');

  backend.sendFailure = { retcode: 1200, message: sendEventTimeout }; backend.emitSent = false;
  try {
    const submission = app.outbox.submit(app.store!, key, 'timeout-without-echo');
    assert.equal(await submission.completion, false);
    assert.equal(app.store!.messages.get(key)!.find(m => m.id === submission.messageIds[0])!.sendState, 'uncertain');
    const before = calls('send_msg');
    const retry = vscode.commands.executeCommand('qq.retryMessage', uri, submission.messageIds[0]);
    await ui.waitFor(`document.querySelector('.quick-input-widget')?.textContent.includes('消息发送结果未确认')`);
    await ui.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await ui.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await retry; assert.equal(calls('send_msg'), before);
  } finally { backend.sendFailure = undefined; backend.emitSent = true; }
  checks.push('NTEvent 超时且无回显时保留未确认，重试先确认，取消不会再次发送');

  const file = await app.attachments!.stageFile(Buffer.from('file echo with rejected ack'), '回执异常.txt');
  app.store!.attach(key, [file]); backend.fileEchoThenReject = true;
  let fileSubmission;
  try {
    fileSubmission = app.outbox.submit(app.store!, key, app.store!.draft(key).text);
    assert.equal(await fileSubmission.completion, true);
  } finally { backend.fileEchoThenReject = false; }
  assert.equal(app.store!.messages.get(key)!.some(m => m.id === fileSubmission.messageIds[0]), false);
  await until(() => !!vscode.window.activeTextEditor?.document.getText().includes('[文件:回执异常.txt]'));
  const uploads = backend.fileUploads.length;
  const retryFiles = Array.from({ length: 5 }, () => vscode.commands.executeCommand('qq.retryMessage', uri, fileSubmission.messageIds[0]));
  await Promise.all(retryFiles);
  assert.equal(backend.fileUploads.length, uploads);
  checks.push('文件已发出但接口报错时通过新回显确认成功，旧重试入口不再上传');

  backend.listDelay = 100;
  const friends = calls('get_friend_list'), groups = calls('get_group_list');
  try {
    await Promise.all(Array.from({ length: 10 }, () => app.refresh()));
    assert.equal(calls('get_friend_list') - friends, 1); assert.equal(calls('get_group_list') - groups, 1);
  } finally { backend.listDelay = 0; }
  backend.rejectedActions.add('get_friend_list');
  try { await assert.rejects(app.refresh()); } finally { backend.rejectedActions.delete('get_friend_list'); }
  await app.refresh();
  checks.push('列表刷新复用请求，后端失败后释放锁，可重新刷新');

  await app.openChat(key);
  const invocation = app.slash.capture(vscode.window.activeTextEditor!.document.uri)!;
  const beforeBan = calls('set_group_whole_ban');
  backend.memberRoles.set('123456', 'admin');
  const first = app.slash.run('ban_all', invocation), second = app.slash.run('ban_all', invocation);
  await ui.waitFor(`document.querySelector('.quick-input-widget')?.textContent.includes('确认操作')`);
  await ui.call('Input.insertText', { text: '确认' });
  await ui.waitFor(`document.querySelector('.quick-input-list')?.textContent.includes('确认') && !document.querySelector('.quick-input-list')?.textContent.includes('取消')`);
  await ui.enter(); await Promise.all([first, second]);
  assert.equal(calls('set_group_whole_ban') - beforeBan, 1);
  backend.memberRoles.delete('123456');
  checks.push('重复群管理指令共享一次确认和一次云端请求');

  backend.actionDelays.set('fetch_custom_face', 100);
  const beforeFaces = calls('fetch_custom_face');
  try {
    await Promise.all(Array.from({ length: 10 }, () => app.emojis.handleMessage({ type: 'faces', account: app.store!.selfId, key, count: 48 })));
    assert.equal(calls('fetch_custom_face') - beforeFaces, 1);
  } finally { backend.actionDelays.delete('fetch_custom_face'); }
  checks.push('重复刷新收藏表情只向 NapCat 请求一次');
  const login = calls('get_login_info');
  await Promise.all(Array.from({ length: 5 }, () => app.connect()));
  assert.equal(calls('get_login_info') - login, 1); assert.equal(app.ready, true);
  checks.push('重复连接复用同一次握手和初始化');
  app.disconnect();
  const readToken = app.config.token.bind(app.config);
  let releaseToken!: (value: string) => void;
  const delayedToken = new Promise<string>(resolve => { releaseToken = resolve; });
  const beforeCancelled = calls('get_login_info');
  app.config.token = () => delayedToken;
  try {
    const connecting = app.connect();
    const rejected = assert.rejects(connecting, /连接操作已取消/);
    await vscode.commands.executeCommand('qq.disconnect');
    releaseToken(''); await rejected;
    assert.equal(calls('get_login_info'), beforeCancelled);
    assert.equal(app.client.connected, false); assert.equal(app.ready, false);
  } finally { app.config.token = readToken; }
  await app.connect();
  checks.push('读取 Token 期间断开连接也能取消待连接任务，不会稍后自行连上');
}
