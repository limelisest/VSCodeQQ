import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { OutboxService } from '../src/outbox';
import { AccountSession } from '../src/accountSession';
import { ChatStore } from '../src/store';
import { AttachmentFiles } from '../src/attachments';
import { OneBotClient } from '../src/onebot';
import { newChat, parseMessage } from '../src/model';
import { uploadToNapCat } from '../src/fileUpload';
import { renderTranscript } from '../src/transcriptRenderer';

async function setup(run: (value: {
  store: ChatStore; files: AttachmentFiles; client: OneBotClient; session: AccountSession;
  host: { store: ChatStore; attachments?: AttachmentFiles; client: OneBotClient; session: AccountSession; ready: boolean; log(error: unknown): void };
  outbox: OutboxService; calls: string[];
  handle(action: (name: string, params: Record<string, any>) => Promise<any>): void;
}) => Promise<void>) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-delivery-check-'));
  const store = new ChatStore(folder, '123'), files = new AttachmentFiles(path.join(folder, 'outgoing'));
  const client = new OneBotClient(), session = new AccountSession(), calls: string[] = [];
  let handler: (name: string, params: Record<string, any>) => Promise<any> = async () => ({ message_id: 101 });
  client.call = async (name, params = {}) => { calls.push(name); return handler(name, params); };
  const host = { store, attachments: files as AttachmentFiles | undefined, client, session, ready: true, log: () => {} };
  store.upsert(newChat('group', 1, '测试'));
  try { await run({ store, files, client, session, host, outbox: new OutboxService(host), calls, handle: action => { handler = action; } }); }
  finally { client.dispose(); await store.dispose(); await fs.rm(folder, { recursive: true, force: true }); }
}

test('空、零和异常消息 ID 不会被当成发送成功，保留待确认记录', async () => {
  await setup(async ({ store, handle, outbox }) => {
    for (const response of [undefined, null, {}, { message_id: 0 }, { message_id: '-0' }, { message_id: 'oops' }]) {
      handle(async () => response);
      const submission = outbox.submit(store, 'group:1', '回执检查');
      assert.equal(await submission.completion, false);
      const message = store.messages.get('group:1')!.find(m => m.id === submission.messageIds[0])!;
      assert.equal(message.sendState, 'uncertain'); assert.ok(message.outgoing);
      assert.match(message.sendError!, /消息 ID/);
    }
  });
});

test('附件服务缺失时不提交含空消息段的请求，草稿附件留在待发送记录', async () => {
  await setup(async ({ store, host, outbox, calls }) => {
    host.attachments = undefined;
    store.attach('group:1', [{ id: 'face', kind: 'face', faceId: '14', label: '微笑' }]);
    const submission = outbox.submit(store, 'group:1', store.draft('group:1').text);
    assert.equal(await submission.completion, false); assert.equal(calls.length, 0);
    assert.equal(store.messages.get('group:1')!.at(-1)!.sendState, 'failed');
    assert.ok(store.messages.get('group:1')!.at(-1)!.outgoing?.attachments.length);
  });
});

test('成功后的旧取消请求不能把文件改成已取消', async () => {
  await setup(async ({ store, outbox, calls }) => {
    const submission = outbox.submit(store, 'group:1', '保留成功状态');
    const stale = { ...store.messages.get('group:1')!.find(m => m.id === submission.messageIds[0])! };
    assert.equal(await submission.completion, true);
    await outbox.cancel(store, stale);
    assert.equal(store.messages.get('group:1')!.find(m => m.id === '101')!.sendState, 'sent');
    assert.equal(calls.filter(c => c === 'send_msg').length, 1);
  });
});

test('文件 UUID 重用时保留历史消息和本次成功记录，没有回显时仍生成文件链接', async () => {
  await setup(async ({ store, files, outbox, handle }) => {
    const file = await files.stageFile(Buffer.from('same file'), '重复文件.txt');
    store.add(parseMessage({ message_id: 100, user_id: 123, time: 10, message: [{ type: 'file', data: { file_id: 'reused', name: '重复文件.txt', file_size: file.size } }] }, 'group:1', '123'), false);
    handle(async (name, p) => name === 'upload_file_stream'
      ? p.is_complete ? { status: 'file_complete', file_path: '/remote/file', file_size: file.size }
        : { status: 'chunk_received', received_chunks: p.chunk_index + 1 }
      : { file_id: 'reused' });
    store.attach('group:1', [file]);
    const submission = outbox.submit(store, 'group:1', store.draft('group:1').text);
    assert.equal(await submission.completion, true);
    const messages = store.messages.get('group:1')!;
    assert.equal(messages.length, 2); assert.ok(messages.some(m => m.id === '100' && m.time === 10));
    const sent = messages.find(m => m.id === submission.messageIds[0])!;
    assert.equal(sent.sendState, 'sent'); assert.equal(sent.segments[0].type, 'file');
    const view = renderTranscript(store.chats.get('group:1')!, messages, '123');
    assert.equal(view.files.length, 4, '两条消息各保留正文引用和文件详情链接');
    assert.equal(new Set(view.files.map(span => span.messageId)).size, 2);
    const stale = { ...sent, sendState: 'sending' as const, sendProgress: { stage: 'upload' as const, sent: 0, total: 9 } };
    await outbox.cancel(store, stale);
    assert.equal(store.messages.get('group:1')!.find(m => m.id === sent.id)!.sendState, 'sent');
    const lateEcho = parseMessage({ message_id: 101, user_id: 123, message: [{ type: 'file', data: { file_id: 'reused', file: '重复文件.txt', file_size: file.size } }] }, 'group:1', '123');
    store.settleOutgoing('group:1', sent.id, { ...sent, ...lateEcho });
    assert.deepEqual(store.messages.get('group:1')!.map(m => m.id), ['100', '101']);
    assert.equal(store.messages.get('group:1')![0].time, 10, '迟到的回显也不能覆盖旧文件消息');
  });
});

test('读缓存期间切换连接时，不再把文件分片发到新连接', async () => {
  await setup(async ({ store, files, session, outbox, calls }) => {
    const file = await files.stageFile(Buffer.from('old connection'), '旧连接.txt'); store.attach('group:1', [file]);
    const flush = store.flush.bind(store);
    store.flush = async () => { await flush(); session.advance(); };
    try {
      const submission = outbox.submit(store, 'group:1', store.draft('group:1').text);
      assert.equal(await submission.completion, false); assert.equal(calls.length, 0);
    } finally { store.flush = flush; }
  });
});

test('文件合并回执后再次检查连接，旧任务不会报告已进入 QQ 上传阶段', async () => {
  await setup(async ({ files, client, handle }) => {
    const file = await files.stageFile(Buffer.from('stream complete'), '结束.txt');
    let stopped = false, confirmed = false;
    handle(async (_name, p) => {
      if (p.is_complete) { stopped = true; return { status: 'file_complete', file_path: '/remote/file', file_size: file.size }; }
      return { status: 'chunk_received', received_chunks: p.chunk_index + 1 };
    });
    await assert.rejects(uploadToNapCat(client, file.file!, progress => { if (progress.stage === 'confirm') confirmed = true; }, () => { if (stopped) throw new Error('session changed'); }), /session changed/);
    assert.equal(confirmed, false);
  });
});
