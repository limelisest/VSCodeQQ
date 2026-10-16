import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { imageSizeFromFile } from 'image-size/fromFile';
import { MediaCache } from '../src/media';
import { AttachmentFiles } from '../src/attachments';
import { OneBotClient } from '../src/onebot';
import { ChatStore } from '../src/store';
import { newChat } from '../src/model';
import { OutboxService } from '../src/outbox';
import { AccountSession } from '../src/accountSession';
import { MockNapCat, png, tallPng } from './fixture';

test('超过 16 MB 的图片惰性流式下载，兼容已知长度和分块响应，缓存可复用', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-large-image-'));
  const bytes = Buffer.alloc(17 * 1024 * 1024 + 23); png.copy(bytes);
  let requests = 0;
  const server = createServer((req, res) => {
    requests++; res.setHeader('Content-Type', 'image/png');
    if (req.url === '/budget') {
      Readable.from((function* () {
        yield png; const chunk = Buffer.alloc(1024 * 1024); let remaining = 129 * 1024 * 1024 - png.length;
        while (remaining > 0) { const size = Math.min(chunk.length, remaining); yield chunk.subarray(0, size); remaining -= size; }
      })()).pipe(res); return;
    }
    if (req.url === '/length') { res.setHeader('Content-Length', bytes.length); res.end(bytes); }
    else { res.write(bytes.subarray(0, 1024)); res.end(bytes.subarray(1024)); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = new OneBotClient(), cache = new MediaCache(folder, client);
  try {
    assert.equal(requests, 0);
    for (const route of ['length', 'chunked']) {
      const ref = { file: '', url: `http://127.0.0.1:${(server.address() as any).port}/${route}` };
      const [a, b] = await Promise.all([cache.get(ref), cache.get(ref)]);
      assert.equal(a, b); assert.equal((await fs.stat(a)).size, bytes.length);
      assert.deepEqual(await fs.readFile(a), bytes);
      assert.equal((await imageSizeFromFile(a)).width, 1);
      assert.equal(await cache.get(ref), a);
    }
    assert.equal(requests, 2);
    assert.equal((await fs.readdir(folder)).length, 2, '完成后不残留下载临时文件');
    const budget = { file: '', url: `http://127.0.0.1:${(server.address() as any).port}/budget` };
    const huge = await cache.get(budget);
    assert.equal((await fs.stat(huge)).size, 129 * 1024 * 1024, '缓存清理目标不能删除正在打开的大图片');
    assert.equal(await cache.get(budget), huge);
  } finally {
    client.dispose(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve())); await fs.rm(folder, { recursive: true, force: true });
  }
});

test('大图片导入、读取、十三个附件混排发送，分片上传且保留图片类型和表情标记', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-image-send-'));
  const backend = new MockNapCat(), client = new OneBotClient(), store = new ChatStore(folder, '123456');
  await backend.start(); await client.connect(backend.url);
  const files = new AttachmentFiles(path.join(folder, 'outgoing'));
  const bytes = Buffer.alloc(19 * 1024 * 1024); png.copy(bytes);
  try {
    store.upsert(newChat('group', 20002, '测试群'));
    const source = path.join(folder, 'large.tmp'); await fs.writeFile(source, bytes);
    const big = { ...await files.stageAutoPath(source, '大图.png'), sticker: true };
    assert.equal(big.kind, 'image'); assert.deepEqual(await files.read(big), bytes);
    const small = await Promise.all(Array.from({ length: 12 }, (_, i) => files.stage(png, '小图' + i)));
    store.attach('group:20002', [big, ...small]);
    const outbox = new OutboxService({ store, client, attachments: files, session: new AccountSession(), ready: true, log: () => {} });
    const submission = outbox.submit(store, 'group:20002', store.draft('group:20002').text);
    assert.equal(store.draft('group:20002').text, '', '上传立即离开草稿');
    assert.equal(await submission.completion, true);
    const segments = backend.sent.at(-1).message;
    assert.equal(segments.length, 13); assert.ok(segments.every((s: any) => s.type === 'image'));
    assert.equal(segments[0].data.sub_type, 1);
    assert.deepEqual(backend.uploadedBytes.get(segments[0].data.file), bytes);
    assert.ok(backend.calls.filter(c => c.action === 'upload_file_stream' && c.params.chunk_data).every(c => Buffer.from(c.params.chunk_data, 'base64').length <= 512 * 1024));
    assert.equal(backend.fileUploads.length, 0, '图片不可被当成文件发送');
  } finally { client.dispose(); await backend.close(); await store.dispose(); await fs.rm(folder, { recursive: true, force: true }); }
});


test('同名图片使用各自资源地址，不能串用下载中或已缓存的图片', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-image-identity-'));
  const backend = new MockNapCat(), client = new OneBotClient(); await backend.start();
  try {
    const cache = new MediaCache(folder, client);
    const [a, b] = await Promise.all([
      cache.get({ file: 'image.png', url: backend.imageUrl }),
      cache.get({ file: 'image.png', url: backend.imageUrl + '?tall' })
    ]);
    assert.notEqual(a, b);
    assert.deepEqual(await fs.readFile(a), png); assert.deepEqual(await fs.readFile(b), tallPng);
    assert.equal(await cache.get({ file: 'image.png', url: backend.imageUrl + '?tall' }), b);
  } finally { client.dispose(); await backend.close(); await fs.rm(folder, { recursive: true, force: true }); }
});
