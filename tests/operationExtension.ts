import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import type { QQApp } from '../src/extension';
import { MockNapCat, until } from './fixture';
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
  const first = app.slash.run('ban_all', invocation), second = app.slash.run('ban_all', invocation);
  await ui.waitFor(`document.querySelector('.quick-input-widget')?.textContent.includes('确认操作')`);
  await ui.call('Input.insertText', { text: '确认' });
  await ui.waitFor(`document.querySelector('.quick-input-list')?.textContent.includes('确认') && !document.querySelector('.quick-input-list')?.textContent.includes('取消')`);
  await ui.enter(); await Promise.all([first, second]);
  assert.equal(calls('set_group_whole_ban') - beforeBan, 1);
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
}
