import { test } from 'node:test';
import assert from 'node:assert/strict';
import { historyEdits } from '../src/historyEdits';
import { renderTranscript } from '../src/transcriptRenderer';
import { newChat, parseMessage } from '../src/model';
import { codeLanguages } from '../src/codeStyle';

test('裁剪头部并追加尾部时不替换中间历史，八种风格和跨日均保持正确', () => {
  const messages = Array.from({ length: 6 }, (_, i) => parseMessage({
    message_id: i + 1, user_id: 2, time: 1792018800 + i * 86400,
    message: i === 2 ? '相同正文\n第二行[图片]' : '相同正文'
  }, 'group:1'));
  for (const language of codeLanguages) {
    const chat = newChat('group', 1, '测试群');
    const previous = renderTranscript(chat, messages.slice(0, 5), '1', language);
    const next = renderTranscript(chat, messages.slice(1), '1', language);
    const suffix = '\n// 固定草稿分隔线\n';
    const before = previous.text + suffix, after = next.text + suffix;
    const edits = historyEdits(before, after, previous, next);
    let applied = before;
    for (const edit of [...edits].reverse()) applied = applied.slice(0, edit.start) + edit.text + applied.slice(edit.end);
    assert.equal(applied, after, language);
    assert.ok(edits.length >= 2, language);
    const stableLine = previous.starts.get('3')!;
    const offset = previous.text.split('\n').slice(0, stableLine).join('\n').length + 1;
    assert.ok(!edits.some(edit => edit.start <= offset && edit.end > offset), language);
    assert.ok(edits.reduce((size, edit) => size + edit.end - edit.start, 0) < before.length / 2, language);
  }
});

test('状态、成员名、回复变化和消息重排仍产生精确完整的新文档', () => {
  const chat = newChat('group', 1, '群');
  const messages = [1, 2, 3, 4].map(i => parseMessage({ message_id: i, user_id: 2, message: '内容' + i }, chat.key));
  const previous = renderTranscript(chat, messages, '1');
  for (const changed of [[], [...messages].reverse(), [messages[3]],
    messages.map((m, i) => i === 1 ? { ...m, senderName: '新名称', replyId: '1', recalled: true } : m)]) {
    const next = renderTranscript(chat, changed, '1');
    let applied = previous.text;
    for (const edit of historyEdits(previous.text, next.text, previous, next).reverse()) applied = applied.slice(0, edit.start) + edit.text + applied.slice(edit.end);
    assert.equal(applied, next.text);
  }
  assert.deepEqual(historyEdits(previous.text, previous.text, previous, previous), []);
  assert.deepEqual(historyEdits('a😀z', 'a🙂z'), [{ start: 2, end: 3, text: '\ude42' }]);
});
