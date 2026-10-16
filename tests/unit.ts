import './historyEdits';
import './mediaLimits';
import './forwardDelivery';
import './forwardSources';
import './fileNotices';
import './operationLocks';
import './fileDelivery';
import './deliveryChecks';
import './fileReceipt';
import './resourceTransfer';
import './forward';
import './architecture';
import './slash';
import './replies';
import './recall';
import { renderTranscript } from '../src/transcriptRenderer';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { once } from 'node:events';
import { newChat, parseMessage, messageText, mergeMessages, draftParts } from '../src/model';
import { OneBotClient, OneBotRequestError } from '../src/onebot';
import { ChatStore } from '../src/store';
import { MediaCache, imageExtension, previewDimensions } from '../src/media';
import { allowsUnread, groupNotification, NotificationSync } from '../src/notifications';
import { AttachmentFiles } from '../src/attachments';
import { MockNapCat, sendEventTimeout, png } from './fixture';
import { codeLanguages, codeStyle, isCodeLanguage } from '../src/codeStyle';

test('八种代码风格保留原文、图片、引用和操作位置', () => {
  const raw = '😀 "$name"\\\n第二行 ${value}\t[回复][重试]';
  const msg = parseMessage({ message_id: 42, user_id: 123, message: [
    { type: 'reply', data: { id: '99' } }, { type: 'text', data: { text: raw } },
    { type: 'image', data: { file: 'a' } }, { type: 'text', data: { text: '\n末行' } }, { type: 'image', data: { file: 'b' } }
  ] }, 'group:1', '123');
  msg.sendState = 'failed';
  const chat = newChat('group', '1', '测试 $chat'), snapshot = JSON.stringify(msg);
  const markers = {
    c: ['void send_reply_123(void) {', 'char msg[] ='], python: ['def send_reply_123():', 'msg = ('],
    javascript: ['function send_reply_123() {', 'const msg ='], typescript: ['function send_reply_123(): void {', 'const msg: string ='],
    dart: ['void send_reply_123() {', 'String msg ='], kotlin: ['fun send_reply_123() {', 'val msg ='],
    java: ['void send_reply_123() {', 'String msg ='], swift: ['func send_reply_123() {', 'let msg =']
  };
  for (const language of codeLanguages) {
    const view = renderTranscript(chat, [msg], '123', language), lines = view.text.split('\n');
    for (const marker of markers[language]) assert.ok(view.text.includes(marker), `${language}: ${marker}`);
    assert.equal(view.images.length, 2);
    for (const span of view.images) assert.equal(lines[span.line].slice(span.start, span.end), '[图片]');
    assert.ok(view.actions.some(a => a.kind === 'reply')); assert.equal(view.actions.filter(a => a.kind === 'retry').length, 1);
    for (const action of view.actions) {
      assert.ok(lines[action.line].slice(action.start, action.end).length);
      if (action.kind === 'retry') assert.equal(lines[action.line].slice(action.start, action.end), '[重试]');
      assert.equal(view.messages.get(action.line), msg.id);
    }
    assert.ok(view.ownLines.includes(view.starts.get(msg.id)!));
    assert.ok(view.text.includes('replay'));
    assert.ok(renderTranscript(chat, [], '123', language).text.includes('暂无消息'));
    if (language === 'dart' || language === 'kotlin') {
      assert.ok(view.text.includes('\\$name')); assert.ok(view.text.includes('\\${value}'));
    }
    if (['javascript', 'typescript', 'kotlin', 'java', 'swift'].includes(language)) assert.ok(view.text.includes('\\n" +\n'));
    assert.equal(JSON.stringify(msg), snapshot);
  }
  assert.equal(renderTranscript(chat, [msg], '123').text, renderTranscript(chat, [msg], '123', 'c').text);
  assert.equal(messageText(msg), raw + '[图片]\n末行[图片]');
  for (const invalid of [undefined, null, '', 'ruby', {}, 1]) assert.equal(isCodeLanguage(invalid), false);
  assert.equal(codeStyle('swift').escape('\\u2028\\b\\f'), '\\u{2028}\\u{0008}\\u{000c}');
  assert.equal(codeStyle('swift').escape('\\\\u2028'), '\\\\u2028');
  assert.equal(codeStyle('kotlin').escape('\\f\\\\f'), '\\u000c\\\\f');
});

test('八种风格兼容回复图片、特殊文件名、取消操作与提醒高亮', () => {
  const source = parseMessage({ message_id: 10, user_id: 123, message: [
    { type: 'text', data: { text: '$name\n' } }, { type: 'image', data: { file: 'a' } }
  ] }, 'group:1', '123');
  const reply = parseMessage({ message_id: 11, user_id: 456, message: [
    { type: 'reply', data: { id: 10 } },
    { type: 'file', data: { file_id: 'f', name: '$报告.txt', size: 3 } }
  ] }, 'group:1', '123');
  const queued = { ...source, id: 'local:queue', sendState: 'queued' as const };
  for (const language of codeLanguages) {
    const view = renderTranscript(newChat('group', 1, '群'), [source, reply, queued], '123', language);
    const lines = view.text.split('\n');
    const image = view.images.find(s => s.messageId === '10' && lines[s.line].includes('replay'))!;
    assert.ok(image, language); assert.equal(lines[image.line].slice(image.start, image.end), '[图片]');
    const file = view.files[0];
    const expected = codeStyle(language).escape('[文件:$报告.txt]');
    assert.equal(lines[file.line].slice(file.start, file.end), expected, language);
    assert.ok(view.replyLines.length, language);
    assert.ok(view.ownLines.length, language);
    const cancel = view.actions.find(a => a.kind === 'cancel')!;
    assert.equal(lines[cancel.line].slice(cancel.start, cancel.start + 4), '[取消]');
    const mention = renderTranscript(newChat('group', 1, '群'), [source, { ...reply, mentioned: true }], '123', language);
    assert.ok(mention.mentionLines.length); assert.equal(mention.replyLines.length, 0);
  }
});

test('混合消息保留图片元数据、引用和 UTF-16 图片位置', () => {
  const msg = parseMessage({ message_id: 1, time: 1, sender: { user_id: 2, nickname: '张三' }, message: [
    { type: 'text', data: { text: '😀正文\n第二行' } }, { type: 'image', data: { file: 'a', url: 'https://example.com/a.png' } },
    { type: 'reply', data: { id: '99' } }, { type: 'image', data: { file: 'b' } }, { type: 'at', data: { qq: '123' } }
  ] }, 'group:1', '123');
  const view = renderTranscript(newChat('group', '1', '测试群'), [msg], '123');
  assert.equal(msg.replyId, '99'); assert.equal(msg.mentioned, true);
  assert.equal(view.images.length, 2);
  for (const span of view.images) assert.equal(view.text.split('\n')[span.line].slice(span.start, span.end), '[图片]');
  assert.equal(msg.segments[1].type, 'image');
  assert.equal(messageText(msg), '😀正文\n第二行[图片][图片]@123');
});

test('纯文本 [图片] 不是图片链接；陌生段降级为文字', () => {
  const msg = parseMessage({ message: [{ type: 'text', data: { text: '[图片] <script> [run](command:evil)' } }, { type: 'unknown', data: {} }] }, 'private:1');
  const view = renderTranscript(newChat('private', 1, '好友'), [msg], '123');
  assert.equal(view.images.length, 0); assert.ok(view.text.includes('[消息]')); assert.ok(view.text.includes('<script>'));
});

test('代码投影转义引号、反斜杠、控制字符；多行和图片位置仍准确', () => {
  const raw = '"\\ 😀\n第二行\t';
  const msg = parseMessage({ message_id: 42, sender: { nickname: '名"字' }, message: [{ type: 'text', data: { text: raw } }, { type: 'image', data: { file: 'x' } }] }, 'group:1');
  const view = renderTranscript(newChat('group', 1, '测试'), [msg], '123');
  assert.ok(view.text.startsWith('#define CHAT_NAME "测试"'));
  assert.ok(view.text.includes('void recv_')); assert.ok(view.text.includes('名\\"字'));
  assert.ok(view.text.includes('                 "第二行\\t[图片]";'));
  assert.equal(messageText(msg), raw + '[图片]');
  for (const s of view.images) assert.equal(view.text.split('\n')[s.line].slice(s.start, s.end), '[图片]');
});

test('DATE、头衔与名称字段保留操作位置，备注同行且省略额外昵称', () => {
  const original = parseMessage({ message_id: 10, user_id: 123, message: '原文' }, 'group:1', '123');
  const reply = parseMessage({ message_id: 11, sender: { user_id: 456, card: '群名片', title: '头衔', role: 'admin' }, message: [{ type: 'reply', data: { id: 10 } }, { type: 'text', data: { text: '[回复]\\n[重试]' } }] }, 'group:1', '123');
  reply.time = new Date(2026, 9, 15, 9, 5, 13).getTime() / 1000;
  reply.senderRemark = '好友备注'; reply.senderNickname = '不再额外显示的昵称';
  const mine = { ...original, id: 'local:failed', sendState: 'failed' as const };
  const view = renderTranscript(newChat('group', 1, '测试'), [original, reply, mine], '123');
  const lines = view.text.split('\n');
  assert.equal(lines[view.starts.get(reply.id)!], '#define DATE "2026-10-15 09:05:13"');
  assert.ok(view.text.includes('char title[] = "头衔";\n    char name[] = "群名片";  // 备注：好友备注\n    char replay[]'));
  assert.ok(!view.text.includes('INFO') && !view.text.includes('不再额外显示的昵称'));
  for (const language of codeLanguages) {
    const style = codeStyle(language);
    const text = renderTranscript(newChat('group', 1, '测试'), [reply], '123', language).text;
    assert.ok(text.includes(style.constant('DATE', ['"2026-10-15 09:05:13"'])), language);
    assert.ok(text.includes(style.string('title') + '头衔' + style.stringEnd), language);
    assert.ok(text.includes(style.string('name') + '群名片' + style.stringEnd + `  ${style.comment} 备注：好友备注`), language);
    const minimal = renderTranscript(newChat('private', 1, '好友'), [{ ...reply, senderTitle: '', senderRemark: reply.senderName }], '123', language).text;
    assert.ok(!minimal.includes(style.string('title')) && !minimal.includes('备注：'), language);
  }
  assert.ok(view.text.includes('void reply_456(void) {  // 管理员 · 回复我'));
  assert.ok(view.text.includes('char replay[] = "123：原文";'));
  assert.deepEqual([...new Set(view.actions.filter(a => a.kind === 'reply').map(a => a.messageId))], ['10', '11']);
  for (const a of view.actions) {
    assert.ok(lines[a.line].slice(a.start, a.end).length);
    assert.ok(a.kind === 'reply' ? lines[a.line].includes('char msg[]') && !lines[a.line].includes('// [回复]') : lines[a.line].startsWith('}  // 发送失败'));
  }
});

test('回复图片保留原消息索引，长文字截断不吞掉后续图片', () => {
  const original = parseMessage({ message_id: 10, user_id: 123, message: [
    { type: 'text', data: { text: '长'.repeat(180) } },
    { type: 'image', data: { file: 'one.png' } },
    { type: 'text', data: { text: '尾部' } },
    { type: 'image', data: { file: 'two.png' } }
  ] }, 'group:1', '123');
  const reply = parseMessage({ message_id: 11, user_id: 456, message: [
    { type: 'reply', data: { id: 10 } }, { type: 'text', data: { text: '回复' } }
  ] }, 'group:1', '123');
  const view = renderTranscript(newChat('group', 1, '测试'), [original, reply], '123');
  const lines = view.text.split('\n');
  const spans = view.images.filter(s => lines[s.line].includes('char replay[]'));
  assert.equal(spans.length, 2);
  assert.deepEqual(spans.map(s => [s.messageId, s.imageIndex]), [['10', 0], ['10', 1]]);
  for (const span of spans) assert.equal(lines[span.line].slice(span.start, span.end), '[图片]');
  assert.ok(lines[spans[0].line].includes('…[图片][图片]'));
});

test('悬浮图片限制宽高、保持比例、小图不放大', () => {
  const dimensions = (w: number, h: number) => { const bytes = Buffer.from(png); bytes.writeUInt32BE(w, 16); bytes.writeUInt32BE(h, 20); return previewDimensions(bytes); };
  assert.deepEqual(dimensions(4000, 1000), { width: 240, height: 60 });
  assert.deepEqual(dimensions(1000, 8000), { width: 20, height: 160 });
  assert.deepEqual(dimensions(80, 40), { width: 80, height: 40 });
});

test('免打扰只使用消息接收档位，未知群不显示未读，好友支持本地忽略', () => {
  const chat = newChat('group', 1, '群'); chat.unread = 9;
  for (const mask of [2, 3, 4, '4']) { chat.notification = groupNotification({ cmdUinMsgMask: mask }); assert.equal(allowsUnread(chat), false); }
  chat.notification = groupNotification({ group_all_shut: -1 }); assert.equal(allowsUnread(chat), false);
  chat.notification = groupNotification({ cmdUinMsgMask: 1, group_all_shut: -1 }); assert.equal(allowsUnread(chat), true);
  chat.ignoreUnread = true; assert.equal(allowsUnread(chat), false);
  chat.ignoreUnread = false; chat.notification = 'muted';
  chat.mentioned = true; assert.equal(allowsUnread(chat), true);
  chat.mentioned = false; chat.replied = true; assert.equal(allowsUnread(chat), true);
  chat.ignoreUnread = true; assert.equal(allowsUnread(chat), false);
  const friend = newChat('private', 1, '好友'); assert.equal(allowsUnread(friend), true);
  friend.ignoreUnread = true; assert.equal(allowsUnread(friend), false);
});

test('占位符按正文顺序展开，删除后不发送；重复可复用，未知标记拒绝发送', () => {
  const attachment = { id: 'x', kind: 'image' as const, label: '图', placeholder: '[图片:1]' };
  assert.deepEqual(draftParts('前[图片:1]后[图片:1]', [attachment]), ['前', attachment, '后', attachment]);
  assert.deepEqual(draftParts('删掉了图片', [attachment]), ['删掉了图片']);
  assert.throws(() => draftParts('[图片:2]', [attachment]), /没有对应附件/);
  assert.equal(draftParts('[图片:1]'.repeat(20), [attachment]).length, 20);
  assert.deepEqual(draftParts('[图片]', []), ['[图片]']);
});

test('自己发出的私聊根据 target_id 归入目标会话', () => {
  const msg = parseMessage({ message_type: 'private', user_id: 123, target_id: 456, message: 'hello' }, undefined, '123');
  assert.equal(msg.chatKey, 'private:456');
});

test('历史和实时消息去重，零 ID 消息独立保留', () => {
  const raw = { message_id: 1, time: 1, message: 'old' };
  const history = [parseMessage(raw, 'group:1')];
  const live = [parseMessage({ ...raw, message: 'new' }, 'group:1')];
  const merged = mergeMessages(history, live, 500);
  assert.equal(merged.length, 1); assert.equal(messageText(merged[0]), 'new');
  const zeros = [parseMessage({ message_id: 0 }, 'group:1'), parseMessage({ message_id: 0 }, 'group:1')];
  assert.equal(mergeMessages([], zeros, 500).length, 2);
});

test('缓存恢复、未读去重、收藏和草稿版本保护', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'vscodeqq-store-'));
  const store = new ChatStore(folder, '123');
  const chat = newChat('group', 1, '测试群'); store.upsert(chat);
  try {
    const msg = parseMessage({ message_id: 1, user_id: 2, message: 'hello' }, chat.key);
    assert.equal(store.add(msg, true), true); assert.equal(store.add(msg, true), false);
    assert.equal(chat.unread, 1);
    store.toggleFavorite(chat.key);
    const sent = store.setDraft(chat.key, '第一条'); store.setDraft(chat.key, '下一条');
    assert.equal(store.clearDraftIfVersion(chat.key, sent.version), false);
    await store.flush();
    const other = new ChatStore(folder, '123'); await other.restore(); await other.load(chat.key);
    assert.equal(other.draft(chat.key).text, '下一条'); assert.equal(other.messages.get(chat.key)?.length, 1);
    assert.equal(other.favorites.has(chat.key), true); assert.equal(other.chats.get(chat.key)?.unread, 1);
    other.markRead(chat.key); assert.equal(other.chats.get(chat.key)?.unread, 0);
    await other.dispose();
  } finally { await store.dispose(); await fs.rm(folder, { recursive: true, force: true }); }
});

test('收到新消息后保存不会覆盖尚未读取的磁盘历史', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'vscodeqq-merge-'));
  const first = new ChatStore(folder, '123');
  first.upsert(newChat('group', 1, '群'));
  first.add(parseMessage({ message_id: 1, time: 1, message: '历史' }, 'group:1'), false); await first.dispose();
  const second = new ChatStore(folder, '123');
  try {
    await second.restore(); second.add(parseMessage({ message_id: 2, time: 2, message: '新消息' }, 'group:1'), true); await second.flush();
    assert.deepEqual(second.messages.get('group:1')?.map(m => m.id), ['1', '2']);
  } finally { await second.dispose(); await fs.rm(folder, { recursive: true, force: true }); }
});

test('未完成的发送持久化、重启标为未确认，成功回执合并去重', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'vscodeqq-outbox-'));
  const store = new ChatStore(folder, '123'); const chat = newChat('group', 1, '群'); store.upsert(chat);
  try {
    const message = parseMessage({ user_id: 123, message: '待发送' }, chat.key, '123');
    message.sendState = 'sending'; message.outgoing = store.setDraft(chat.key, '待发送');
    store.add(message, false); store.completeSend(chat.key, message.outgoing); await store.flush();
    const restored = new ChatStore(folder, '123'); await restored.restore(); await restored.load(chat.key);
    assert.equal(restored.messages.get(chat.key)![0].sendState, 'uncertain');
    assert.equal(restored.messages.get(chat.key)![0].outgoing!.text, '待发送');
    const echo = { ...message, id: '101', outgoing: undefined, sendState: undefined };
    restored.add(echo, false); restored.settleOutgoing(chat.key, message.id, echo);
    assert.equal(restored.messages.get(chat.key)!.length, 1);
    assert.equal(restored.messages.get(chat.key)![0].sendState, 'sent');
    await restored.dispose();
  } finally { await store.dispose(); await fs.rm(folder, { recursive: true, force: true }); }
});

test('WebSocket echo、错误、超时和断线立即结束请求', async () => {
  const backend = new MockNapCat(); await backend.start();
  const client = new OneBotClient(5000);
  try {
    await client.connect(backend.url);
    const [a,b] = await Promise.all([client.call('echo', { n: 1 }), client.call('echo', { n: 2 })]);
    assert.equal(a.n, 1); assert.equal(b.n, 2);
    await assert.rejects(client.call('timeout', {}, 40), /超时/);
    backend.failSend = true;
    await assert.rejects(client.call('send_msg', { message: [] }), /请求失败/);
    await assert.rejects(client.call('disconnect', {}, 2000), /中断/);
  } finally { client.dispose(); await backend.close(); }
});

test('意外断线自动重连，手动断开后停止重连', async () => {
  const backend = new MockNapCat(); await backend.start();
  const client = new OneBotClient(20);
  try {
    await client.connect(backend.url);
    const connected = once(client, 'connected');
    await assert.rejects(client.call('disconnect'), /中断/); await connected;
    assert.equal(client.connected, true);
    client.disconnect(); await new Promise(r => setTimeout(r, 80)); assert.equal(client.connected, false);
  } finally { client.dispose(); await backend.close(); }
});

test('图片惰性下载、过期 URL 回退与缓存复用', async () => {
  const backend = new MockNapCat(); await backend.start();
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'vscodeqq-media-'));
  const client = new OneBotClient();
  try {
    await client.connect(backend.url); const media = new MediaCache(folder, client);
    const ref = { file: 'sample', url: 'file:///not-allowed.png' };
    const [a,b] = await Promise.all([media.get(ref), media.get(ref)]);
    assert.equal(a,b); assert.deepEqual(await fs.readFile(a), png);
    assert.equal(backend.calls.filter(c => c.action === 'get_image').length, 1);
    await media.get(ref); assert.equal(backend.calls.filter(c => c.action === 'get_image').length, 1);
    assert.equal(imageExtension(Buffer.from('<svg onload="evil()"></svg>')), undefined);
  } finally { client.dispose(); await backend.close(); await fs.rm(folder, { recursive: true, force: true }); }
});

test('图片和收藏表情转换成可供远端 NapCat 发送的消息段', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'vscodeqq-attachments-'));
  try {
    const files = new AttachmentFiles(folder);
    const picture = await files.stage(png, '测试图片');
    const sticker = await files.stage(png, '收藏表情', true);
    const segments = await files.segments([picture, sticker, { id: 'face', kind: 'face', label: '微笑', faceId: '14' }]) as any[];
    assert.equal(segments[0].data.file, `base64://${png.toString('base64')}`);
    assert.equal(segments[1].data.sub_type, 1);
    assert.deepEqual(segments[2], { type: 'face', data: { id: '14' } });
    await assert.rejects(files.stage(Buffer.from('<svg/>'), '不支持'), /请选择/);
    await assert.rejects(files.read({ ...picture, file: path.join(folder, '..', 'outside.png') }), /路径无效/);
  } finally { await fs.rm(folder, { recursive: true, force: true }); }
});

test('发送完成只移除已经发送的附件，保留新草稿与新附件', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'vscodeqq-draft-'));
  const store = new ChatStore(folder, '123');
  try {
    store.upsert(newChat('group', 1, '群'));
    store.attach('group:1', [{ id: 'first', kind: 'face', label: '微笑', faceId: '14' }]);
    const captured = store.draft('group:1');
    store.setDraft('group:1', '后续文字');
    store.attach('group:1', [{ id: 'second', kind: 'face', label: '赞', faceId: '76' }]);
    assert.equal(store.completeSend('group:1', captured), false);
    assert.equal(store.draft('group:1').text, '后续文字' + store.draft('group:1').attachments.find(a => a.id === 'second')!.placeholder);
    assert.deepEqual(store.draft('group:1').attachments.map(a => a.id), ['second']);
  } finally { await store.dispose(); await fs.rm(folder, { recursive: true, force: true }); }
});

test('最近表情按使用顺序去重，最多保留十个', async () => {
  const { rememberEmoji } = await import('../src/recentEmojis');
  let items: import('../src/recentEmojis').RecentEmoji[] = [];
  for (let i = 0; i < 12; i++) items = rememberEmoji(items, { id: String(i), kind: 'face', label: String(i), faceId: String(i) });
  assert.deepEqual(items.map(e => e.id), ['11','10','9','8','7','6','5','4','3','2']);
  items = rememberEmoji(items, { id: '5', kind: 'face', label: 'five', faceId: '5' });
  assert.equal(items.length, 10); assert.equal(items[0].id, '5'); assert.equal(items.filter(e => e.id === '5').length, 1);
});

test('文件占位符：删除不发送、同名不冲突、文件与文字按原顺序拆分', async () => {
  const { outgoingDrafts } = await import('../src/model');
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-files-'));
  const store = new ChatStore(folder, '123');
  try {
    store.upsert(newChat('group', '1', '群'));
    const first = { id: 'a', kind: 'file' as const, label: '报告.pdf', size: 10 };
    const second = { ...first, id: 'b' };
    const prepared = store.prepareAttachments('group:1', [first, second]);
    assert.deepEqual(prepared.map(a => a.placeholder), ['[文件:报告.pdf]', '[文件:报告.pdf (2)]']);
    assert.deepEqual(draftParts('删掉附件', prepared), ['删掉附件']);
    assert.throws(() => draftParts('[文件:不存在.txt]', prepared), /没有对应附件/);
    const draft = { text: '前[文件:报告.pdf]中[文件:报告.pdf (2)]后', version: 1, attachments: prepared };
    assert.deepEqual(outgoingDrafts(draft).map(d => d.text), ['前','[文件:报告.pdf]','中','[文件:报告.pdf (2)]','后']);
  } finally { await store.flush(); await fs.rm(folder, { recursive: true, force: true }); }
});

test('分块上传超过 16 MB 文件，字节完整且进度基于分片回执', async () => {
  const { uploadToNapCat } = await import('../src/fileUpload');
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-upload-'));
  const backend = new MockNapCat(); await backend.start();
  const client = new OneBotClient();
  try {
    const file = path.join(folder, 'large.bin'), bytes = Buffer.alloc(17 * 1024 * 1024 + 37, 73);
    await fs.writeFile(file, bytes); await client.connect(backend.url);
    const values: number[] = [];
    const remote = await uploadToNapCat(client, file, p => values.push(p.sent));
    assert.deepEqual(backend.uploadedBytes.get(remote), bytes);
    assert.equal(values[0], 0); assert.equal(values.at(-1), bytes.length);
    assert.ok(values.every((n, i) => !i || n >= values[i-1]));
    const chunks = backend.calls.filter(c => c.action === 'upload_file_stream' && c.params.chunk_data);
    assert.ok(chunks.length > 32);
    assert.ok(chunks.every(c => Buffer.from(c.params.chunk_data, 'base64').length <= 512 * 1024));
    assert.equal(backend.fileUploads.length, 0);
    await assert.rejects(uploadToNapCat(client, file, () => {}, () => { throw new Error('账号已切换'); }), /账号已切换/);
  } finally { client.dispose(); await backend.close(); await fs.rm(folder, { recursive: true, force: true }); }
});

test('发件箱不受历史上限影响，独立快照恢复并可结算', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-outbox-'));
  const store = new ChatStore(folder, '123', 50);
  let restored: ChatStore | undefined;
  try {
    store.upsert(newChat('group', 1, '群'));
    const pending = { ...parseMessage({ message_id: 'local:pending', time: 1, user_id: 123, message: '待发送' }, 'group:1', '123'), sendState: 'sending' as const, outgoing: { text: '待发送', version: 1, attachments: [] } };
    store.add(pending, false);
    for (let i = 0; i < 100; i++) store.add(parseMessage({ message_id: 100 + i, time: 2 + i, user_id: 456, message: '收到' }, 'group:1', '123'), true);
    assert.equal(store.messages.get('group:1')!.length, 51);
    assert.ok(store.messages.get('group:1')!.some(m => m.id === pending.id));
    await store.flush();
    // The outbox in the account snapshot remains usable independently of history.
    await fs.writeFile(path.join(folder, 'group-1.json'), '[]');
    restored = new ChatStore(folder, '123', 50); await restored.restore(); await restored.load('group:1');
    assert.equal(restored.outbox.get(pending.id)?.sendState, 'uncertain');
    assert.equal(restored.messages.get('group:1')![0].outgoing?.text, '待发送');
    restored.settleOutgoing('group:1', pending.id, { ...pending, id: '999', time: 200 });
    assert.equal(restored.outbox.size, 0);
    await restored.flush();
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(folder, 'state.json'), 'utf8')).outbox, []);
  } finally { await store.dispose(); await restored?.dispose(); await fs.rm(folder, { recursive: true, force: true }); }
});

test('提及和回复分色，提及优先，自发消息不混色，历史裁剪仍保留回复识别', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-highlight-'));
  const store = new ChatStore(folder, '123', 1);
  try {
    const chat = newChat('group', 1, '群'); store.upsert(chat);
    store.add(parseMessage({ message_id: 1, time: 1, user_id: 123, message: '我' }, chat.key, '123'), false);
    const reply = parseMessage({ message_id: 2, time: 2, user_id: 456, message: [{ type: 'reply', data: { id: 1 } }, { type: 'text', data: { text: '回复' } }] }, chat.key, '123');
    store.add(reply, true); assert.equal(reply.replyToSelf, true);
    const view = renderTranscript(chat, store.displayMessages(chat.key), '123');
    assert.ok(view.replyLines.length); assert.equal(view.mentionLines.length, 0); assert.ok(view.text.includes('回复我'));
    const both = { ...reply, mentioned: true };
    const second = renderTranscript(chat, [both], '123');
    assert.ok(second.mentionLines.length); assert.equal(second.replyLines.length, 0);
    const mine = renderTranscript(chat, [{ ...both, senderId: '123' }], '123');
    assert.ok(mine.ownLines.length); assert.equal(mine.attentionLines.length, 0);
    store.markRead(chat.key);
    assert.ok(renderTranscript(chat, store.displayMessages(chat.key), '123').replyLines.length);
  } finally { await store.dispose(); await fs.rm(folder, { recursive: true, force: true }); }
});

test('附件清理保护未打开会话、草稿和撤销引用，删除过期无引用副本', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-cache-'));
  const store = new ChatStore(folder, '123'); let restored: ChatStore | undefined;
  try {
    const files = new AttachmentFiles(path.join(folder, 'outgoing'));
    store.upsert(newChat('group', 1, '群'));
    const draft = await files.stage(png, '草稿'), pending = await files.stageFile(Buffer.from('pending'), '排队.txt'), unused = await files.stageFile(Buffer.from('unused'), '无引用.txt');
    store.attach('group:1', [draft]); store.setDraft('group:1', ''); // Undo reference retained.
    store.add({ ...parseMessage({ message_id: 'local:file', message: '文件' }, 'group:1', '123'), sendState: 'failed', outgoing: { text: '', version: 1, attachments: [pending] } }, false);
    const old = new Date(Date.now() - 10 * 86400000);
    for (const a of [draft, pending, unused]) await fs.utimes(a.file!, old, old);
    await store.flush(); restored = new ChatStore(folder, '123'); await restored.restore();
    assert.equal(await files.prune(await restored.attachmentReferences(), 7), 6);
    await fs.stat(draft.file!); await fs.stat(pending.file!); await assert.rejects(fs.stat(unused.file!));
    const fresh = await files.stageFile(Buffer.from('import'), '正在导入.txt');
    await files.prune(new Set(), 0); await fs.stat(fresh.file!);
  } finally { await store.dispose(); await restored?.dispose(); await fs.rm(folder, { recursive: true, force: true }); }
});

test('接收文件保留元数据，下载原子写入，取消不覆盖已有文件', async () => {
  const { downloadFile } = await import('../src/download');
  const backend = new MockNapCat(); await backend.start();
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-download-'));
  try {
    const msg = parseMessage({ message_id: 7, user_id: 456, message: [{ type: 'text', data: { text: '[文件:普通文字]' } }, { type: 'file', data: { file_id: 'file-7', name: '报告.txt', size: png.length, busid: 102 } }] }, 'group:1', '123');
    const rendered = renderTranscript(newChat('group', 1, '群'), [msg], '123');
    assert.equal(rendered.files.length, 2);
    const span = rendered.files[0]; assert.equal(rendered.text.split('\n')[span.line].slice(span.start, span.end), '[文件:报告.txt]');
    const file = path.join(folder, 'download.txt');
    await downloadFile(backend.imageUrl, file, new AbortController().signal);
    assert.deepEqual(await fs.readFile(file), png);
    const controller = new AbortController();
    await assert.rejects(downloadFile(backend.imageUrl, file, controller.signal, () => controller.abort()));
    assert.deepEqual(await fs.readFile(file), png);
    assert.deepEqual(await fs.readdir(folder), ['download.txt']);
  } finally { await backend.close(); await fs.rm(folder, { recursive: true, force: true }); }
});


test('真实 @ 按群名片/昵称显示，成员更新刷新引用，普通数字文本与原文不变', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-at-names-'));
  const store = new ChatStore(folder, '123');
  try {
    const chat = newChat('group', 1, '群'); store.upsert(chat);
    const message = parseMessage({ message_id: 10, user_id: 456, message: [
      { type: 'at', data: { qq: 789 } }, { type: 'text', data: { text: ' @789 ' } },
      { type: 'at', data: { qq: 'all' } }, { type: 'at', data: { qq: 999, name: '服务端昵称' } }
    ] }, chat.key, '123');
    const raw = messageText(message);
    store.add(message, false);
    store.add(parseMessage({ message_id: 11, user_id: 123, message: [
      { type: 'reply', data: { id: 10 } }, { type: 'text', data: { text: '回复' } }
    ] }, chat.key, '123'), false);
    assert.ok(messageText(store.displayMessages(chat.key)[0]).startsWith('[@:789]'));
    store.setMembers(chat.key, [{ user_id: 789, card: '群名片', nickname: '昵称' }]);
    assert.equal(messageText(store.displayMessages(chat.key)[0]), '[@:群名片] @789 [@:全体成员][@:服务端昵称]');
    const rendered = renderTranscript(chat, store.displayMessages(chat.key), '123');
    assert.ok(rendered.text.split('\n').some(l => l.includes('replay') && l.includes('[@:群名片]')));
    assert.equal(messageText(message), raw);
    store.setMembers(chat.key, [{ user_id: 789, nickname: '新昵称' }]);
    assert.ok(messageText(store.displayMessages(chat.key)[0]).startsWith('[@:新昵称]'));
    await store.flush();
    const restored = new ChatStore(folder, '123');
    try {
      await restored.restore(); await restored.load(chat.key);
      restored.setMembers(chat.key, [{ user_id: 789, card: '恢复名片' }]);
      assert.ok(messageText(restored.displayMessages(chat.key)[0]).startsWith('[@:恢复名片]'));
    } finally { await restored.dispose(); }
  } finally { await store.dispose(); await fs.rm(folder, { recursive: true, force: true }); }
});


test('msg 回复与 name 提及仅绑定变量，正文可复制，发送成功不显示状态', () => {
  const message = parseMessage({ message_id: 45, sender: { user_id: 456, card: '群名片' }, message: [
    { type: 'text', data: { text: '正文 😀\n下一行' } }, { type: 'at', data: { qq: 789, name: '成员' } },
    { type: 'image', data: { file: 'a' } }, { type: 'file', data: { file_id: 'f', name: '报告.txt' } }
  ] }, 'group:1', '123');
  for (const language of codeLanguages) {
    const view = renderTranscript(newChat('group', 1, '群'), [message], '123', language), lines = view.text.split('\n');
    assert.equal(view.mentions.length, 2, language);
    const sender = view.mentions.find(s => s.kind === 'sender')!;
    assert.equal(sender.qq, '456'); assert.equal(sender.name, '群名片');
    assert.equal(lines[sender.line].slice(sender.start, sender.end), 'name', language);
    const replies = view.actions.filter(a => a.kind === 'reply');
    assert.equal(replies.length, 1, language);
    assert.equal(lines[replies[0].line].slice(replies[0].start, replies[0].end), 'msg', language);
    const overlaps = (a: { line: number; start: number; end: number }, b: typeof a) => a.line === b.line && a.start < b.end && b.start < a.end;
    for (const action of view.actions) for (const special of [...view.mentions, ...view.images, ...view.files]) assert.equal(overlaps(action, special), false, language);
    assert.ok(!view.text.includes('[回复]'), language);
    const sent = renderTranscript(newChat('group', 1, '群'), [{ ...message, senderId: '123', sendState: 'sent' }], '123', language);
    assert.ok(!sent.text.includes('已发送') && !sent.text.includes('发送中'), language);
    const sending = renderTranscript(newChat('group', 1, '群'), [{ ...message, senderId: '123', sendState: 'sending' }], '123', language);
    assert.ok(sending.text.includes('发送中'), language);
  }
});


test('NapCat 的 NTEvent 超时报文归为未确认，其他 1200 错误仍为明确拒绝', async () => {
  const backend = new MockNapCat(); await backend.start(); const client = new OneBotClient();
  try {
    await client.connect(backend.url); backend.emitSent = false;
    for (const failure of [{ retcode: 1200, message: sendEventTimeout }, { retcode: 1200, message: 'API error', wording: sendEventTimeout }]) {
      backend.sendFailure = failure;
      await assert.rejects(client.call('send_msg', { message: [], message_type: 'group', group_id: 1 }), error => error instanceof OneBotRequestError && error.kind === 'timeout');
    }
    backend.sendFailure = { retcode: 1200, message: '无权限，操作失败' };
    await assert.rejects(client.call('send_msg', { message: [], message_type: 'group', group_id: 1 }), error => error instanceof OneBotRequestError && error.kind === 'rejected');
  } finally { client.dispose(); await backend.close(); }
});

test('旧缓存中 NTEvent 发送失败恢复为未确认，普通失败保留原状态', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-timeout-restore-'));
  const store = new ChatStore(folder, '123');
  const make = (message_id: string, error: string) => ({ ...parseMessage({ message_id, user_id: 123, message: [{ type: 'text', data: { text: message_id } }] }, 'group:1', '123'),
    sendState: 'failed', sendError: error, outgoing: { text: message_id, attachments: [], version: 0 } });
  const messages = [make('local:1', sendEventTimeout), make('local:2', '权限不足')];
  try {
    await fs.writeFile(path.join(folder, 'state.json'), JSON.stringify({ chats: [newChat('group', 1, '测试')], outbox: messages }));
    await fs.writeFile(path.join(folder, 'group-1.json'), JSON.stringify(messages));
    await store.restore();
    assert.equal(store.outbox.get('local:1')!.sendState, 'uncertain'); assert.equal(store.outbox.get('local:2')!.sendState, 'failed');
    await store.load('group:1');
    assert.equal(store.messages.get('group:1')!.find(m => m.id === 'local:1')!.sendState, 'uncertain');
    assert.equal(store.messages.get('group:1')!.find(m => m.id === 'local:2')!.sendState, 'failed');
  } finally { await store.dispose(); await fs.rm(folder, { recursive: true, force: true }); }
});
