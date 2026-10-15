import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ChatStore } from '../src/store';
import { AccountSession } from '../src/accountSession';
import { OneBotClient, OneBotRequestError } from '../src/onebot';
import { newChat, parseMessage } from '../src/model';
import { renderTranscript } from '../src/transcriptRenderer';
import { deliverForward } from '../src/forwardDelivery';

for (const recoverAll of [false, true]) test(`来源缓存过期时先恢复全部引用再发送，recoverAll=${recoverAll}`, async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-forward-expired-'));
  const store = new ChatStore(folder, '123'), session = new AccountSession();
  const source = newChat('group', '42', '来源'), target = newChat('private', '456', '目标');
  store.upsert(source); store.upsert(target);
  const messages = [11, 12].map(message_id => parseMessage({ message_id, message: '原文' }, source.key));
  for (const message of messages) store.add(message, false);
  const registered = new Set<string>();
  let sends = 0;
  const host = { store, session, ready: true, client: { call: (async (action: string, params: Record<string, any>) => {
    if (action === 'get_msg') {
      if (params.message_id === '999') throw new Error('详情暂不可用');
      if (!registered.has(params.message_id)) throw new OneBotRequestError('rejected', '消息不存在');
      return { message_id: params.message_id, message: '原文' };
    }
    if (action === 'get_group_msg_history') {
      assert.equal(params.group_id, '42');
      registered.add('11'); if (recoverAll) registered.add('12');
      return { messages: [...registered].map(message_id => ({ message_id, time: 1 })) };
    }
    assert.equal(action, 'send_private_forward_msg');
    assert.deepEqual(params.messages.map((node: any) => node.data.id), ['11', '12']);
    assert.ok(params.messages.every((node: any) => registered.has(node.data.id)));
    sends++; return { message_id: 999, forward_id: 'resource' };
  }) as OneBotClient['call'] } };
  try {
    const sending = deliverForward(host, target, messages, true, () => {});
    if (recoverAll) await sending;
    else await assert.rejects(sending, /停止合并转发/);
    assert.equal(sends, recoverAll ? 1 : 0);
    assert.equal(store.messages.get(target.key)!.at(-1)!.sendState, recoverAll ? 'sent' : 'failed');
  } finally { await store.dispose(); await fs.rm(folder, { recursive: true, force: true }); }
});

for (const newerAt of ['receipt', 'detail', 'none'] as const) test(`迟到的转发更新只刷新最新消息摘要：${newerAt}`, async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-forward-preview-'));
  const store = new ChatStore(folder, '123'), session = new AccountSession();
  const target = newChat('private', '456', '目标'); store.upsert(target);
  let receiptReady!: () => void, detailReady!: () => void;
  let resolveReceipt!: (value: unknown) => void, resolveDetail!: (value: unknown) => void;
  const receiptStarted = new Promise<void>(resolve => { receiptReady = resolve; });
  const detailStarted = new Promise<void>(resolve => { detailReady = resolve; });
  const receipt = new Promise(resolve => { resolveReceipt = resolve; });
  const detail = new Promise(resolve => { resolveDetail = resolve; });
  const host = { store, session, ready: true, client: { call: (async (action: string, params: Record<string, unknown>) => {
    if (action === 'get_msg') { detailReady(); return detail; }
    receiptReady(); return receipt;
  }) as OneBotClient['call'] } };
  try {
    const task = deliverForward(host, target, [parseMessage({ message_id: 11, message: '转发预览' }, target.key)], false, () => {});
    await receiptStarted;
    const time = store.messages.get(target.key)![0].time;
    const addNewer = () => store.add(parseMessage({ message_id: 1000, user_id: 456, time, message: '后收到的新消息' }, target.key), false);
    if (newerAt === 'receipt') addNewer();
    resolveReceipt({ message_id: 999 });
    await detailStarted;
    if (newerAt === 'detail') addNewer();
    assert.equal(store.chats.get(target.key)!.preview, newerAt === 'none' ? '转发预览' : '后收到的新消息');
    resolveDetail({ message_id: 999, user_id: 123, time, message: [{ type: 'forward', data: { id: 'actual-resource' } }] });
    await task;
    assert.equal(store.messages.get(target.key)!.at(-1)!.id, newerAt === 'none' ? '999' : '1000');
    assert.equal(store.chats.get(target.key)!.preview, newerAt === 'none' ? '[合并转发]' : '后收到的新消息');
    assert.equal(store.chats.get(target.key)!.lastTime, time);
    assert.equal(store.messages.get(target.key)!.find(m => m.id === '999')!.segments[0].type, 'forward');
    // Correcting the latest message's timestamp must not move the conversation backwards.
    const latest = store.messages.get(target.key)!.at(-1)!;
    store.enrichMessage({ ...latest, time: time - 1 }, true);
    assert.equal(store.chats.get(target.key)!.lastTime, time);
  } finally { await store.dispose(); await fs.rm(folder, { recursive: true, force: true }); }
});

for (const merged of [false, true]) for (const echo of ['none', 'before', 'after']) test(`转发结算：merged=${merged}, echo=${echo}，目标可见且不重复`, async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-forward-'));
  const store = new ChatStore(folder, '123'), session = new AccountSession();
  const target = newChat('private', '456', '目标'), source = newChat('group', '1', '来源');
  store.upsert(target); store.upsert(source);
  store.setDraft(source.key, '原草稿', '11'); store.setDraft(target.key, '目标草稿');
  const drafts = JSON.stringify([...store.drafts]);
  const message = parseMessage({ message_id: 11, user_id: 8, message: '转发原文' }, source.key);
  const raw = { message_id: 999, user_id: 123, time: Math.floor(Date.now() / 1000), message: merged ? [{ type: 'forward', data: { id: 'resource' } }] : '转发原文' };
  let calls = 0;
  const host = { store, session, ready: true, client: { call: (async (action: string, params: Record<string, unknown>) => {
    if (action === 'get_msg' && params.message_id === '11') return { message_id: 11, message: '转发原文' };
    if (action === 'get_msg') throw new Error('详情暂不可用');
    calls++;
    const local = store.messages.get(target.key)!.find(m => m.id.startsWith('local:'))!;
    assert.equal(local.sendState, 'sending');
    assert.equal(store.outbox.has(local.id), true);
    if (echo === 'before') store.add(parseMessage(raw, target.key), false);
    return { message_id: 999, forward_id: merged ? 'resource' : undefined };
  }) as OneBotClient['call'] } };
  try {
    const logs: unknown[] = [];
    await deliverForward(host, target, [message], merged, e => logs.push(e));
    if (echo === 'after') store.add(parseMessage(raw, target.key), false);
    const records = store.messages.get(target.key)!;
    assert.equal(records.length, 1); assert.equal(records[0].id, '999'); assert.equal(records[0].sendState, 'sent');
    assert.equal(store.outbox.size, 0);
    assert.ok(store.chats.get(target.key)!.lastTime > 0);
    assert.equal(store.chats.get(target.key)!.preview, merged ? '[合并转发]' : '转发原文');
    assert.equal(JSON.stringify([...store.drafts]), drafts);
    assert.equal(calls, 1); assert.ok(logs.some(l => String(l).includes('详情补取失败')));
    const restored = new ChatStore(folder, '123'); await restored.restore(); await restored.load(target.key);
    assert.equal(restored.messages.get(target.key)![0].id, '999'); await restored.dispose();
  } finally { await store.dispose(); await fs.rm(folder, { recursive: true, force: true }); }
});

for (const kind of ['rejected', 'timeout', 'disconnected', 'switch', 'detail-switch', 'detail', 'missing-id'] as const) test(`转发状态和连接隔离：${kind}`, async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-forward-state-'));
  const store = new ChatStore(path.join(folder, 'old'), '123'), other = new ChatStore(path.join(folder, 'new'), '987');
  const target = newChat('group', '1', '目标'); store.upsert(target); other.upsert(target);
  const session = new AccountSession(); let sends = 0;
  const host = { store, session, ready: true, client: { call: (async (action: string, params: Record<string, unknown>) => {
    if (action === 'get_msg' && params.message_id === '11') return { message_id: 11, message: '原文' };
    if (action === 'get_msg') {
      if (kind === 'detail-switch') { session.advance(); host.store = other; }
      return { message_id: 999, user_id: 123, time: Math.floor(Date.now() / 1000), message: [{ type: 'forward', data: { id: 'actual-resource' } }] };
    }
    sends++;
    if (kind === 'switch') { session.advance(); host.store = other; return { message_id: 999 }; }
    if (kind === 'missing-id') return {};
    if (kind === 'detail' || kind === 'detail-switch') return { message_id: 999 };
    throw new OneBotRequestError(kind, '请求出错');
  }) as OneBotClient['call'] } };
  try {
    const task = deliverForward(host, target, [parseMessage({ message_id: 11, message: '原文' }, target.key)], true, () => {});
    if (kind === 'detail' || kind === 'detail-switch') await task;
    else await assert.rejects(task);
    assert.equal(sends, 1); assert.equal(other.messages.size, 0);
    const message = store.messages.get(target.key)![0];
    assert.equal(message.sendState, kind.startsWith('detail') ? 'sent' : kind === 'rejected' ? 'failed' : 'uncertain');
    if (kind === 'detail') assert.deepEqual(message.segments, [{ type: 'forward', id: 'actual-resource', text: '[合并转发]' }]);
    const rendered = renderTranscript(target, [message], store.selfId);
    assert.ok(!rendered.actions.some(a => a.kind === 'retry'));
    assert.ok(!rendered.text.includes('[重试]'));
  } finally { await store.dispose(); await other.dispose(); await fs.rm(folder, { recursive: true, force: true }); }
});
