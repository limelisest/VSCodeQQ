import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import type { QQApp } from '../src/extension';
import { parseMessage } from '../src/model';
import { MockNapCat, until } from './fixture';
import { TestUI } from './ui';

export async function testPermissions(app: QQApp, backend: MockNapCat, ui: TestUI, checks: string[]): Promise<void> {
  const group = 'group:20002', privateKey = 'private:10001', self = '123456';
  const oldMembers = backend.groupMembers, oldRoles = new Map(backend.memberRoles);
  const savedMessages = new Map([group, privateKey].map(key => [key, [...app.store!.messages.get(key) ?? []]]));
  const calls = (action: string) => backend.calls.filter(call => call.action === action).length;
  const beforeDeletes = calls('delete_msg');
  const open = async (key = group) => {
    await app.openChat(key);
    const editor = vscode.window.activeTextEditor!;
    await until(() => !app.native.isUpdating(editor.document));
    return { editor, invocation: app.slash.capture(editor.document.uri)! };
  };
  const pickText = () => ui.evaluate(`document.querySelector('.quick-input-list')?.textContent ?? ''`);
  const choose = async (value: string) => {
    await ui.call('Input.insertText', { text: value });
    await ui.waitFor(`document.querySelector('.quick-input-list')?.textContent.includes(${JSON.stringify(value)})`);
    await ui.enter();
  };
  const confirm = async () => {
    await ui.waitFor(`document.activeElement?.closest('.quick-input-widget')?.textContent.includes('确认操作')`);
    await choose('确认');
  };
  const viewRecall = async (key: string, visible: string[], hidden: string[]) => {
    const { invocation } = await open(key);
    const run = app.slash.run('recall', invocation);
    await ui.waitFor(`document.activeElement?.closest('.quick-input-widget')?.textContent.includes('选择消息')`);
    const text = await pickText();
    for (const value of visible) assert.ok(text.includes(value), '应显示 ' + value);
    for (const value of [...hidden, '输入消息 ID']) assert.ok(!text.includes(value), '不应显示 ' + value);
    await vscode.commands.executeCommand('workbench.action.closeQuickOpen'); await run;
  };
  try {
    backend.groupMembers = [
      { user_id: self, card: '本人', role: 'member' }, { user_id: '10001', card: '普通成员', role: 'member' },
      { user_id: '10002', card: '管理员', role: 'admin' }, { user_id: '10003', card: '群主', role: 'owner' }
    ];
    for (const key of [group, privateKey]) {
      await app.loadHistory(key);
      const messages = [self, '10001', '10002', '10003'].map((sender, index) => parseMessage({
        message_id: (key === group ? 88100 : 88200) + index, user_id: sender,
        sender: { user_id: sender, nickname: ['本人', '普通成员', '管理员', '群主'][index] },
        time: Math.floor(Date.now() / 1000), message: 'permission-message-' + index
      }, key, self));
      if (key === group) {
        messages.push({ ...messages[0], id: '88104', recalled: true }, { ...messages[0], id: 'local:failed', sendState: 'failed' });
      }
      app.store!.messages.set(key, messages);
    }
    await viewRecall(privateKey, ['88200'], ['88201', '88202', '88203']);
    await viewRecall(group, ['88100'], ['88101', '88102', '88103', '88104', 'local:failed']);
    checks.push('私聊与普通群成员撤回列表仅包含本人已发送消息，排除已撤回、失败消息和手动 ID 入口');

    backend.memberRoles.set(self, 'admin');
    await viewRecall(group, ['88100', '88101'], ['88102', '88103']);
    backend.memberRoles.set(self, 'owner');
    await viewRecall(group, ['88100', '88101', '88102'], ['88103']);
    checks.push('管理员只可选择本人和普通成员消息，群主还可选择管理员消息');

    // An old owner record must not authorize anything when fresh lookup fails.
    app.session.memberLoaded.delete(group); await app.loadMembers(group);
    backend.rejectedActions.add('get_group_member_info'); backend.rejectedActions.add('get_group_member_list');
    await viewRecall(group, ['88100'], ['88101', '88102', '88103']);
    backend.rejectedActions.delete('get_group_member_info'); backend.rejectedActions.delete('get_group_member_list');
    checks.push('权限接口失败时不采用缓存中的群主身份，仅保留本人消息');

    let { invocation } = await open(privateKey);
    await assert.rejects(app.slash.run('recall', invocation, { message_id: '88201' }), /只能撤回自己/);
    await assert.rejects(app.slash.run('recall', invocation, { message_id: '88100' }), /当前会话/);
    ({ invocation } = await open());
    backend.memberRoles.set(self, 'member');
    await assert.rejects(app.slash.run('recall', invocation, { message_id: '88101' }), /没有撤回/);
    await assert.rejects(app.slash.run('ban', invocation, { user_id: '10001', duration: '60' }), /管理员权限/);
    await assert.rejects(app.slash.run('dismiss', invocation), /群主权限/);
    assert.equal(calls('delete_msg'), beforeDeletes);
    checks.push('直接传入他人消息、跨会话 ID、无权限禁言和解散均在请求前拒绝');

    backend.memberRoles.set(self, 'admin');
    const demoted = assert.rejects(app.slash.run('recall', invocation, { message_id: '88101' }), /没有撤回/);
    await ui.waitFor(`document.activeElement?.closest('.quick-input-widget')?.textContent.includes('确认操作')`);
    backend.memberRoles.set(self, 'member');
    await choose('确认'); await demoted;
    assert.equal(calls('delete_msg'), beforeDeletes);
    assert.equal(app.store!.messages.get(group)!.find(message => message.id === '88101')!.recalled, undefined);
    checks.push('确认窗口期间管理员被降级，提交时重新验证并阻止撤回');

    const editor = vscode.window.activeTextEditor!;
    app.store!.setDraft(group, '/manage ban 10001 60', undefined, []);
    await app.native.sync(editor); await app.native.focus(editor);
    const beforeBan = calls('set_group_ban');
    await assert.rejects(async () => { await vscode.commands.executeCommand('qq.send', editor.document.uri.toString(), true); }, /管理员权限/);
    assert.equal(app.native.draft(editor.document), '/manage ban 10001 60');
    assert.equal(calls('set_group_ban'), beforeBan);
    app.store!.setDraft(group, '/ban_all', undefined, []); await app.native.sync(editor);
    await assert.rejects(async () => { await vscode.commands.executeCommand('qq.send', editor.document.uri.toString(), true); }, /管理员权限/);
    assert.equal(app.native.draft(editor.document), '/ban_all');
    await vscode.commands.executeCommand('notifications.clearAll');
    checks.push('分类指令和旧单词指令权限不足时都保留草稿，不向 QQ 发送命令或管理请求');

    app.session.memberLoaded.delete(group); await app.loadMembers(group);
    app.store!.setDraft(group, '/group card ', undefined, []); await app.native.sync(editor); await app.native.focus(editor);
    const completion = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', editor.document.uri, editor.selection.active);
    assert.deepEqual(completion.items.map(item => typeof item.label === 'string' ? item.label : item.label.label), ['@本人']);
    const card = app.slash.run('card', invocation);
    await ui.waitFor(`document.activeElement?.closest('.quick-input-widget')?.textContent.includes('选择用户')`);
    const members = await pickText();
    assert.ok(members.includes(self)); assert.ok(!members.includes('10001')); assert.ok(!members.includes('10002'));
    await vscode.commands.executeCommand('workbench.action.closeQuickOpen'); await card;
    const updateCard = app.slash.run('card', invocation, { user_id: self, card: '本人新名片' });
    await confirm(); await updateCard;
    assert.ok(backend.calls.some(call => call.action === 'set_group_card' && call.params.user_id === self));
    checks.push('普通成员修改名片只补全和选择本人，仍可正常提交本人名片');

    backend.memberRoles.set(self, 'admin');
    const beforeWholeBan = calls('set_group_whole_ban'), wholeBan = app.slash.run('ban_all', invocation);
    await confirm(); await wholeBan;
    assert.equal(calls('set_group_whole_ban'), beforeWholeBan + 1);
    const revoke = app.slash.run('recall', invocation, { message_id: '88101' });
    await confirm(); await revoke;
    assert.equal(calls('delete_msg'), beforeDeletes + 1);
    assert.equal(app.store!.messages.get(group)!.find(message => message.id === '88101')!.recalled, true);
    checks.push('具有权限时全员禁言和撤回正常执行，后端确认后更新撤回状态');

    // Request permissions belong to the requested group, not the visible chat.
    app.slash.requests.clear();
    app.slash.requests.add({ post_type: 'request', request_type: 'group', sub_type: 'add', self_id: self, user_id: '10005', group_id: '30001', flag: 'permission-add' }, self);
    backend.memberRoles.set('30001:' + self, 'member');
    const beforeRequests = calls('set_group_add_request');
    app.store!.setDraft(group, '/chat requests', undefined, []); await app.native.sync(editor);
    const deniedRequest = assert.rejects(async () => { await vscode.commands.executeCommand('qq.send', editor.document.uri.toString(), true); }, /管理员权限/);
    await ui.waitFor(`document.activeElement?.closest('.quick-input-widget')?.textContent.includes('处理申请')`);
    await choose('10005'); await deniedRequest;
    assert.equal(calls('set_group_add_request'), beforeRequests);
    assert.equal(app.slash.requests.entries(self).length, 1);
    assert.equal(app.native.draft(editor.document), '/chat requests');
    checks.push('入群申请按申请所属群校验权限，不能借用当前群的管理员身份，拒绝后保留指令草稿');

    app.slash.requests.clear();
    app.slash.requests.add({ post_type: 'request', request_type: 'group', sub_type: 'invite', self_id: self, user_id: '10005', group_id: '30001', flag: 'permission-invite' }, self);
    const invited = vscode.commands.executeCommand('qq.send', editor.document.uri.toString(), true);
    await ui.waitFor(`document.activeElement?.closest('.quick-input-widget')?.textContent.includes('处理申请')`);
    await choose('10005');
    await ui.waitFor(`document.querySelector('.quick-input-list')?.textContent.includes('同意')`);
    await choose('同意');
    await ui.waitFor(`document.activeElement?.closest('.quick-input-widget')?.textContent.includes('拒绝理由')`);
    await ui.enter(); await confirm(); await invited;
    assert.equal(calls('set_group_add_request'), beforeRequests + 1);
    assert.equal(app.slash.requests.entries(self).length, 0);
    assert.equal(app.native.draft(editor.document), '');
    checks.push('本人收到的群邀请无需该群管理权限，成功处理后才清空指令草稿');
  } finally {
    backend.groupMembers = oldMembers; backend.memberRoles.clear();
    for (const [id, role] of oldRoles) backend.memberRoles.set(id, role);
    backend.rejectedActions.delete('get_group_member_info'); backend.rejectedActions.delete('get_group_member_list');
    app.slash.requests.clear();
    for (const [key, messages] of savedMessages) {
      app.store!.messages.set(key, messages); app.store!.setDraft(key, '', undefined, []);
      app.session.memberLoaded.delete(key);
    }
    await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
    await vscode.commands.executeCommand('notifications.clearAll');
  }
}
