import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canManageMember, canRecall, CommandPermissions, commandRules, GroupRole } from '../src/commandPermissions';
import { ChatStore } from '../src/store';
import { newChat, parseMessage } from '../src/model';
import { slashCommands } from '../src/slashCatalog';

const self = '123456', group = newChat('group', '20002', '测试群'), privateChat = newChat('private', '10001', '测试好友');
const message = (sender = self, key = group.key, id = '99') => parseMessage({ message_id: id, user_id: sender, message: 'test' }, key, self);
const roles: (GroupRole | undefined)[] = [undefined, 'member', 'admin', 'owner'];

test('撤回仅允许本人消息或有权限管理的群成员消息，不包括私聊对方、已撤回和未发送消息', () => {
  for (const actor of roles) for (const target of roles) {
    const members = new Map<string, GroupRole>();
    if (actor) members.set(self, actor); if (target) members.set('10001', target);
    assert.equal(canRecall(message(self), group, self, members), true);
    assert.equal(canRecall(message('10001', privateChat.key), privateChat, self, members), false);
    assert.equal(canRecall(message('10001'), group, self, members),
      actor === 'owner' && !!target && target !== 'owner' || actor === 'admin' && target === 'member');
  }
  const empty = new Map<string, GroupRole>();
  for (const invalid of [
    { ...message(), recalled: true }, { ...message(), id: 'local:1' }, { ...message(), id: '0' },
    { ...message(), systemNotice: '系统通知' }, { ...message(), chatKey: 'group:other' },
    ...(['queued', 'sending', 'failed', 'uncertain', 'cancelled'] as const).map(sendState => ({ ...message(), sendState }))
  ]) assert.equal(canRecall(invalid, group, self, empty), false);
});

test('群管理成员分级：管理员不能操作群主、其他管理员或自己；群主专属操作和本人名片单独判断', () => {
  for (const command of ['ban', 'unban', 'kick']) for (const actor of roles) for (const target of roles) {
    assert.equal(canManageMember(command, self, '10001', actor, target),
      actor === 'owner' && !!target && target !== 'owner' || actor === 'admin' && target === 'member');
    assert.equal(canManageMember(command, self, self, actor, actor), false);
  }
  for (const actor of roles) {
    assert.equal(canManageMember('card', self, self, actor, actor), true);
    assert.equal(canManageMember('title', self, self, actor, actor), actor === 'owner');
    for (const command of ['admin', 'unadmin']) {
      assert.equal(canManageMember(command, self, '10001', actor, 'member'), actor === 'owner');
      assert.equal(canManageMember(command, self, '10001', actor, 'owner'), false);
      assert.equal(canManageMember(command, self, self, actor, actor), false);
    }
  }
});

test('所有群变更指令都有权限策略；本机备注与签到不误要求管理权限', () => {
  const unprivileged = new Set(['group_remark', 'sign']);
  for (const command of slashCommands.filter(command => command.mutation && command.scope === 'group')) {
    assert.ok(commandRules[command.name] || unprivileged.has(command.name), command.name);
  }
});

test('执行前刷新角色阻止权限降级、目标升权、未知角色和旧缓存放行；本人操作仍可执行', async () => {
  const store = new ChatStore('/unused-permission-test', self);
  store.messages.set(group.key, [message(), message('10001', group.key, '100')]);
  store.messages.set(privateChat.key, [message(self, privateChat.key, '101'), message('10001', privateChat.key, '102')]);
  let actor: string | undefined = 'admin', target = 'member', failed = false;
  const calls: { action: string; params: Record<string, unknown> }[] = [];
  const access = new CommandPermissions(store, group, async (action, params) => {
    calls.push({ action, params });
    if (failed) throw new Error('lookup failed');
    return { user_id: params.user_id, group_id: group.id, role: params.user_id === self ? actor : target };
  });
  await access.check('ban', { user_id: '10001' });
  actor = 'member'; access.refresh();
  await assert.rejects(access.check('ban', { user_id: '10001' }), /管理员权限/);
  actor = 'admin'; target = 'admin'; access.refresh();
  await assert.rejects(access.check('recall', { message_id: '100' }), /没有撤回/);
  failed = true; access.refresh();
  await assert.rejects(access.check('ban_all'), /无法确认/);
  await access.check('card', { user_id: self }); await access.check('recall', { message_id: '99' });
  await access.check('group_remark', { remark: '备注' }); await access.check('sign');
  await assert.rejects(access.check('recall', { message_id: '101' }), /当前会话/);
  assert.ok(calls.every(call => call.action === 'get_group_member_info' && call.params.no_cache === true));
  const privateAccess = new CommandPermissions(store, privateChat, async () => { throw new Error('私聊不能查群权限'); });
  await privateAccess.check('recall', { message_id: '101' });
  await assert.rejects(privateAccess.check('recall', { message_id: '102' }), /只能撤回自己/);
});

test('群主专属、普通管理、退出群聊和未知权限逐项拦截', async () => {
  const store = new ChatStore('/unused-permission-test', self);
  let role: GroupRole | undefined;
  const access = new CommandPermissions(store, group, async (_action, params) => ({ user_id: params.user_id, role }));
  for (role of roles) {
    for (const command of ['admin', 'unadmin', 'title', 'dismiss']) {
      access.refresh();
      if (role === 'owner') await access.check(command);
      else await assert.rejects(access.check(command), /群主权限|无法确认/);
    }
    for (const command of ['ban_all', 'unban_all', 'rename', 'notice', 'notice_delete', 'essence_add', 'essence_remove', 'folder', 'folder_delete', 'group_request']) {
      access.refresh();
      if (role === 'owner' || role === 'admin') await access.check(command);
      else await assert.rejects(access.check(command), /管理员权限|无法确认/);
    }
    access.refresh();
    if (role === 'member' || role === 'admin') await access.check('leave');
    else await assert.rejects(access.check('leave'), /群主|无法确认/);
  }
});

test('群文件删除允许普通成员删除本人上传文件，确认后重新验证上传者和目录', async () => {
  const store = new ChatStore('/unused-permission-test', self);
  let uploader: string | undefined = self, role = 'member';
  const calls: string[] = [];
  const access = new CommandPermissions(store, group, async (action, params) => {
    calls.push(action);
    if (action === 'get_group_member_info') return { user_id: params.user_id, role };
    if (action === 'get_group_root_files') return { files: [], folders: [{ folder_id: 'sub' }] };
    return { files: [{ file_id: 'file', uploader }] };
  });
  await access.check('group_file_delete', { file_id: 'file' });
  uploader = '10001'; access.refresh(); calls.length = 0;
  await assert.rejects(access.check('group_file_delete', { file_id: 'file' }), /自己上传/);
  assert.deepEqual(calls, ['get_group_member_info', 'get_group_files_by_folder']);
  uploader = undefined; access.refresh();
  await assert.rejects(access.check('group_file_delete', { file_id: 'file' }), /无法确认/);
  role = 'admin'; access.refresh(); calls.length = 0;
  await access.check('group_file_delete', { file_id: 'file' });
  assert.deepEqual(calls, ['get_group_member_info']);
});
