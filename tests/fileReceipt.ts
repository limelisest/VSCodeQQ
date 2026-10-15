import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OneBotClient } from '../src/onebot';
import { FileReceipt } from '../src/fileReceipt';
import { Attachment } from '../src/model';

const file: Attachment = { id: 'local-file', kind: 'file', label: '回执.txt', size: 5 };
const echo = (message_id: number) => ({ post_type: 'message_sent', self_id: 123, message_type: 'group', group_id: 1,
  user_id: 123, message_id, message: [{ type: 'file', data: { file_id: 'uuid', file: '回执.txt', file_size: 5 } }] });

test('文件回显只匹配本次新增的同账号、会话、文件名和大小，忽略旧消息及其他文件', async () => {
  const client = new OneBotClient(), receipt = new FileReceipt(client, '123', 'group:1', file, new Set(['1']), new AbortController().signal);
  try {
    for (const raw of [echo(1), { ...echo(2), self_id: 456 }, { ...echo(3), user_id: 456 }, { ...echo(4), group_id: 2 },
      { ...echo(5), post_type: 'message' }, { ...echo(6), message: [{ type: 'file', data: { file_id: 'uuid', file: '回执.txt' } }] },
      { ...echo(7), message: [{ type: 'file', data: { file_id: 'uuid', file: '回执.txt', file_size: 6 } }] }]) client.emit('event', raw);
    client.emit('event', echo(99));
    assert.equal((await receipt.wait())!.id, '99');
  } finally { receipt.dispose(); assert.equal(client.listenerCount('event'), 0); client.dispose(); }
});

test('多个候选回显不猜测关联；连接失效立即结束等待并释放监听', async () => {
  const client = new OneBotClient(), controller = new AbortController();
  const receipt = new FileReceipt(client, '123', 'group:1', file, new Set(), controller.signal);
  try {
    client.emit('event', echo(1)); client.emit('event', echo(2));
    assert.equal(await receipt.wait(), undefined);
  } finally { receipt.dispose(); }
  const waiting = new FileReceipt(client, '123', 'group:1', file, new Set(), controller.signal);
  try {
    const result = waiting.wait(); controller.abort(); assert.equal(await result, undefined);
    client.emit('event', echo(3)); assert.equal(await waiting.wait(), undefined);
  } finally { waiting.dispose(); assert.equal(client.listenerCount('event'), 0); client.dispose(); }
});

test('接口报错后稍晚到达的文件回显仍可确认，不增加 API 查询', async () => {
  const client = new OneBotClient(), receipt = new FileReceipt(client, '123', 'group:1', file, new Set(), new AbortController().signal);
  try {
    const result = receipt.wait();
    setTimeout(() => client.emit('event', echo(5)), 20);
    assert.equal((await result)!.id, '5');
  } finally { receipt.dispose(); client.dispose(); }
});
