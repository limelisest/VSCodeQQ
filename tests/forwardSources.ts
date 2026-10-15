import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OneBotClient, OneBotRequestError } from '../src/onebot';
import { parseMessage } from '../src/model';
import { ensureForwardSources } from '../src/forwardSources';

for (const type of ['group', 'private'] as const) test(`合并转发恢复 ${type} 来源消息的 NapCat ID 映射，并向前分页`, async () => {
  const selected = ['11', '12'].map(message_id => parseMessage({ message_id, message: '原始内容' }, `${type}:42`));
  const registered = new Set(['12']);
  const calls: { action: string; params: Record<string, unknown> }[] = [];
  let pages = 0;
  const client = { call: (async (action: string, params: Record<string, unknown>) => {
    calls.push({ action, params });
    if (action === 'get_msg') {
      if (!registered.has(String(params.message_id))) throw new OneBotRequestError('rejected', '消息不存在');
      return { message_id: params.message_id, message: [] };
    }
    assert.equal(action, type === 'group' ? 'get_group_msg_history' : 'get_friend_msg_history');
    assert.equal(params[type === 'group' ? 'group_id' : 'user_id'], '42');
    assert.equal(params.count, 500); assert.equal(params.disable_get_url, true);
    assert.equal(params.parse_mult_msg, false);
    if (++pages === 1) return { messages: [{ message_id: '20', time: 20 }] };
    assert.equal(params.message_seq, '20');
    registered.add('11'); return { messages: [{ message_id: '11', time: 10 }] };
  }) as OneBotClient['call'] };
  await ensureForwardSources(client, selected, () => {});
  assert.equal(pages, 2);
  assert.deepEqual(calls.slice(-2).map(c => c.params.message_id), ['11', '12']);
  assert.ok(calls.every(c => !c.action.startsWith('send_')));
});

test('当前来源全部可读取时不刷新历史，重建后只恢复部分时拒绝整个选择', async () => {
  const selected = ['11', '12'].map(message_id => parseMessage({ message_id, message: '原文' }, 'group:42'));
  const actions: string[] = [];
  let available = true;
  const client = { call: (async (action: string, params: Record<string, unknown>) => {
    actions.push(action);
    if (action === 'get_msg') {
      if (!available && params.message_id === '11') throw new OneBotRequestError('rejected', '消息不存在');
      return { message_id: params.message_id, message: [] };
    }
    return { messages: [] };
  }) as OneBotClient['call'] };
  await ensureForwardSources(client, selected, () => {});
  assert.deepEqual(actions, ['get_msg', 'get_msg']);
  available = false;
  await assert.rejects(ensureForwardSources(client, selected, () => {}), /1 条来源消息.*停止合并转发/);
  assert.ok(actions.every(action => !action.startsWith('send_')));
});

test('来源恢复有分页上限，读取超时和换连接立即停止', async () => {
  const selected = [parseMessage({ message_id: 11, message: '原文' }, 'group:42')];
  let pages = 0, mode = 'missing', current = true;
  const client = { call: (async (action: string) => {
    if (mode === 'timeout') throw new OneBotRequestError('timeout', '来源读取超时');
    if (mode === 'switch') { current = false; return {}; }
    if (action === 'get_msg') throw new OneBotRequestError('rejected', '消息不存在');
    return { messages: [{ message_id: String(100 + ++pages), time: 100 - pages }] };
  }) as OneBotClient['call'] };
  const check = () => { if (!current) throw new Error('连接已变化'); };
  await assert.rejects(ensureForwardSources(client, selected, check), /停止合并转发/);
  assert.equal(pages, 4);
  mode = 'timeout';
  await assert.rejects(ensureForwardSources(client, selected, check), /来源读取超时/);
  assert.equal(pages, 4);
  mode = 'switch';
  await assert.rejects(ensureForwardSources(client, selected, check), /连接已变化/);
});
