import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { OutboxService } from '../src/outbox';
import { AccountSession } from '../src/accountSession';
import { ChatStore } from '../src/store';
import { AttachmentFiles } from '../src/attachments';
import { OneBotClient, OneBotRequestError } from '../src/onebot';
import { newChat, parseMessage } from '../src/model';
import { uploadToNapCat } from '../src/fileUpload';
import { png, videoBytes, sendEventTimeout } from './fixture';
import { createHash } from 'node:crypto';
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
  const outbox = new OutboxService(host);
  client.on('event', raw => {
    if (String(raw.self_id) !== store.selfId) return;
    const message = parseMessage(raw, undefined, store.selfId);
    if (!outbox.observeEcho(store, raw, message)) store.add(message, true);
  });
  try { await run({ store, files, client, session, host, outbox, calls, handle: action => { handler = action; } }); }
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

const selfEcho = (message_id: number, message: unknown[], key = 'group:1', time = Math.floor(Date.now() / 1000)) => ({
  post_type: 'message_sent', self_id: 123, message_type: key.startsWith('group:') ? 'group' : 'private',
  group_id: key.slice(6), target_id: key.slice(8), user_id: 123, sender: { user_id: 123, nickname: '我' }, message_id, time, message
});
const timeoutError = () => new OneBotRequestError('timeout', sendEventTimeout);

test('真实文字回显先于超时报错时只保留一条成功记录，无额外云端请求', async () => {
  await setup(async ({ store, client, outbox, handle, calls }) => {
    handle(async (_action, params) => { client.emit('event', selfEcho(201, params.message)); throw timeoutError(); });
    const submission = outbox.submit(store, 'group:1', '早到的回显');
    assert.equal(await submission.completion, true);
    assert.deepEqual(store.messages.get('group:1')!.map(m => [m.id, m.sendState]), [['201', 'sent']]);
    assert.equal(store.outbox.size, 0); assert.equal(store.draft('group:1').text, '');
    assert.deepEqual(calls, ['send_msg']);
    assert.equal(await outbox.retry(store, 'group:1', submission.messageIds[0], async () => true), false);
  });
});

test('超时后的图片和文字回显合并本地记录，原文、回复、图片与失败状态正确', async () => {
  await setup(async ({ store, files, client, outbox, handle, calls }) => {
    const image = await files.stage(png, '图片.png'); store.attach('group:1', [image]);
    const text = store.draft('group:1').text + '不要说这么悲伤的话';
    handle(async () => { throw timeoutError(); });
    const submission = outbox.submit(store, 'group:1', text, '100');
    assert.equal(await submission.completion, false);
    assert.equal(store.messages.get('group:1')![0].sendState, 'uncertain');
    const digest = createHash('md5').update(png).digest('hex');
    const segments = [{ type: 'reply', data: { id: '100' } }, { type: 'image', data: { file: `${digest.toUpperCase()}.png` } }, { type: 'text', data: { text: '不要说这么悲伤的话' } }];
    client.emit('event', selfEcho(202, segments));
    client.emit('event', selfEcho(202, segments));
    const messages = store.messages.get('group:1')!;
    assert.equal(messages.length, 1); assert.equal(messages[0].id, '202');
    assert.equal(messages[0].sendState, 'sent'); assert.equal(messages[0].sendError, undefined);
    assert.equal(messages[0].sendProgress, undefined); assert.equal(messages[0].outgoing, undefined);
    assert.equal(messages[0].replyId, '100'); assert.equal(messages[0].localImages?.[0].id, image.id);
    assert.equal(store.outbox.size, 0); assert.deepEqual(calls, ['send_msg']);
  });
});

test('只有正确的资源摘要才能确认纯图片消息；陌生占位符或其他图片不匹配', async () => {
  await setup(async ({ store, files, client, outbox, handle }) => {
    const image = await files.stage(png, '图片.png'); store.attach('group:1', [image]);
    handle(async () => { throw timeoutError(); });
    const submission = outbox.submit(store, 'group:1', store.draft('group:1').text); await submission.completion;
    for (const file of ['sent-1.png', '00000000000000000000000000000000.png']) client.emit('event', selfEcho(203, [{ type: 'image', data: { file } }]));
    assert.equal(store.messages.get('group:1')!.find(m => m.id === submission.messageIds[0])!.sendState, 'uncertain');
    client.emit('event', selfEcho(204, [{ type: 'image', data: { file: createHash('md5').update(png).digest('hex') + '.png' } }]));
    assert.equal(store.messages.get('group:1')!.some(m => m.id === submission.messageIds[0]), false);
  });
});

test('私聊回显按 target_id 匹配，连续相同的主动发送仍保留两条', async () => {
  await setup(async ({ store, client, outbox, handle }) => {
    store.upsert(newChat('private', 2, '好友')); let sequence = 205;
    handle(async (_action, params) => { client.emit('event', selfEcho(sequence++, params.message, 'private:2')); return { message_id: sequence - 1 }; });
    for (let i = 0; i < 2; i++) assert.equal(await outbox.submit(store, 'private:2', '相同正文').completion, true);
    assert.deepEqual(store.messages.get('private:2')!.map(m => m.id), ['205', '206']);
  });
});

test('不同会话、发送者、旧时间、正文顺序和回复目标不能确认发送', async () => {
  await setup(async ({ store, outbox, handle }) => {
    handle(async () => { throw timeoutError(); });
    const submission = outbox.submit(store, 'group:1', '唯一正文', '100'); await submission.completion;
    const parts = [{ type: 'reply', data: { id: '100' } }, { type: 'text', data: { text: '唯一正文' } }];
    const valid = selfEcho(207, parts);
    for (const raw of [{ ...valid, self_id: 456 }, { ...valid, sender: { user_id: 456 } }, { ...valid, group_id: 2 },
      { ...valid, time: valid.time - 1000 }, { ...valid, message_id: 0 }, { ...valid, message: [{ type: 'text', data: { text: '其他正文' } }] },
      { ...valid, message: [{ type: 'reply', data: { id: '101' } }, parts[1]] }]) {
      assert.equal(outbox.observeEcho(store, raw, parseMessage(raw, undefined, store.selfId)), false);
    }
    assert.ok(store.outbox.has(submission.messageIds[0]));
  });
});

test('相同的多条未确认发送不猜测关联，断开连接后旧尝试失效', async () => {
  await setup(async ({ store, outbox, session, handle }) => {
    handle(async () => { throw timeoutError(); });
    for (let i = 0; i < 2; i++) await outbox.submit(store, 'group:1', '相同正文').completion;
    const raw = selfEcho(208, [{ type: 'text', data: { text: '相同正文' } }]);
    assert.equal(outbox.observeEcho(store, raw, parseMessage(raw, undefined, store.selfId)), false);
    session.advance();
    assert.equal(outbox.observeEcho(store, raw, parseMessage(raw, undefined, store.selfId)), false);
    assert.equal(store.outbox.size, 2);
  });
});

test('重试确认框期间到达回显会取消重试，明确拒绝仍显示失败', async () => {
  await setup(async ({ store, client, outbox, handle, calls }) => {
    handle(async () => { throw timeoutError(); });
    const submission = outbox.submit(store, 'group:1', '稍后确认'); await submission.completion;
    assert.equal(await outbox.retry(store, 'group:1', submission.messageIds[0], async () => {
      client.emit('event', selfEcho(209, [{ type: 'text', data: { text: '稍后确认' } }])); return true;
    }), false);
    assert.deepEqual(calls, ['send_msg']);
    handle(async () => { throw new OneBotRequestError('rejected', '权限不足'); });
    const failed = outbox.submit(store, 'group:1', '真正失败'); await failed.completion;
    assert.equal(store.messages.get('group:1')!.find(m => m.id === failed.messageIds[0])!.sendState, 'failed');
  });
});


test('分片大图片、视频和表情混排使用上传中的摘要匹配，资源顺序不能颠倒', async () => {
  await setup(async ({ store, files, client, outbox, handle, calls }) => {
    const imageBytes = Buffer.concat([png, Buffer.alloc(600 * 1024)]);
    const image = await files.stage(imageBytes, '大图.png'), video = await files.stageAuto(videoBytes, '视频.mp4');
    store.attach('group:1', [image, { id: 'face14', kind: 'face', faceId: '14', label: '微笑' }, video]);
    // Use the actual stream lengths, as a remote NapCat stream would.
    const sizes = new Map<string, number>();
    handle(async (action, params) => {
      if (action === 'upload_file_stream') {
        if (params.is_complete) return { status: 'file_complete', file_path: '/remote/' + params.stream_id, file_size: sizes.get(params.stream_id) };
        sizes.set(params.stream_id, (sizes.get(params.stream_id) ?? 0) + Buffer.from(params.chunk_data, 'base64').length);
        return { status: 'chunk_received', received_chunks: params.chunk_index + 1 };
      }
      throw timeoutError();
    });
    const submission = outbox.submit(store, 'group:1', store.draft('group:1').text); await submission.completion;
    const imagePart = { type: 'image', data: { file: createHash('md5').update(imageBytes).digest('hex') + '.png' } };
    const videoPart = { type: 'video', data: { file: createHash('md5').update(videoBytes).digest('hex') + '.mp4' } };
    const facePart = { type: 'face', data: { id: '14' } };
    const wrong = selfEcho(210, [videoPart, facePart, imagePart]);
    assert.equal(outbox.observeEcho(store, wrong, parseMessage(wrong, undefined, store.selfId)), false);
    client.emit('event', selfEcho(211, [imagePart, facePart, videoPart]));
    assert.equal(store.messages.get('group:1')!.length, 1);
    assert.equal(store.messages.get('group:1')![0].sendState, 'sent');
    assert.equal(calls.filter(c => c === 'send_msg').length, 1); assert.equal(calls.includes('get_msg'), false);
  });
});

test('接口明确返回另一个消息 ID 时保留两条真实消息，不吞掉其他客户端的相同消息', async () => {
  await setup(async ({ store, client, outbox, handle }) => {
    handle(async (_action, params) => { client.emit('event', selfEcho(212, params.message)); return { message_id: 213 }; });
    assert.equal(await outbox.submit(store, 'group:1', '完全相同').completion, true);
    assert.deepEqual(store.messages.get('group:1')!.map(m => m.id), ['212', '213']);
    assert.equal(store.outbox.size, 0);
  });
});
