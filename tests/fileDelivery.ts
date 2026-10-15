import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { AccountSession } from '../src/accountSession';
import { OutboxService } from '../src/outbox';
import { AttachmentFiles } from '../src/attachments';
import { ChatStore } from '../src/store';
import { OneBotClient } from '../src/onebot';
import { newChat, parseMessage } from '../src/model';
import { MockNapCat } from './fixture';

for (const type of ['group', 'private'] as const) test(`文件实际已发送但 ${type} 上传接口报错时使用新回显确认成功，旧重试不再发送`, async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-file-ack-'));
  const store = new ChatStore(folder, '123456'), backend = new MockNapCat(), client = new OneBotClient();
  const files = new AttachmentFiles(path.join(folder, 'outgoing')), chat = newChat(type, 10001, '测试');
  const logs: unknown[] = [], outbox = new OutboxService({ store, attachments: files, client, session: new AccountSession(), ready: true, log: value => logs.push(value) });
  await backend.start(); await client.connect(backend.url); store.upsert(chat);
  client.on('event', raw => store.add(parseMessage(raw, undefined, store.selfId), false));
  try {
    const file = await files.stageFile(Buffer.from('already delivered'), '已发出.txt');
    store.attach(chat.key, [file]); backend.fileEchoThenReject = true;
    const submission = outbox.submit(store, chat.key, store.draft(chat.key).text);
    assert.equal(await submission.completion, true);
    assert.equal(store.messages.get(chat.key)!.length, 1);
    const actual = store.messages.get(chat.key)!.find(m => !m.id.startsWith('local:'))!;
    const segment = actual.segments.find(s => s.type === 'file')!;
    assert.equal(segment.type === 'file' && segment.file.name, '已发出.txt');
    assert.equal(actual.sendState, 'sent'); assert.equal(actual.outgoing, undefined);
    assert.ok(logs.some(line => String(line).includes('回显，已确认成功')));
    let prompts = 0;
    assert.equal(await outbox.retry(store, chat.key, submission.messageIds[0], async () => { prompts++; return false; }), false);
    assert.equal(prompts, 0); assert.equal(backend.fileUploads.length, 1);
  } finally { client.dispose(); await backend.close(); await store.dispose(); await fs.rm(folder, { recursive: true, force: true }); }
});

test('已收到上传成功回执后，缓存写入异常不能恢复重试入口', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-file-persist-'));
  const store = new ChatStore(folder, '123456'), backend = new MockNapCat(), client = new OneBotClient();
  const files = new AttachmentFiles(path.join(folder, 'outgoing')), key = 'private:10001';
  const logs: unknown[] = [], outbox = new OutboxService({ store, attachments: files, client, session: new AccountSession(), ready: true, log: value => logs.push(value) });
  await backend.start(); await client.connect(backend.url); store.upsert(newChat('private', 10001, '测试'));
  const flush = store.flush.bind(store);
  try {
    const file = await files.stageFile(Buffer.from('success receipt'), '已确认.txt'); store.attach(key, [file]);
    store.flush = async () => { if (store.messages.get(key)?.some(m => m.sendState === 'sent')) throw new Error('disk failure after receipt'); await flush(); };
    const submission = outbox.submit(store, key, store.draft(key).text);
    assert.equal(await submission.completion, true);
    const message = store.messages.get(key)!.find(m => m.id === submission.messageIds[0])!;
    assert.equal(message.sendState, 'sent'); assert.equal(message.outgoing, undefined);
    assert.equal(await outbox.retry(store, key, message.id, async () => true), false);
    assert.equal(backend.fileUploads.length, 1); assert.ok(logs.length);
  } finally { store.flush = flush; client.dispose(); await backend.close(); await store.dispose(); await fs.rm(folder, { recursive: true, force: true }); }
});
