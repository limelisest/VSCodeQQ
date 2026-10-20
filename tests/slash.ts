import { test } from 'node:test';
import assert from 'node:assert/strict';
import { availableSlashCommands, menuSlashCommands, exactSlashCommand, executeSlashApi, slashCommands, SlashIO, validateSlashField } from '../src/slashCatalog';
import { commandWords, commandLineCompletion, commandGroup, parseCommandLine } from '../src/commandLine';
import { commandGroups } from '../src/slashCatalog';
import { RequestInbox } from '../src/requestInbox';
import { AccountSession } from '../src/accountSession';
import { OneBotClient } from '../src/onebot';
import { MockNapCat } from './fixture';

const context = { key: 'group:20001', type: 'group' as const, id: '20001', name: '测试群', selfId: '123456' };
const command = (name: string) => slashCommands.find(c => c.name === name)!;
const io = (overrides: Partial<SlashIO> = {}): SlashIO => ({ check: () => {}, ask: async () => undefined, confirm: async () => true, call: async () => null, result: async () => {}, ...overrides });

test('指令名全部英文、说明中文，私聊不提供群管理，完整草稿才解释为指令', () => {
  assert.equal(new Set(slashCommands.map(c => c.name)).size, slashCommands.length);
  for (const c of slashCommands) { assert.match(c.name, /^[a-z][a-z0-9_]*$/); assert.match(c.description, /[\u4e00-\u9fff]/); }
  for (const name of ['emoji', 'image', 'video', 'file', 'mention', 'recall', 'status', 'requests', 'group_files']) assert.ok(command(name));
  assert.equal(availableSlashCommands('private').some(c => c.name === 'ban'), false);
  assert.equal(availableSlashCommands('group').some(c => c.name === 'ban'), true);
  assert.equal(menuSlashCommands('group').length, 13);
  assert.equal(menuSlashCommands('private').length, 10);
  assert.ok(menuSlashCommands('group').some(c => c.name === 'manage'));
  assert.ok(!menuSlashCommands('private').some(c => c.name === 'manage'));
  assert.ok(!menuSlashCommands('group').some(c => c.sensitive || ['ban', 'status', 'restart', 'backend_cache'].includes(c.name)));
  assert.equal(exactSlashCommand(' /STATUS\n', 'group')?.name, 'status');
  for (const text of ['/表情', '正文 /status', '/status 文字', '//status', '/unknown', '/status\n第二行']) assert.equal(exactSlashCommand(text, 'group'), undefined);
  assert.equal(exactSlashCommand('/mention', 'private'), undefined);
  assert.equal(exactSlashCommand('/forward', 'group')?.local, 'qq.forwardMessage');
  assert.equal(exactSlashCommand('/merge_forward', 'group'), undefined);
  assert.ok(validateSlashField({ key: 'n', label: '时长', kind: 'integer', min: 0, max: 2592000 }, '-1'));
  assert.ok(validateSlashField({ key: 'n', label: '时长', kind: 'integer', min: 0, max: 2592000 }, '1.5'));
  assert.equal(validateSlashField({ key: 'message_id', label: '消息', kind: 'message' }, '-123'), undefined);
  assert.ok(validateSlashField({ key: 'message_id', label: '消息', kind: 'message' }, '0'));
});

test('Slash 请求通过 WebSocket 传递正确对象和参数，取消与拒绝不会产生成功结果', async () => {
  const backend = new MockNapCat(); await backend.start(); const client = new OneBotClient();
  try {
    await client.connect(backend.url);
    let presented = 0;
    const operation = io({ ask: async field => ({ user_id: '10001', duration: '60', card: '', message_id: '-123', times: '3' } as Record<string, string>)[field.key], call: (action, params) => client.call(action, params), result: async () => { presented++; } });
    await executeSlashApi(command('ban'), context, operation);
    assert.deepEqual(backend.calls.at(-1).params, { group_id: '20001', user_id: '10001', duration: 60 });
    await executeSlashApi(command('unban'), context, operation);
    assert.deepEqual(backend.calls.at(-1).params, { group_id: '20001', user_id: '10001', duration: 0 });
    await executeSlashApi(command('card'), context, operation);
    assert.equal(backend.calls.at(-1).params.card, '', '留空删除名片和取消对话框不同');
    await executeSlashApi(command('recall'), context, operation);
    assert.equal(backend.calls.at(-1).action, 'delete_msg'); assert.equal(backend.calls.at(-1).params.message_id, '-123');
    const before = backend.calls.length;
    assert.equal(await executeSlashApi(command('kick'), context, io({ ask: async () => undefined, call: operation.call })), false);
    assert.equal(await executeSlashApi(command('kick'), context, { ...operation, confirm: async () => false }), false);
    await assert.rejects(executeSlashApi(command('ban'), context, { ...operation, ask: async field => field.key === 'duration' ? '9999999999' : '10001' }), /整数/);
    assert.equal(backend.calls.length, before);
    const successful = presented;
    await assert.rejects(executeSlashApi(command('recall'), context, { ...operation, call: async () => { throw new Error('权限不足'); } }), /权限不足/);
    assert.equal(presented, successful);
    await assert.rejects(executeSlashApi(command('ban'), { ...context, type: 'private' }, operation), /当前会话/);
    assert.equal(backend.sent.length, 0);
  } finally { client.dispose(); await backend.close(); }
});

test('参数选择、确认和响应期间更换连接，旧操作不能请求或展示新账号结果', async () => {
  for (const phase of ['ask', 'confirm', 'call'] as const) {
    const session = new AccountSession(), captured = session.capture(); let calls = 0, results = 0;
    const check = () => { if (!captured.current()) throw new Error('连接已变化'); };
    await assert.rejects(executeSlashApi(command('recall'), context, io({
      check,
      ask: async () => { if (phase === 'ask') session.advance(); return '123'; },
      confirm: async () => { if (phase === 'confirm') session.advance(); return true; },
      call: async () => { calls++; if (phase === 'call') session.advance(); return {}; },
      result: async () => { results++; }
    })), /连接已变化/);
    assert.equal(calls, phase === 'call' ? 1 : 0); assert.equal(results, 0);
  }
});

test('申请按账号隔离和去重，验证群邀请类型，容量有界且只删除已处理申请', () => {
  const inbox = new RequestInbox();
  const friend = { post_type: 'request', request_type: 'friend', self_id: 123456, user_id: 10001, flag: 'friend-flag', comment: '你好' };
  inbox.add(friend, '123456'); inbox.add(friend, '123456');
  assert.equal(inbox.entries('123456').length, 1); assert.deepEqual(inbox.entries('other'), []);
  inbox.add({ ...friend, self_id: 999 }, '123456');
  inbox.add({ ...friend, request_type: 'group', group_id: 20001, sub_type: 'wrong' }, '123456');
  assert.equal(inbox.entries('123456').length, 1);
  inbox.add({ ...friend, request_type: 'group', group_id: 20001, sub_type: 'invite' }, '123456');
  assert.equal(inbox.entries('123456')[1].subType, 'invite');
  inbox.remove('other', inbox.entries('123456')[0].key); assert.equal(inbox.entries('123456').length, 2);
  inbox.remove('123456', inbox.entries('123456')[0].key); assert.equal(inbox.entries('123456').length, 1);
  for (let n = 0; n < 110; n++) inbox.add({ ...friend, flag: 'flag-' + n }, '123456');
  assert.equal(inbox.entries('123456').length, 100);
  inbox.add({ ...friend, self_id: 999999 }, '999999');
  assert.equal(inbox.entries('123456').length, 0); assert.equal(inbox.entries('999999').length, 1);
  inbox.clear(); assert.equal(inbox.entries('999999').length, 0);
});


test('群管理按主命令、子命令和参数解析，绑定成员并验证默认值、引号与重名', () => {
  const members = [{ id: '10001', name: '群成员', nickname: '昵称' }, { id: '10002', name: '重名' }, { id: '10003', name: '重名' }];
  const parse = (text: string) => parseCommandLine(text, 'group', { '[@:含 空格]': '10001' }, members);
  assert.deepEqual(parse('/manage ban @群成员').values, { user_id: '10001', duration: '1800' });
  assert.deepEqual(parse('/manage ban [@:含 空格] 60').values, { user_id: '10001', duration: '60' });
  assert.deepEqual(parse('/manage unban @[10001]').values, { user_id: '10001' });
  assert.deepEqual(parse('/MANAGE ban 10001 0').values, { user_id: '10001', duration: '0' });
  assert.deepEqual(parse('/group card @昵称 "新 名片"').values, { user_id: '10001', card: '新 名片' });
  assert.deepEqual(parse('/group card 10001 ""').values, { user_id: '10001', card: '' });
  assert.deepEqual(parse('/group notice publish 多行\n公告 正文').values, { content: '多行 公告 正文' });
  for (const text of ['/manage ban', '/manage status', '/manage ban @重名', '/manage ban @陌生人', '/manage ban [@:伪造]', '/manage ban 10001 -1', '/manage ban 10001 2592001', '/manage ban 10001 60 多余', '/manage ban_all 多余', '/group name "未闭合']) assert.throws(() => parse(text), text);
  assert.equal(commandLineCompletion('/manage ba', 'group')?.prefix, 'ba');
  assert.equal(commandLineCompletion('/manage ban ', 'group')?.field?.kind, 'user');
  assert.equal(commandLineCompletion('/manage ban [@:含 空格] ', 'group')?.field?.key, 'duration');
  assert.equal(commandLineCompletion('聊天 /manage ban', 'group'), undefined);
  assert.equal(commandWords('/group card 10001 "a \\"b\\""')[3].closed, true);
});


test('分类入口区分个人、群资料、成员管理和会话，所有路径都指向唯一有效指令', async () => {
  for (const group of commandGroups) {
    const paths = Object.keys(group.entries);
    assert.equal(new Set(paths).size, paths.length);
    for (const [path, name] of Object.entries(group.entries)) {
      assert.ok(slashCommands.some(command => command.name === name), group.name + ' ' + path);
      assert.ok(!paths.some(other => other !== path && other.startsWith(path + ' ')), '子命令不可同时作为有参数的终点和分类');
    }
  }
  const choices = (text: string, type: 'group' | 'private' = 'group') => commandLineCompletion(text, type)?.choices?.map(choice => choice.name) ?? [];
  assert.deepEqual(choices('/profile '), ['info', 'nickname', 'signature']);
  assert.deepEqual(choices('/profile ', 'private'), ['info', 'nickname', 'signature']);
  for (const name of ['name', 'card', 'title', 'notice', 'files']) assert.ok(choices('/group ').includes(name));
  assert.deepEqual(choices('/group notice '), ['list', 'publish', 'delete']);
  assert.deepEqual(choices('/group notice p'), ['publish']);
  assert.ok(choices('/manage ').includes('bans'));
  for (const name of ['name', 'card', 'title', 'notice', 'files', 'signature']) assert.ok(!choices('/manage ').includes(name));
  assert.ok(!choices('/chat ', 'group').includes('remark'));
  assert.ok(!choices('/chat ', 'private').includes('archive'));
  assert.deepEqual(choices('/group ', 'private'), []);
  assert.equal(commandGroup('正文 /profile signature'), undefined);
  const parse = (text: string, type: 'group' | 'private' = 'group') => parseCommandLine(text, type);
  assert.equal(parse('/group notice list').command.action, '_get_group_notice');
  assert.equal(parse('/group files browse').command.special, 'files');
  assert.deepEqual(parse('/profile nickname 新 昵称', 'private').values, { nickname: '新 昵称' });
  assert.deepEqual(parse('/profile signature ""').values, { longNick: '' });
  assert.deepEqual(parse('/group notice publish 新 公告').values, { content: '新 公告' });
  for (const text of ['/profile signature', '/profile nickname', '/group notice', '/group notice unknown', '/manage card 10001 名片']) assert.throws(() => parse(text), text);
  assert.throws(() => parse('/group name 新群名', 'private'), /仅用于群聊/);
  let params: Record<string, unknown> | undefined;
  await executeSlashApi(parse('/profile nickname 新昵称').command, context, io({ ask: async () => '新昵称', call: async (action, value) => { assert.equal(action, 'set_qq_profile'); params = value; } }));
  assert.deepEqual(params, { nickname: '新昵称' }, '昵称修改不附带签名、性别等其他资料');
});
