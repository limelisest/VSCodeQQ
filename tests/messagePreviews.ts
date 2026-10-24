import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ChatStore } from '../src/store';
import { newChat, parseMessage, messageText } from '../src/model';
import { renderTranscript } from '../src/transcriptRenderer';

const key = 'group:1';
const mention = (qq: string, name?: string) => ({ type: 'at', data: { qq, name } });
const message = (id: number, segments: unknown[], time = id) => parseMessage({ message_id: id, user_id: 456, sender: { user_id: 456, nickname: '发送者昵称' }, time, message: segments }, key, '123');

test('列表摘要随群成员与好友备注更新，纯文本显示名称，原始提及绑定不变', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-preview-names-')), store = new ChatStore(folder, '123');
  try {
    const chat = newChat('group', 1, '群'); store.upsert(chat);
    const incoming = message(1, [mention('789'), { type: 'text', data: { text: ' @789 ' } }, mention('888', '888'), mention('all')]);
    const raw = structuredClone(incoming.segments); store.add(incoming, true);
    assert.equal(chat.preview, '@789 @789 @888@全体成员');
    store.upsert({ ...newChat('private', 888, '好友备注'), remark: '好友备注', nickname: '好友昵称' });
    assert.equal(chat.preview, '@789 @789 @好友备注@全体成员');
    store.setMembers(key, [{ user_id: 789, card: '群名片' }, { user_id: 888 }, { user_id: 456 }]);
    assert.equal(chat.preview, '@群名片 @789 @好友备注@全体成员');
    assert.equal(store.displayMessage(incoming).senderName, '发送者昵称', '无名成员资料不能覆盖原消息昵称');
    store.setMembers(key, [{ user_id: 789, nickname: '新昵称' }]);
    assert.equal(chat.preview, '@新昵称 @789 @好友备注@全体成员');
    assert.equal(messageText(store.displayMessage(incoming)), chat.preview);
    assert.deepEqual(incoming.segments, raw); assert.equal(incoming.mentioned, true);
    assert.equal(store.messages.get(key)![0].segments[0].type, 'mention');
  } finally { await store.dispose(); await fs.rm(folder, { recursive: true, force: true }); }
});

test('回复引用随好友资料更新，纯回复与混合附件摘要可读，迟到原文不覆盖最新消息', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-preview-replies-')), store = new ChatStore(folder, '123');
  try {
    const chat = newChat('group', 1, '群'); store.upsert(chat);
    const source = message(1, [mention('888'), { type: 'text', data: { text: ' 原文' } }]);
    store.history(key, [source]);
    assert.equal(chat.preview, '@888 原文', '历史首屏也生成摘要');
    const reply = message(2, [{ type: 'reply', data: { id: '1' } }]);store.add(reply, true);
    assert.equal(chat.preview, '[回复消息]');
    const updates: string[] = [];store.on('change', (changed, kind) => { if (kind === 'members') updates.push(changed); });
    store.upsert({ ...newChat('private', 888, '新备注'), remark: '新备注' });
    assert.ok(updates.includes(key), '原文的提及名称更新必须通知引用所在会话');
    const rendered = renderTranscript(chat, store.displayMessages(key), '123');
    assert.ok(rendered.text.split('\n').some(line => line.includes('replay') && line.includes('[@:新备注]')));
    assert.equal(reply.replyId, '1');assert.equal(chat.preview, '[回复消息]');
    const media = message(3, [mention('all'), { type: 'image', data: { file: 'image' } }, { type: 'video', data: { file: 'video.mp4' } }, { type: 'file', data: { name: '报告.txt', file_id: 'file' } }, { type: 'forward', data: { id: 'forward' } }]);
    store.add(media, true);assert.equal(chat.preview, '@全体成员[图片][视频][文件:报告.txt][合并转发]');
    store.enrichMessage({ ...source, segments: [{ type: 'text', text: '迟到的原文详情' }] }, true);
    assert.equal(chat.preview, '@全体成员[图片][视频][文件:报告.txt][合并转发]');
    store.recall(key, '3');store.setMembers(key, [{ user_id: 888, card: '新群名片' }]);
    assert.equal(chat.preview, '[消息已撤回]');
    chat.lastTime = 100;chat.preview = '更新的未加载消息';store.history(key, [source]);
    assert.equal(chat.preview, '更新的未加载消息', '旧分页不能覆盖更新的会话摘要');
  } finally { await store.dispose(); await fs.rm(folder, { recursive: true, force: true }); }
});

test('旧缓存加载后重建摘要，提及原始号码与跨重启回复绑定保持不变', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-preview-restore-'));let store = new ChatStore(folder, '123');
  try {
    store.upsert(newChat('group', 1, '群'));
    store.add(message(1, [mention('789')]), true);await store.dispose();
    const statePath = path.join(folder, 'state.json'), state = JSON.parse(await fs.readFile(statePath, 'utf8'));
    state.chats[0].preview = '@789';await fs.writeFile(statePath, JSON.stringify(state));
    store = new ChatStore(folder, '123');await store.restore();store.setMembers(key, [{ user_id: 789, card: '恢复的群名片' }]);
    await store.load(key);assert.equal(store.chats.get(key)!.preview, '@恢复的群名片');
    assert.deepEqual(store.messages.get(key)![0].segments, [{ type: 'mention', qq: '789', name: undefined, text: '@789' }]);
    store.add(message(2, [{ type: 'reply', data: { id: '1' } }]), false);await store.dispose();
    store = new ChatStore(folder, '123');await store.restore();await store.load(key);
    assert.equal(store.chats.get(key)!.preview, '[回复消息]');assert.equal(store.messages.get(key)!.at(-1)!.replyId, '1');
  } finally { await store.dispose(); await fs.rm(folder, { recursive: true, force: true }); }
});

test('空会话与草稿不算消息，未加载历史仍按缓存时间、摘要或未读保留', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-list-presence-')), store = new ChatStore(folder, '123');
  try {
    for (const id of [1, 2, 3, 4, 5]) store.upsert(newChat('group', id, '群' + id));
    store.setDraft('group:1', '尚未发送的草稿');store.toggleFavorite('group:1');
    assert.equal(store.hasMessages('group:1'), false);
    store.chats.get('group:2')!.lastTime = 100;
    store.chats.get('group:3')!.preview = '[图片]';
    store.chats.get('group:4')!.unread = 1;
    for (const key of ['group:2', 'group:3', 'group:4']) { assert.equal(store.messages.has(key), false);assert.equal(store.hasMessages(key), true); }
    store.history('group:5', [parseMessage({ message_id: 1, user_id: 456, time: 0, message: [] }, 'group:5')]);
    assert.equal(store.hasMessages('group:5'), true, '没有正文或有效时间的真实消息也不能隐藏');
    store.add(parseMessage({ message_id: 2, user_id: 123, message: '第一条消息' }, 'group:1'), false);
    assert.equal(store.hasMessages('group:1'), true);
  } finally { await store.dispose(); await fs.rm(folder, { recursive: true, force: true }); }
});
