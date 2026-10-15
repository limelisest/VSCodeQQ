import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { OperationLocks } from '../src/operationLocks';
import { AccountSession } from '../src/accountSession';
import { OutboxService } from '../src/outbox';
import { AttachmentFiles } from '../src/attachments';
import { ChatStore } from '../src/store';
import { OneBotClient } from '../src/onebot';
import { newChat } from '../src/model';
import { MockNapCat, until } from './fixture';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

test('操作锁复用进行中的结果，独立资源并发，成功与异常均释放', async () => {
  const locks = new OperationLocks(), waiting = deferred<number>();
  let calls = 0;
  const first = locks.run('a', () => { calls++; return waiting.promise; });
  for (let i = 0; i < 20; i++) assert.equal(locks.run('a', () => { calls++; return 99; }), first);
  assert.equal(await locks.run('b', () => 2), 2);
  assert.equal(calls, 1); waiting.resolve(1); assert.equal(await first, 1);
  assert.equal(await locks.run('a', () => 3), 3);
  await assert.rejects(locks.run('a', () => { throw new Error('sync'); }), /sync/);
  await assert.rejects(locks.run('a', async () => { throw new Error('async'); }), /async/);
  assert.equal(await locks.run('a', () => 4), 4);
});

test('新连接不复用旧操作，旧任务结束不能解除新连接的锁', async () => {
  const session = new AccountSession(), oldWait = deferred<void>(), newWait = deferred<void>();
  const old = session.run('query', () => oldWait.promise);
  session.advance(); const current = session.run('query', () => newWait.promise);
  assert.notEqual(current, old); oldWait.resolve(); await old;
  assert.equal(session.run('query', () => { throw new Error('duplicate'); }), current);
  newWait.resolve(); await current;
});

test('同一消息重复入队或重发仅发送一次，重发确认只出现一次且可以取消', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-locks-'));
  const store = new ChatStore(folder, '123456'), backend = new MockNapCat(), client = new OneBotClient(), session = new AccountSession();
  const host = { store, client, session, ready: true, log: () => {} };
  const outbox = new OutboxService(host), key = 'group:20002';
  await backend.start(); await client.connect(backend.url); store.upsert(newChat('group', 20002, '群'));
  try {
    backend.failSend = true;
    const failed = outbox.submit(store, key, '重发测试'); await failed.completion;
    const id = failed.messageIds[0], message = store.messages.get(key)!.find(m => m.id === id)!;
    backend.failSend = false; backend.sendDelay = 100;
    const before = backend.calls.filter(c => c.action === 'send_msg').length;
    const first = outbox.enqueue(store, message);
    const repeated = Array.from({ length: 20 }, () => outbox.enqueue(store, message));
    assert.ok(repeated.every(task => task === first));
    assert.equal(await first, true); await Promise.all(repeated);
    assert.equal(backend.calls.filter(c => c.action === 'send_msg').length - before, 1);
    assert.equal(await outbox.enqueue(store, message), false, '旧引用不得重发已经成功的消息');

    backend.failSend = true; const uncertain = outbox.submit(store, key, '结果未确认'); await uncertain.completion;
    const pendingId = uncertain.messageIds[0], pending = store.messages.get(key)!.find(m => m.id === pendingId)!;
    pending.sendState = 'uncertain'; store.enrichMessage(pending);
    const confirmation = deferred<boolean>(); let prompts = 0;
    const confirm = () => { prompts++; return confirmation.promise; };
    const retry = outbox.retry(store, key, pendingId, confirm);
    assert.equal(outbox.retry(store, key, pendingId, confirm), retry);
    assert.equal(prompts, 1); confirmation.resolve(false); assert.equal(await retry, false);
    assert.equal(store.messages.get(key)!.find(m => m.id === pendingId)!.sendState, 'uncertain');
    backend.failSend = false;
    const retryBefore = backend.calls.filter(c => c.action === 'send_msg').length;
    await Promise.all(Array.from({ length: 20 }, () => outbox.retry(store, key, pendingId, async () => { prompts++; return true; })));
    assert.equal(prompts, 2);
    assert.equal(backend.calls.filter(c => c.action === 'send_msg').length - retryBefore, 1);
  } finally { client.dispose(); await backend.close(); await store.dispose(); await fs.rm(folder, { recursive: true, force: true }); }
});

test('重发确认期间可发新消息，切换连接或撤回后不再提交旧重发', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-retry-session-'));
  const store = new ChatStore(folder, '123456'), backend = new MockNapCat(), client = new OneBotClient(), session = new AccountSession();
  const outbox = new OutboxService({ store, client, session, ready: true, log: () => {} }), key = 'group:20002';
  await backend.start(); await client.connect(backend.url); store.upsert(newChat('group', 20002, '群'));
  try {
    backend.failSend = true; const sent = outbox.submit(store, key, '旧消息'); await sent.completion;
    const message = store.messages.get(key)!.find(m => m.id === sent.messageIds[0])!;
    message.sendState = 'uncertain'; store.enrichMessage(message);
    const confirm = deferred<boolean>();
    const retry = outbox.retry(store, key, message.id, () => confirm.promise);
    backend.failSend = false;
    assert.equal(await outbox.submit(store, key, '确认期间的新消息').completion, true);
    session.advance(); confirm.resolve(true); assert.equal(await retry, false);
    const before = backend.sent.length;
    const recalledConfirm = deferred<boolean>();
    const recalled = outbox.retry(store, key, message.id, () => recalledConfirm.promise);
    store.recall(key, message.id); recalledConfirm.resolve(true); assert.equal(await recalled, false);
    assert.equal(backend.sent.length, before);
  } finally { client.dispose(); await backend.close(); await store.dispose(); await fs.rm(folder, { recursive: true, force: true }); }
});

test('重复文件重发仅执行一次上传，失败释放锁后仍可再次重发', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-file-lock-'));
  const store = new ChatStore(folder, '123456'), backend = new MockNapCat(), client = new OneBotClient(), session = new AccountSession();
  const files = new AttachmentFiles(path.join(folder, 'outgoing')), key = 'private:10001';
  const outbox = new OutboxService({ store, client, session, attachments: files, ready: true, log: () => {} });
  await backend.start(); await client.connect(backend.url); store.upsert(newChat('private', 10001, '好友'));
  try {
    const attachment = await files.stageFile(Buffer.from('file retry content'), 'lock.txt');
    store.attach(key, [attachment]); backend.failFileName = 'lock.txt';
    const submission = outbox.submit(store, key, store.draft(key).text); assert.equal(await submission.completion, false);
    const id = submission.messageIds[0], before = backend.fileUploads.length;
    backend.fileDelay = 80;
    const tasks = Array.from({ length: 10 }, () => outbox.retry(store, key, id, async () => true));
    assert.equal(await tasks[0], false); await Promise.all(tasks);
    assert.equal(backend.fileUploads.length - before, 1);
    backend.failFileName = '';
    assert.equal(await outbox.retry(store, key, id, async () => true), true);
    await until(() => store.outbox.size === 0);
  } finally { client.dispose(); await backend.close(); await store.dispose(); await fs.rm(folder, { recursive: true, force: true }); }
});
