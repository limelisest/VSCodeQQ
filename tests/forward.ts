import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMessage, normalizeSegments, newChat, messageText } from '../src/model';
import { renderTranscript } from '../src/transcriptRenderer';
import { codeLanguages } from '../src/codeStyle';
import { forwardRequest, parseForwardMessages } from '../src/forwardMessages';

test('合并转发 ID 从消息和卡片解析，缓存往返保留，八种语言生成独立链接范围', () => {
  const m = parseMessage({ message_id: 1, user_id: 2, message: [
    { type: 'text', data: { text: '前文\n' } }, { type: 'forward', data: { id: 'resource-a' } },
    { type: 'json', data: { data: JSON.stringify({ app: 'com.tencent.multimsg', meta: { detail: { resid: 'resource-b' } } }) } },
    { type: 'json', data: { data: 'bad json' } }
  ] }, 'group:1');
  assert.deepEqual(normalizeSegments(JSON.parse(JSON.stringify(m.segments))), m.segments);
  assert.equal(messageText(m), '前文\n[合并转发][合并转发][卡片]');
  for (const language of codeLanguages) {
    const rendered = renderTranscript(newChat('group', '1', '群'), [m], '', language);
    assert.equal(rendered.forwards.length, 2);
    for (const span of rendered.forwards) {
      assert.equal(rendered.text.split('\n')[span.line].slice(span.start, span.end), '[合并转发]');
      assert.ok(!rendered.actions.some(a => a.line === span.line && a.start < span.end && a.end > span.start));
    }
  }
});
test('转发阅读兼容消息数组和 node 内容，重复或缺失 ID 保持各自图片与嵌套引用', () => {
  const messages = parseForwardMessages({ messages: [
    { message_id: 1, sender: { user_id: 2, nickname: '甲' }, time: 10, content: [{ type: 'text', data: { text: '原文' } }] },
    { type: 'node', data: { user_id: 3, nickname: '乙', time: 11, content: [{ type: 'image', data: { file: 'a' } }, { type: 'forward', data: { id: 'nested' } }] } },
    { message_id: 1, sender: { user_id: 4, nickname: '丙' }, message: '重复 ID' }
  ] }, 'private:1');
  assert.deepEqual(messages.map(m => m.id), ['forward:0', 'forward:1', 'forward:2']);
  assert.deepEqual(messages.map(m => m.senderName), ['甲', '乙', '丙']);
  assert.equal(messages[1].segments[1].type, 'forward');
  assert.equal(parseForwardMessages({ message: [] }, 'private:1').length, 0);
  assert.throws(() => parseForwardMessages({}, 'private:1'), /有效/);
  assert.throws(() => parseForwardMessages({ messages: [null] }, 'private:1'), /无效/);
  assert.throws(() => parseForwardMessages({ messages: Array(501).fill({}) }, 'private:1'), /500/);
});
test('单条和合并转发使用目标类型及原始消息引用，拒绝未发送和撤回消息', () => {
  const messages = [1, 2].map(message_id => parseMessage({ message_id, user_id: 3, message: 'test' }, 'group:1'));
  for (const type of ['group', 'private'] as const) {
    const target = newChat(type, '42', '目标');
    const single = forwardRequest(target, [messages[0]], false);
    assert.equal(single.action, type === 'group' ? 'forward_group_single_msg' : 'forward_friend_single_msg');
    assert.deepEqual(single.params, { [type === 'group' ? 'group_id' : 'user_id']: '42', message_id: '1' });
    const merged = forwardRequest(target, messages, true);
    assert.equal(merged.action, type === 'group' ? 'send_group_forward_msg' : 'send_private_forward_msg');
    assert.deepEqual(merged.params.messages, [{ type: 'node', data: { id: '1' } }, { type: 'node', data: { id: '2' } }]);
    assert.throws(() => forwardRequest(target, [{ ...messages[0], recalled: true }], true));
    assert.throws(() => forwardRequest(target, [{ ...messages[0], sendState: 'uncertain' }], false));
    assert.throws(() => forwardRequest(target, [], true));
    assert.throws(() => forwardRequest(target, Array(101).fill(messages[0]), true));
  }
});

test('NapCat 内嵌合并转发内容在解析和缓存往返后仍能读取嵌套记录', () => {
  const content = [{ sender: { user_id: 2, nickname: '甲' }, message: [{ type: 'forward', data: { id: 'nested-unqueryable', content: [{ sender: { user_id: 3, nickname: '乙' }, message: '嵌套正文' }] } }] }];
  const message = parseMessage({ message_id: 1, message: [{ type: 'forward', data: { id: '1234567890123456789', content } }] }, 'group:1');
  const segment = normalizeSegments(JSON.parse(JSON.stringify(message.segments)))[0];
  assert.equal(segment.type, 'forward');
  if (segment.type !== 'forward') throw new Error('missing forward');
  const nested = parseForwardMessages({ messages: segment.content }, 'group:1')[0].segments[0];
  assert.equal(nested.type, 'forward');
  if (nested.type !== 'forward') throw new Error('missing nested forward');
  assert.equal(messageText(parseForwardMessages({ messages: nested.content }, 'group:1')[0]), '嵌套正文');
});

test('查看页双向映射唯一回复，文字和图片引用保持节点链接', () => {
  const parsed = parseForwardMessages({ messages: [
    { message_id: 11, sender: { user_id: 2, nickname: '甲' }, message: [{ type: 'text', data: { text: '被引用原文' } }, { type: 'image', data: { file: 'image' } }, { type: 'forward', data: { id: 'nested' } }] },
    { message_id: 12, message: [{ type: 'reply', data: { id: 11 } }, { type: 'text', data: { text: '回复' } }] }
  ] }, 'group:1');
  assert.equal(parsed[1].replyId, parsed[0].id);
  const rendered = renderTranscript(newChat('group', '1', '群'), parsed, '');
  assert.ok(rendered.text.includes('甲：被引用原文[图片]'));
  assert.ok(!rendered.text.includes('未加载'));
  assert.equal(rendered.images.length, 2);
  assert.ok(rendered.images.every(s => s.messageId === parsed[0].id && s.imageIndex === 0));
  assert.equal(rendered.forwards[0].messageId, parsed[0].id);
});

test('重复、缺失、显示 ID 碰撞及嵌套回复不误关联', () => {
  const reply = (id: string) => [{ type: 'reply', data: { id } }];
  const parsed = parseForwardMessages({ messages: [
    { message_id: 11, message: '甲' }, { message_id: 11, message: '乙' },
    { message: reply('11') }, { message: reply('missing') }, { message: reply('forward:0') }
  ] }, 'group:1');
  assert.equal(new Set(parsed.map(m => m.id)).size, 5);
  assert.deepEqual(parsed.slice(2).map(m => m.replyId), ['11', 'missing', 'forward:0']);
  const rendered = renderTranscript(newChat('group', '1', '群'), parsed, '');
  assert.equal((rendered.text.match(/未加载/g) ?? []).length, 3);
  const outer = parseForwardMessages({ messages: [{ message_id: 11, message: '外层' }, { message: [{ type: 'forward', data: { id: 'nested', content: [{ message_id: 12, message: reply('11') }] } }] }] }, 'group:1');
  const nested = outer[1].segments[0]; assert.equal(nested.type, 'forward');
  if (nested.type !== 'forward') throw new Error('missing nested');
  const inner = parseForwardMessages({ messages: nested.content }, 'group:1');
  assert.equal(inner[0].replyId, '11');
  assert.ok(renderTranscript(newChat('group', '1', '群'), inner, '').text.includes('回复消息 11（未加载）'));
});
