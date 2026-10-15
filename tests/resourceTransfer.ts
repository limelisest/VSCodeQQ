import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { AttachmentFiles } from '../src/attachments';
import { ResourceClipboard } from '../src/resourceClipboard';
import { parseMessage, normalizeSegments, newChat, draftParts } from '../src/model';
import { renderTranscript } from '../src/transcriptRenderer';
import { codeLanguages } from '../src/codeStyle';
import { MediaCache, videoExtension } from '../src/media';
import { OneBotClient } from '../src/onebot';
import { ChatStore } from '../src/store';
import { AccountSession } from '../src/accountSession';
import { OutboxService } from '../src/outbox';
import { MockNapCat, png, videoBytes } from './fixture';

test('复制元数据按账号和原文绑定，保留资源引用但不接受任意句柄或修改后的文本', () => {
  const clipboard = new ResourceClipboard();
  const value = { account: '123', key: 'group:1', text: '[图片:1]\n[@:甲]', spans: [{ start: 0, end: 6, identity: 'a', resource: { kind: 'attachment' as const, attachment: { id: 'a', kind: 'image' as const, label: '图片', file: '/cache/a.png' } } }] };
  const handle = clipboard.put(value); value.spans[0].resource.attachment.file = '/changed';
  assert.ok(clipboard.get(handle, '123', '[图片:1]\r\n[@:甲]'));
  assert.equal(clipboard.get(handle, '456', value.text), undefined);
  assert.equal(clipboard.get(handle, '123', value.text + '!'), undefined);
  assert.equal(clipboard.get('unknown', '123', value.text), undefined);
  assert.deepEqual(clipboard.references('123'), ['/cache/a.png']);
  assert.deepEqual(clipboard.references('456'), []);
  for (let i = 0; i < 20; i++) clipboard.put(value);
  assert.equal(clipboard.get(handle, '123', value.text), undefined);
});

test('外部文件按内容自动识别图片、视频和普通文件，路径后缀不决定发送类型', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-auto-media-'));
  const files = new AttachmentFiles(path.join(folder, 'outgoing'));
  try {
    const source = path.join(folder, '来自应用.tmp'); await fs.writeFile(source, png);
    assert.equal((await files.stageAutoPath(source, '无扩展名')).kind, 'image');
    const video = await files.stageAuto(videoBytes, '电影.tmp'); assert.equal(video.kind, 'video'); assert.ok(video.file!.endsWith('.mp4'));
    assert.equal((await files.stageAuto(Buffer.from('text'), '伪装.png')).kind, 'file');
    assert.equal(videoExtension(videoBytes), '.mp4'); assert.equal(videoExtension(png), undefined);
    assert.equal(videoExtension(Buffer.from('0000001866747970617669660000000061766966', 'hex')), undefined, 'AVIF 不是视频');
    const ebml = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
    assert.equal(videoExtension(Buffer.concat([ebml, Buffer.from('webm')])), '.webm');
    assert.equal(videoExtension(Buffer.concat([ebml, Buffer.from('matroska')])), '.mkv');
  } finally { await fs.rm(folder, { recursive: true, force: true }); }
});

test('视频正文和回复在八种风格中保留独立链接范围，缓存恢复不丢资源', () => {
  const source = parseMessage({ message_id: 1, user_id: 2, message: [{ type: 'video', data: { file: 'encoded-video', name: '演示.mp4', url: 'https://example.test/v.mp4' } }] }, 'group:1');
  const reply = parseMessage({ message_id: 2, user_id: 3, message: [{ type: 'reply', data: { id: 1 } }, { type: 'text', data: { text: '看这里' } }] }, 'group:1');
  assert.deepEqual(normalizeSegments(JSON.parse(JSON.stringify(source.segments))), source.segments);
  for (const language of codeLanguages) {
    const view = renderTranscript(newChat('group', 1, '群'), [source, reply], '123', language);
    assert.equal(view.videos.length, 3);
    for (const span of view.videos) {
      assert.match(view.text.split('\n')[span.line].slice(span.start, span.end), /^\[视频(?::(?:1|演示.mp4))?\]$/);
      assert.equal(span.messageId, '1'); assert.equal(span.videoIndex, 0);
      assert.ok(!view.actions.some(a => a.line === span.line && a.start < span.end && a.end > span.start));
    }
  }
});

test('视频惰性下载和缓存复用，视频和文字混排发送真实 video 消息段', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-video-'));
  const backend = new MockNapCat(), client = new OneBotClient(), store = new ChatStore(folder, '123456');
  await backend.start(); await client.connect(backend.url);
  const files = new AttachmentFiles(path.join(folder, 'outgoing')), cache = new MediaCache(path.join(folder, 'media'), client);
  store.upsert(newChat('group', 20002, '群'));
  try {
    const ref = { file: 'v', url: backend.imageUrl + '?video' };
    const expired = path.join(folder, 'media', 'videos', 'expired.mp4');
    await fs.mkdir(path.dirname(expired), { recursive: true }); await fs.writeFile(expired, videoBytes);
    const old = new Date(Date.now() - 8 * 86400000); await fs.utimes(expired, old, old);
    const [a, b] = await Promise.all([cache.getVideo(ref), cache.getVideo(ref)]);
    await assert.rejects(fs.stat(expired), { code: 'ENOENT' });
    assert.equal(a, b); assert.deepEqual(await fs.readFile(a), videoBytes);
    assert.notEqual(await cache.getVideo({ ...ref, url: ref.url + '&another-message' }), a, '同名视频的不同资源地址不能串缓存');
    const attachment = await files.stageAutoPath(a, '示例.mp4'); store.attach('group:20002', [attachment]);
    const placeholder = store.draft('group:20002').attachments[0].placeholder!;
    assert.match(placeholder, /^\[视频:\d+\]$/);
    store.setDraft('group:20002', '前文' + placeholder + '后文');
    assert.equal(draftParts(store.draft('group:20002').text, store.draft('group:20002').attachments).length, 3);
    const outbox = new OutboxService({ store, client, attachments: files, session: new AccountSession(), ready: true, log: () => {} });
    assert.equal(await outbox.submit(store, 'group:20002', store.draft('group:20002').text).completion, true);
    const segments = backend.sent.at(-1).message;
    assert.deepEqual(segments.map((s: any) => s.type), ['text', 'video', 'text']);
    assert.deepEqual(backend.uploadedBytes.get(segments[1].data.file), videoBytes);
    assert.equal(backend.fileUploads.length, 0);
  } finally { client.dispose(); await backend.close(); await store.dispose(); await fs.rm(folder, { recursive: true, force: true }); }
});


test('消息下方用资源指针列出原文件名，正文保留顺序引用，链接仍准确且不触发回复', () => {
  const message = parseMessage({ message_id: 8, user_id: 2, message: [
    { type: 'text', data: { text: '前' } },
    { type: 'video', data: { file: '示例.mp4' } },
    { type: 'text', data: { text: '中' } },
    { type: 'file', data: { file_id: 'f', name: '录音.mp3' } },
    { type: 'video', data: { file: 'second', file_name: '第[二]个.webm' } }
  ] }, 'group:1');
  assert.equal(message.segments[1].type === 'video' && message.segments[1].video.name, '示例.mp4');
  for (const language of codeLanguages) {
    const view = renderTranscript(newChat('group', 1, '群'), [message], '123', language);
    const lines = view.text.split('\n');
    assert.ok(view.text.includes('前[视频:1]中[文件:1][视频:2]'));
    assert.ok(lines.some(line => line.includes('video_1') && line.includes('[视频:示例.mp4]')));
    assert.ok(lines.some(line => line.includes('file_1') && line.includes('[文件:录音.mp3]')));
    assert.ok(lines.some(line => line.includes('video_2') && line.includes('[视频:第［二］个.webm]')));
    if (language === 'c') assert.ok(view.text.includes('char *video_1'));
    for (const span of [...view.files, ...view.videos]) {
      assert.ok(lines[span.line].slice(span.start, span.end).startsWith('['));
      assert.ok(!view.actions.some(a => a.line === span.line && a.start < span.end && a.end > span.start));
    }
    assert.ok(view.ownLines.length === 0);
  }
});
