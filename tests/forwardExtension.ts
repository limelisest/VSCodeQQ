import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import type { QQApp } from '../src/extension';
import { parseMessage } from '../src/model';
import { MockNapCat, until } from './fixture';
import { TestUI } from './ui';

export async function testForwardCommands(app: QQApp, backend: MockNapCat, ui: TestUI, checks: string[]): Promise<void> {
  const key = 'group:20002';
  await app.openChat(key);
  let editor = vscode.window.activeTextEditor!;
  for (const message_id of [99020, 99021]) app.store!.add(parseMessage({ message_id, user_id: 10001, message: [
    { type: 'text', data: { text: `forward-probe-${message_id}` } }, { type: 'forward', data: { id: 'root-forward' } }
  ] }, key, app.store!.selfId), false);
  app.store!.setDraft(key, '转发期间保留草稿');
  await app.native.sync(editor);
  await until(() => !app.native.isUpdating(editor.document));
  const draft = structuredClone(app.store!.draft(key));
  const sentBefore = backend.sent.length;
  const links = await vscode.commands.executeCommand<vscode.DocumentLink[]>('vscode.executeLinkProvider', editor.document.uri);
  const forward = links.find(l => l.target?.path === 'qq.openForward')!;
  assert.ok(forward);
  await vscode.commands.executeCommand('qq.openForward', ...JSON.parse(decodeURIComponent(forward.target!.query)));
  const doc = vscode.window.activeTextEditor!.document;
  assert.equal(doc.uri.scheme, 'qq-forward');
  assert.ok(doc.getText().includes('合并转发正文'));
  assert.ok(doc.getText().includes('转发发送者'));
  assert.ok(!doc.getText().includes('Enter 发送'));
  assert.equal(backend.calls.at(-1).action, 'get_forward_msg');
  assert.equal(backend.calls.at(-1).params.message_id, 'root-forward');
  const nestedLinks = await vscode.commands.executeCommand<vscode.DocumentLink[]>('vscode.executeLinkProvider', doc.uri);
  const image = nestedLinks.find(l => l.target?.path === 'qq.openForwardImage')!;
  assert.ok(image);
  const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', doc.uri, image.range.start);
  assert.ok(hovers.some(h => h.contents.some(c => c instanceof vscode.MarkdownString && c.value.includes('<img'))));
  const nested = nestedLinks.find(l => l.target?.path === 'qq.openForward')!;
  await vscode.commands.executeCommand('qq.openForward', ...JSON.parse(decodeURIComponent(nested.target!.query)));
  assert.ok(vscode.window.activeTextEditor!.document.getText().includes('嵌套转发正文'));
  assert.equal(app.store!.messages.get(key)?.some(m => m.id.startsWith('forward:')), false);
  assert.deepEqual(app.store!.draft(key), draft);
  app.store!.add(parseMessage({ message_id: 99022, message: [{ type: 'forward', data: { id: 'unqueryable', content: [{ sender: { user_id: 10001, nickname: '内嵌发送者' }, message: '内嵌正文' }] } }] }, key), false);
  const beforeInline = backend.calls.length;
  await app.forwards.open(editor.document.uri.toString(), '99022', 0);
  assert.ok(vscode.window.activeTextEditor!.document.getText().includes('内嵌正文'));
  assert.equal(backend.calls.length, beforeInline, '有内嵌内容时不能再次查询不可查询的 ID');
  const refreshedRaw = { message_id: 99022, message: [{ type: 'forward', data: { id: 'unqueryable', content: [{ sender: { user_id: 10001, nickname: '刷新发送者' }, message: '刷新后正文' }] } }] };
  backend.sentMessages.set(99022, refreshedRaw);
  app.store!.messages.get(key)!.find(m => m.id === '99022')!.segments = [{ type: 'forward', id: 'old-id', text: '[合并转发]' }];
  backend.rejectedActions.add('get_forward_msg');
  try {
    await app.forwards.open(editor.document.uri.toString(), '99022', 0);
    assert.ok(vscode.window.activeTextEditor!.document.getText().includes('刷新后正文'));
  } finally { backend.rejectedActions.delete('get_forward_msg'); }
  // Match the real failure: resource ID rejected, get_msg returns the same ID
  // without embedded content, but the original numeric message remains resolvable.
  backend.sentMessages.set(99022, { message_id: 99022, message: [{ type: 'forward', data: { id: 'old-id' } }] });
  backend.rejectedForwardIds.add('old-id');
  const beforeFallback = backend.calls.length;
  try {
    await app.forwards.open(editor.document.uri.toString(), '99022', 0);
    assert.ok(vscode.window.activeTextEditor!.document.getText().includes('合并转发正文'));
    assert.deepEqual(backend.calls.slice(beforeFallback).map(c => [c.action, c.params.message_id]), [
      ['get_forward_msg', 'old-id'], ['get_msg', '99022'], ['get_forward_msg', '99022']
    ]);
    backend.rejectedForwardIds.add('99022');
    await assert.rejects(app.forwards.open(editor.document.uri.toString(), '99022', 0), /NapCat 无法读取这条合并转发.*QQ 转发诊断/);
  } finally { backend.rejectedForwardIds.clear(); }

  checks.push('合并转发链接打开只读代码文档、发送者和正文可读、图片悬浮、嵌套转发且不污染会话');
  await app.openChat(key);
  editor = vscode.window.activeTextEditor!;
  await until(() => !app.native.isUpdating(editor.document));
  const line = app.transcript!.rendered.get(key)!.starts.get('99020')!;
  editor.selection = new vscode.Selection(line, 0, line, 0);
  const single = vscode.commands.executeCommand('qq.forwardMessage');
  await ui.waitFor(`document.querySelector('.quick-input-widget')?.textContent.includes('转发到哪个会话')`);
  const expectedFirst = [...app.store!.chats.values()].sort((a, b) => b.lastTime - a.lastTime || a.name.localeCompare(b.name, 'zh-CN'))[0];
  assert.ok(await ui.evaluate(`document.querySelector('.quick-input-list .monaco-list-row')?.textContent.includes(${JSON.stringify(expectedFirst.id)})`));
  await ui.call('Input.insertText', { text: '10001' });
  await ui.waitFor(`document.querySelector('.quick-input-list')?.textContent.includes('10001') && !document.querySelector('.quick-input-list')?.textContent.includes('20001')`); await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
  await ui.waitFor(`document.querySelector('.quick-input-widget')?.textContent.includes('确认转发')`);
  await ui.call('Input.insertText', { text: '确认转发' });
  await ui.waitFor(`document.querySelector('.quick-input-list')?.textContent.includes('确认转发') && !document.querySelector('.quick-input-list')?.textContent.includes('取消')`); await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem'); await single;
  assert.ok(backend.calls.some(c => c.action === 'forward_friend_single_msg' && c.params.user_id === '10001' && c.params.message_id === '99020'));
  const singleTarget = app.store!.messages.get('private:10001')!.find(m => m.id === '99001');
  assert.equal(singleTarget?.sendState, 'sent');
  assert.ok(app.store!.chats.get('private:10001')!.preview.includes('forward-probe-99020'));
  assert.ok(app.store!.chats.get('private:10001')!.lastTime > 0);
  assert.deepEqual(app.store!.draft(key), draft);
  const beforeCancel = backend.calls.filter(c => c.action.includes('forward')).length;
  const cancel = vscode.commands.executeCommand('qq.mergeForward');
  await ui.waitFor(`document.querySelector('.quick-input-widget')?.textContent.includes('选择合并转发消息')`);
  assert.ok(await ui.evaluate(`document.querySelector('.quick-input-list .monaco-list-row.focused')?.textContent.includes('99022')`), '初始定位最新消息');
  await vscode.commands.executeCommand('workbench.action.closeQuickOpen'); await cancel;
  assert.equal(backend.calls.filter(c => c.action.includes('forward')).length, beforeCancel);
  const merge = vscode.commands.executeCommand('qq.mergeForward');
  await ui.waitFor(`document.querySelector('.quick-input-widget')?.textContent.includes('选择合并转发消息')`);
  await ui.call('Input.insertText', { text: 'forward-probe' });
  await ui.waitFor(`document.querySelector('.quick-input-list')?.textContent.includes('99021')`);
  await ui.evaluate(`(() => { const row = [...document.querySelectorAll('.quick-input-list .monaco-list-row')].find(r => r.textContent.includes('99021')); const box = row?.querySelector('[role="checkbox"]'); if (!box) throw Error('找不到合并转发复选框'); if (box.getAttribute('aria-checked') !== 'true') box.click(); })()`);
  await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
  await ui.waitFor(`document.querySelector('.quick-input-widget')?.textContent.includes('转发到哪个会话')`);
  await ui.call('Input.insertText', { text: '20001' });
  await ui.waitFor(`document.querySelector('.quick-input-list')?.textContent.includes('20001') && !document.querySelector('.quick-input-list')?.textContent.includes('20002')`); await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
  await ui.waitFor(`document.querySelector('.quick-input-widget')?.textContent.includes('确认转发')`);
  await ui.call('Input.insertText', { text: '确认转发' });
  await ui.waitFor(`document.querySelector('.quick-input-list')?.textContent.includes('确认转发') && !document.querySelector('.quick-input-list')?.textContent.includes('取消')`); await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem'); await merge;
  const request = [...backend.calls].reverse().find(c => c.action === 'send_group_forward_msg');
  assert.equal(app.store!.messages.get('group:20001')!.find(m => m.id === '99001')?.sendState, 'sent');
  assert.equal(app.store!.chats.get('group:20001')!.preview, '[合并转发]');
  assert.deepEqual(request?.params, { group_id: '20001', messages: [{ type: 'node', data: { id: '99020' } }, { type: 'node', data: { id: '99021' } }] });
  assert.deepEqual(app.store!.draft(key), draft);
  assert.equal(backend.sent.length, sentBefore, '转发不能另外提交原会话草稿');
  checks.push('右键命令单条转发到好友、多选按原顺序合并转发到群、取消不调用发送且保留草稿');
  const staleUri = doc.uri.toString();
  app.forwards.clear();
  await assert.rejects(app.forwards.open(staleUri, 'forward:0', 0), /失效/);
  checks.push('转发查看页清理后旧链接不能跨会话执行');
  for (const group of vscode.window.tabGroups.all) for (const tab of [...group.tabs]) if (tab.input instanceof vscode.TabInputText && tab.input.uri.scheme === 'qq-forward') await vscode.window.tabGroups.close(tab);
  app.store!.setDraft(key, '');
}
