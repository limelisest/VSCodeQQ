import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { newChat, parseMessage, messageText, normalizeSegments } from '../src/model';
import { ChatStore } from '../src/store';
import { renderTranscript } from '../src/transcriptRenderer';
import { codeLanguages } from '../src/codeStyle';

const peer = '2010741172', key = `private:${peer}`;
const card = { app: 'com.tencent.qqmail', prompt: '[QQ邮箱] 收到新邮件', meta: { detail: {
  title: '项目进度', sender: '测试发件人', desc: '第一行\r\n第二行 😀', url: 'https://mail.qq.com/'
} } };
const event = (format: 'json' | 'xml' = 'json', data: unknown = JSON.stringify(card)) => ({
  message_type: 'private', user_id: Number(peer), message_id: 101, time: 1700000000,
  sender: { user_id: peer, nickname: peer }, message: [{ type: format, data: { data } }]
});

test('QQ 邮箱数字身份只在私聊回退为名称，保留后端提供的名称', () => {
  for (const name of [undefined, '', peer, '  ']) assert.equal(newChat('private', peer, name).name, 'QQ邮箱');
  assert.equal(newChat('private', peer, '邮箱提醒').name, '邮箱提醒');
  assert.equal(newChat('group', peer, peer).name, peer);
  assert.equal(newChat('private', 12345, undefined).name, '12345');
  assert.equal(parseMessage(event()).senderName, 'QQ邮箱');
  assert.equal(parseMessage({ ...event(), message_type: 'group', group_id: 123 }).senderName, peer);
});

test('JSON 卡片展示标题、发件人、摘要与网页地址，缓存保留原始卡片', () => {
  for (const data of [JSON.stringify(card), card]) {
    const message = parseMessage(event('json', data));
    const text = messageText(message);
    assert.equal(text, '项目进度\n测试发件人\n第一行\n第二行 😀\n[QQ邮箱] 收到新邮件\nhttps://mail.qq.com/');
    const restored = normalizeSegments(JSON.parse(JSON.stringify(message.segments)));
    assert.deepEqual(restored, message.segments);
    const stale = message.segments.map(s => ({ ...s, text: '[卡片]' }));
    assert.equal(messageText({ ...message, segments: normalizeSegments(stale) }), text);
    for (const language of codeLanguages) {
      const view = renderTranscript(newChat('private', peer, peer), [message], '123', language);
      assert.ok(view.text.includes('QQ邮箱')); assert.ok(view.text.includes('项目进度'));
      assert.ok(view.text.includes('https://mail.qq.com/')); assert.equal(view.images.length, 0);
    }
  }
});

test('XML 卡片解析 CDATA、文本实体与来源，不执行卡片动作', () => {
  const xml = '<?xml version="1.0"?><msg brief="QQ邮箱新邮件" url="https://mail.qq.com/?a=1&amp;b=2">'
    + '<item><title><![CDATA[项目 <进度>]]></title><summary>摘要 &amp; 详情 &#x1F600; &#65;</summary></item>'
    + '<source name="QQ邮箱" actionUrl="mqqapi://mail/open"/></msg>';
  const message = parseMessage(event('xml', xml));
  assert.equal(messageText(message), '项目 <进度>\n摘要 & 详情 😀 A\nQQ邮箱新邮件\nQQ邮箱\nhttps://mail.qq.com/?a=1&b=2');
  assert.deepEqual(normalizeSegments(message.segments), message.segments);
});

test('卡片兼容 prompt、嵌套列表，异常内容回退，合并转发仍可打开', () => {
  const parse = (data: unknown) => messageText(parseMessage(event('json', data)));
  assert.equal(parse({ prompt: '[通知] 新消息' }), '[通知] 新消息');
  assert.equal(parse({ meta: { news: [{ title: '主题', desc: '主题', jumpUrl: 'https://mail.qq.com/' }] } }), '主题\nhttps://mail.qq.com/');
  for (const data of ['bad json', null, '[]', '{}', '{"app":"unknown","meta":{"id":123}}', { meta: { detail: { url: 'command:evil', jumpUrl: 'javascript:alert(1)' } } }]) assert.equal(parse(data), '[卡片]');
  for (const data of [undefined, 'bad xml', '<msg><title>缺少结束标签']) assert.equal(messageText(parseMessage(event('xml', data))), '[卡片]');
  const forwarded = parseMessage(event('json', { app: 'com.tencent.multimsg', meta: { detail: { resid: 'forward-123' } } }));
  assert.deepEqual(forwarded.segments, [{ type: 'forward', id: 'forward-123', text: '[合并转发]' }]);
});

test('旧数字会话缓存升级名称，历史补全卡片及预览，保留未读、草稿和撤回状态', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-cards-'));
  const store = new ChatStore(folder, '123'), restored = new ChatStore(folder, '123');
  const fresh = parseMessage(event());
  const old = { ...fresh, senderName: peer, segments: [{ type: 'text', text: '[卡片]' }], replyId: '99' };
  try {
    await fs.writeFile(path.join(folder, 'state.json'), JSON.stringify({ chats: [{ ...newChat('private', peer, peer), name: peer, unread: 2, preview: '[卡片]', lastTime: fresh.time }], drafts: { [key]: { text: '草稿', attachments: [], version: 1 } } }));
    await fs.writeFile(path.join(folder, `private-${peer}.json`), JSON.stringify([old]));
    await store.restore(); await store.load(key);
    assert.equal(store.chats.get(key)!.name, 'QQ邮箱');
    store.history(key, [fresh]);
    assert.equal(messageText(store.displayMessages(key)[0]), messageText(fresh));
    assert.equal(store.displayMessages(key)[0].senderName, 'QQ邮箱');
    assert.ok(store.chats.get(key)!.preview.includes('项目进度'));
    assert.equal(store.messages.get(key)![0].replyId, '99');
    assert.equal(store.chats.get(key)!.unread, 2); assert.equal(store.draft(key).text, '草稿');
    await store.flush(); await restored.restore(); await restored.load(key);
    assert.equal(messageText(restored.displayMessages(key)[0]), messageText(fresh));
    store.recall(key, fresh.id); store.history(key, [fresh]);
    assert.equal(store.messages.get(key)![0].recalled, true);
    assert.equal(store.chats.get(key)!.preview, '[消息已撤回]');
  } finally { await store.dispose(); await restored.dispose(); await fs.rm(folder, { recursive: true, force: true }); }
});
