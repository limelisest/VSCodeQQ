import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notificationPreview } from '../src/notifications';

test('通知摘要保留会话与提醒原因，并把多行消息压成简短预览', () => {
  assert.equal(notificationPreview('研发组', '新消息', '下午三点开会'), '研发组 · 新消息：下午三点开会');
  assert.equal(notificationPreview('  研发\t组\n', '新消息', '\r\n 第一行\t第二行 \n 第三行  '), '研发 组 · 新消息： 第一行 第二行 第三行');
});

test('长会话名不会挤掉提醒原因和正文', () => {
  for (const name of ['研发协作群'.repeat(100), 'Long conversation name '.repeat(100)]) {
    const preview = notificationPreview(name, '有人回复你', '请查看设计图');
    assert.ok(preview.includes('… · 有人回复你：请查看设计图'));
    assert.ok(!preview.includes(name));
    assert.ok(preview.length <= 72);
  }
});

test('中英文长消息都只显示前部摘要并标明省略', () => {
  const chinese = notificationPreview('群', '新消息', '中'.repeat(200) + '正文末尾');
  const english = notificationPreview('群', '新消息', 'x'.repeat(200) + '正文末尾');
  for (const preview of [chinese, english]) {
    assert.ok(preview.startsWith('群 · 新消息：'));
    assert.ok(preview.endsWith('…'));
    assert.ok(!preview.includes('正文末尾'));
    assert.ok(preview.length <= 72);
  }
  assert.ok(english.length > chinese.length, '同样的显示空间应容纳更多窄英文字符');
});

test('摘要截断始终保留完整组合 emoji、旗帜与组合字符', () => {
  for (const cluster of ['👩🏽‍💻', '👨‍👩‍👧‍👦', '🇨🇳', 'e\u0301', '1️⃣']) {
    let retained = false, omitted = false;
    for (let padding = 0; padding < 80; padding++) {
      const prefix = 'a'.repeat(padding), suffix = 'z'.repeat(80);
      const body = notificationPreview('群', '消息', prefix + cluster + suffix).split('：')[1].replace(/…$/, '');
      const validPrefixes = new Set<string>();
      for (let length = 0; length <= padding; length++) validPrefixes.add('a'.repeat(length));
      for (let length = 0; length <= suffix.length; length++) validPrefixes.add(prefix + cluster + 'z'.repeat(length));
      assert.ok(validPrefixes.has(body), `截断破坏字素 ${JSON.stringify(cluster)}，前缀长度 ${padding}`);
      retained ||= body.includes(cluster); omitted ||= !body.includes(cluster);
    }
    assert.ok(retained && omitted, '测试必须覆盖字素保留与截断两侧');
  }
});

test('会话名、提醒原因和消息里的原生命令链接都保持为不可执行文本', () => {
  const links = ['[开](command:e)', '\\[看](command:e)', '[开](COMMAND:e)'];
  for (const link of links) {
    for (const values of [[link, '消息', '正文'], ['群', link, '正文'], ['群', '消息', link]]) {
      const preview = notificationPreview(...values as [string, string, string]);
      assert.ok(preview.includes('command:e') || preview.includes('COMMAND:e'), '保留消息可读内容');
      assert.doesNotMatch(preview, /\[[^\]]+\]\(command:/i, '原生通知不能解析用户提供的可执行链接');
      assert.ok(!preview.includes('[') && !preview.includes(']'));
    }
  }
});
