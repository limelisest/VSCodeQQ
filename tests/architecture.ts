import { chatSettings, validateChatSettings } from '../src/settingsSchema';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { AccountSession } from '../src/accountSession';
import { OutboxService } from '../src/outbox';
import { ChatStore, StoreChange } from '../src/store';
import { OneBotClient } from '../src/onebot';
import { newChat, parseMessage, messageText } from '../src/model';
import { MockNapCat, until } from './fixture';
import { HistoryQueue } from '../src/historyQueue';
import { allowsMessageNotification, allowsUnread, countedUnread } from '../src/notifications';

test('历史队列为当前会话保留名额，重复请求复用，打开会话提升排队优先级', async () => {
  const queue = new HistoryQueue(), started: string[] = [], release = new Map<string, () => void>();
  const run = (key: string) => async () => { started.push(key); await new Promise<void>(r => release.set(key, r)); };
  const a = queue.request('a', 2, run('a')), b = queue.request('b', 2, run('b'));
  const recent = queue.request('recent', 2, run('recent')), open = queue.request('open', 1, run('open'));
  await until(() => started.length === 2);
  assert.deepEqual(started, ['a', 'b']);
  assert.equal(queue.request('open', 0, run('duplicate')), open);
  await until(() => started.length === 3); assert.equal(started[2], 'open');
  release.get('open')!(); await open;
  release.get('a')!(); await a;
  await until(() => started.includes('recent'));
  release.get('b')!(); release.get('recent')!(); await Promise.all([b, recent]);
  await assert.rejects(queue.request('failure', 0, async () => { throw new Error('retry'); }));
  await queue.request('failure', 0, async () => { started.push('retried'); });
  assert.ok(started.includes('retried'));
});

test('清理连接时丢弃尚未开始的历史任务', async () => {
  const queue = new HistoryQueue(); let release!: () => void;
  const pending = new Promise<void>(r => release = r);
  const a = queue.request('a', 2, () => pending), b = queue.request('b', 2, () => pending);
  let ran = false; const queued = queue.request('old', 2, async () => { ran = true; });
  queue.clear(); await queued; assert.equal(ran, false); release(); await Promise.all([a, b]);
});

test('状态事件区分消息、已读、收藏与成员，不让非正文更新触发全文渲染', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-events-')), store = new ChatStore(folder, '123');
  const changes: StoreChange[] = [];
  store.on('change', (_key, kind) => changes.push(kind));
  try {
    store.upsert(newChat('group', 1, '群'));
    store.add(parseMessage({ message_id: 1, user_id: 456, message: '文字' }, 'group:1', '123'), true);
    store.markRead('group:1'); store.toggleFavorite('group:1'); store.setNotification('group:1', 'muted'); store.setMembers('group:1', []);
    assert.deepEqual(changes, ['chat', 'messages', 'unread', 'favorites', 'notification', 'members']);
  } finally { await store.dispose(); await fs.rm(folder, { recursive: true, force: true }); }
});

test('旧 v2 缓存的 @ 和文件迁移为明确消息类型，普通 @ 文本保持原样', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-migration-')), store = new ChatStore(folder, '123');
  const chat = newChat('group', 1, '群');
  const message = { ...parseMessage({ message_id: 1, user_id: 456, message: '' }, chat.key), segments: [
    { type: 'text', text: '@789', at: '789' }, { type: 'text', text: ' @789 ' },
    { type: 'text', text: '[文件:a.txt]', file: { id: 'file-1', name: 'a.txt' } }
  ] };
  try {
    await fs.writeFile(path.join(folder, 'state.json'), JSON.stringify({ version: 2, chats: [chat] }));
    await fs.writeFile(path.join(folder, 'group-1.json'), JSON.stringify([message]));
    await store.restore(); await store.load(chat.key);
    assert.deepEqual(store.messages.get(chat.key)![0].segments.map(s => s.type), ['mention', 'text', 'file']);
    store.setMembers(chat.key, [{ user_id: 789, card: '名片' }]);
    assert.equal(messageText(store.displayMessages(chat.key)[0]), '[@:名片] @789 [文件:a.txt]');
    store.history(chat.key, []); await store.flush();
    const persisted = JSON.parse(await fs.readFile(path.join(folder, 'group-1.json'), 'utf8'));
    assert.equal(persisted[0].segments[0].qq, '789');
  } finally { await store.dispose(); await fs.rm(folder, { recursive: true, force: true }); }
});

test('发送提交立即清空草稿、旧连接排队任务不串入新连接、明确失败可重试', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-outbox-')), store = new ChatStore(folder, '123456');
  const backend = new MockNapCat(), client = new OneBotClient(), session = new AccountSession();
  await backend.start(); await client.connect(backend.url); store.upsert(newChat('group', 20002, '群'));
  const outbox = new OutboxService({ store, client, session, ready: true, log: () => {} });
  try {
    backend.sendDelay = 150;
    store.setDraft('group:20002', '第一条');
    const first = outbox.submit(store, 'group:20002', '第一条');
    assert.equal(store.draft('group:20002').text, '');
    assert.ok(store.outbox.has(first.messageIds[0]));
    await until(() => backend.sent.length === 1);
    const second = outbox.submit(store, 'group:20002', '旧连接队列');
    const token = session.capture(); session.advance(); assert.equal(token.current(), false); assert.equal(token.signal.aborted, true);
    store.setDraft('group:20002', '新草稿');
    assert.equal(await first.completion, true); assert.equal(await second.completion, false);
    assert.equal(backend.sent.length, 1); assert.equal(store.draft('group:20002').text, '新草稿');
    backend.sendDelay = 0; backend.failSend = true;
    const failure = outbox.submit(store, 'group:20002', '拒绝发送');
    assert.equal(await failure.completion, false);
    const failed = store.messages.get('group:20002')!.find(m => m.id === failure.messageIds[0])!;
    assert.equal(failed.sendState, 'failed');
    backend.failSend = false; assert.equal(await outbox.enqueue(store, failed), true);
    assert.equal(store.messages.get('group:20002')!.filter(m => m.sendState === 'sent').length, 2);
  } finally { client.dispose(); await backend.close(); await store.dispose(); await fs.rm(folder, { recursive: true, force: true }); }
});

test('账号绑定串行执行，过期任务可跳过且失败不阻断下一次绑定', async () => {
  const session = new AccountSession(), events: string[] = [];
  const old = session.capture(); let release!: () => void;
  const first = session.bind(async () => { await new Promise<void>(r => release = r); if (old.current()) events.push('old'); });
  await Promise.resolve(); await Promise.resolve(); session.advance();
  const second = session.bind(async () => { events.push('new'); }); release();
  await Promise.all([first, second]); assert.deepEqual(events, ['new']);
  await assert.rejects(session.bind(async () => { throw new Error('binding failed'); }));
  await session.bind(async () => { events.push('recovered'); }); assert.deepEqual(events, ['new', 'recovered']);
});

test('运行时设置定义与扩展注册一致，全部校验通过后才生成更新', async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(process.cwd(), 'package.json'), 'utf8'));
  for (const [key, definition] of Object.entries(chatSettings)) {
    const registered = manifest.contributes.configuration.properties[`qq.${key}`];
    for (const [property, value] of Object.entries(definition)) assert.deepEqual(registered[property], value, `${key}.${property}`);
  }
  assert.throws(() => validateChatSettings({ historyCount: 50, cacheRetentionDays: 0 }));
  assert.throws(() => validateChatSettings({ codeLanguage: 'invalid' }));
  for (const value of ['false', 0, null, []]) assert.throws(() => validateChatSettings({ showAvatars: value }));
  for (const value of [true, false]) assert.deepEqual(validateChatSettings({ showAvatars: value }), [['showAvatars', value]]);
  for (const value of ['emojis', ['invalid'], ['emojis', 'emojis'], [1]]) assert.throws(() => validateChatSettings({ statusBarButtons: value }));
  assert.deepEqual(validateChatSettings({ statusBarButtons: [] }), [['statusBarButtons', []]]);
  assert.deepEqual(validateChatSettings({ cacheRetentionDays: 7, replyColor: '#123456' }), [['cacheRetentionDays', 7], ['replyColor', '#123456']]);
});


test('免打扰例外只属于当前消息，未读会话的 @/回复标记不会让普通后续消息继续提醒', () => {
  const chat = { ...newChat('group', 1, '免打扰群'), notification: 'muted' as const, unread: 3, mentioned: true, replied: true };
  assert.equal(allowsUnread(chat), true);
  assert.equal(allowsMessageNotification(chat, false, false), false);
  assert.equal(allowsMessageNotification(chat, true, false), true);
  assert.equal(allowsMessageNotification(chat, false, true), true);
  assert.equal(allowsMessageNotification({ ...chat, notification: 'unknown' }, false, false), false);
  assert.equal(allowsMessageNotification({ ...chat, ignoreUnread: true }, true, true), false);
  assert.equal(allowsMessageNotification({ ...chat, notification: 'notify' }, false, false), true);
});

test('底栏计数不因提及或回复而计入整群免打扰未读，不提醒私聊及未知群也不计入', () => {
  const quiet = { ...newChat('group', 1, '免打扰'), notification: 'muted' as const, unread: 13418, mentioned: true, replied: true };
  const notifying = { ...newChat('group', 2, '提醒'), notification: 'notify' as const, unread: 3 };
  const friend = { ...newChat('private', 3, '好友'), unread: 2 };
  assert.equal([quiet, notifying, friend].reduce((sum, chat) => sum + countedUnread(chat), 0), 5);
  assert.equal(countedUnread({ ...quiet, notification: 'unknown' }), 0);
  assert.equal(countedUnread({ ...notifying, ignoreUnread: true }), 0);
  assert.equal(countedUnread({ ...friend, notification: 'muted', mentioned: true }), 0);
  assert.equal(countedUnread({ ...friend, ignoreUnread: true }), 0);
});


test('具名提及绑定真实号码，同名、改名、重启和失败重试都不换人', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-named-mentions-')), store = new ChatStore(folder, '123456');
  const backend = new MockNapCat(), client = new OneBotClient(), session = new AccountSession();
  await backend.start(); await client.connect(backend.url); store.upsert(newChat('group', 20002, '群'));
  const outbox = new OutboxService({ store, client, session, ready: true, log: () => {} });
  try {
    const a = store.reserveMention('group:20002', '10001', '同名'), b = store.reserveMention('group:20002', '10002', '同名');
    assert.equal(a, '[@:同名]'); assert.notEqual(a, b);
    const special = store.reserveMention('group:20002', '10003', '名字[带]括号\n换行');
    assert.equal(special, '[@:名字［带］括号 换行]');
    store.setDraft('group:20002', `前${a}中${b}后`); await store.flush();
    const restored = new ChatStore(folder, '123456');
    try {
      await restored.restore(); assert.equal(restored.draft('group:20002').mentions?.[a], '10001');
      assert.equal(restored.draft('group:20002').mentions?.[b], '10002');
    } finally { await restored.dispose(); }
    backend.failSend = true;
    const pending = outbox.submit(store, 'group:20002', store.draft('group:20002').text);
    assert.equal(store.draft('group:20002').text, '');
    assert.equal(await pending.completion, false);
    const capturedBindings = store.messages.get('group:20002')!.find(m => m.id === pending.messageIds[0])!.outgoing!.mentions!;
    const later = store.reserveMention('group:20002', '10004', '稍后候选');
    assert.equal(capturedBindings[later], undefined, '待发送绑定快照不被新候选修改');
    store.setMembers('group:20002', [{ user_id: 10001, card: '改名' }, { user_id: 99999, card: '同名' }]);
    backend.failSend = false;
    const failed = store.messages.get('group:20002')!.find(m => m.id === pending.messageIds[0])!;
    assert.equal(await outbox.enqueue(store, failed), true);
    assert.deepEqual(backend.sent.at(-1).message.map((s: any) => s.type === 'at' ? s.data.qq : s.data.text), ['前', '10001', '中', '10002', '后']);
    const deleted = outbox.submit(store, 'group:20002', '已删除占位符'); assert.equal(await deleted.completion, true);
    assert.ok(backend.sent.at(-1).message.every((s: any) => s.type !== 'at'));
    store.setDraft('group:20002', '[@:没有绑定]'); const count = store.messages.get('group:20002')!.length;
    assert.throws(() => outbox.submit(store, 'group:20002', '[@:没有绑定]'), /没有对应群成员/);
    assert.equal(store.draft('group:20002').text, '[@:没有绑定]'); assert.equal(store.messages.get('group:20002')!.length, count);
    const legacy = outbox.submit(store, 'group:20002', '@[10001] 旧草稿'); assert.equal(await legacy.completion, true);
    assert.equal(backend.sent.at(-1).message[0].data.qq, '10001');
  } finally { client.dispose(); await backend.close(); await store.dispose(); await fs.rm(folder, { recursive: true, force: true }); }
});

test('群折叠按账号保存，好友不能折叠，收藏和未读仍保留', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-folded-')), store = new ChatStore(folder, '123');
  try {
    const group = newChat('group', 1, '群'), friend = newChat('private', 2, '友'); store.upsert(group); store.upsert(friend);
    store.toggleFavorite(group.key); group.unread = 3;
    store.toggleCollapsed(group.key); store.toggleCollapsed(friend.key); await store.flush();
    assert.deepEqual([...store.collapsed], [group.key]); assert.equal(group.unread, 3); assert.ok(store.favorites.has(group.key));
    const restored = new ChatStore(folder, '123');
    try {
      await restored.restore(); assert.ok(restored.collapsed.has(group.key)); assert.ok(restored.favorites.has(group.key));
      restored.toggleCollapsed(group.key); assert.equal(restored.collapsed.size, 0);
    } finally { await restored.dispose(); }
  } finally { await store.dispose(); await fs.rm(folder, { recursive: true, force: true }); }
});
