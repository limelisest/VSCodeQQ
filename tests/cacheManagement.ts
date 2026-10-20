import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { CacheManagement } from '../src/cacheManagement';
import { MediaCache } from '../src/media';
import { OneBotClient } from '../src/onebot';
import { parseMessage } from '../src/model';
import { renderTranscript } from '../src/transcriptRenderer';
import { newChat } from '../src/model';
import { ChatStore } from '../src/store';

test('统一缓存统计和清理保护引用、近期文件、最近表情、下载与链接，账号切换立即停止', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-cache-all-')), refs = new Set<string>(); let current = true;
  const cache = new CacheManagement(folder, async () => refs, () => current);
  const put = async (name: string, old = true) => { const file = path.join(folder, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, Buffer.alloc(10)); if (old) { const date = new Date(Date.now() - 10 * 86400000); await fs.utimes(file, date, date); } return file; };
  try {
    refs.add(await put('outgoing/protected.attachment'));
    await put('outgoing/unused.attachment'); await put('images/unused.png'); await put('images/videos/unused.mp4');
    await put('images/new.png', false); await put('images/pending.download'); await put('recent-emojis/recent.png');
    const before = await cache.info(); assert.equal(before.bytes, 70); assert.equal(before.reclaimableBytes, 30); assert.equal(before.categories!.length, 3);
    assert.equal(await cache.clean(7), 30);
    assert.equal((await cache.info()).bytes, 40);
    await put('images/another.png'); current = false; assert.equal(await cache.clean(0), 0);
    assert.equal((await fs.stat(path.join(folder, 'images/another.png'))).size, 10);
  } finally { await fs.rm(folder, { recursive: true, force: true }); }
});

test('接收图片、视频、文件计算出与实际缓存相同的引用路径', async () => {
  const folder = path.join(os.tmpdir(), 'qq-media-ref'), media = new MediaCache(folder, new OneBotClient()), refs = new Set<string>();
  const message = parseMessage({ user_id: 456, message: [{ type: 'image', data: { file: 'img', url: 'https://example.com/i' } }, { type: 'video', data: { file: 'vid' } }, { type: 'file', data: { file_id: 'file' } }] }, 'private:456');
  media.references(message, refs);
  assert.equal(refs.size, 12); assert.ok([...refs].some(file => file.endsWith('.png')));
  assert.ok([...refs].some(file => file.includes(path.join('images', 'videos')) || file.includes(path.join('qq-media-ref', 'videos'))));
  assert.ok([...refs].some(file => file.includes('file-') && file.endsWith('.attachment')));
});

test('未打开会话在磁盘历史中引用的接收图片也受到清理保护', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-cache-history-')), store = new ChatStore(folder, '123');
  const media = new MediaCache(path.join(folder, 'images'), new OneBotClient()), chat = newChat('private', 456, '好友');
  try {
    store.upsert(chat);
    const message = parseMessage({ user_id: 456, message: [{ type: 'image', data: { file: 'history-image', url: 'https://example.com/image' } }] }, chat.key);
    await fs.writeFile(path.join(folder, 'private-456.json'), JSON.stringify([message]));
    const protectedPaths = new Set<string>(); media.references(message, protectedPaths);
    const image = [...protectedPaths].find(file => file.endsWith('.png'))!;
    await fs.mkdir(path.dirname(image), { recursive: true }); await fs.writeFile(image, 'protected');
    const old = new Date(Date.now() - 30 * 86400000); await fs.utimes(image, old, old);
    const manager = new CacheManagement(folder, async () => { const refs = new Set<string>(); for (const file of await store.attachmentReferences(m => media.references(m, refs))) refs.add(file); return refs; });
    assert.equal(await manager.clean(0), 0); assert.equal(await fs.readFile(image, 'utf8'), 'protected');
  } finally { await store.dispose(); await fs.rm(folder, { recursive: true, force: true }); }
});

test('补全的提醒类型定位到正确消息，发送状态不覆盖撤回，@我优先于全体', () => {
  const chat = newChat('group', 1, '群');
  const all = parseMessage({ user_id: 456, message_id: 1, message: [{ type: 'at', data: { qq: 'all' } }] }, chat.key, '123');
  const me = parseMessage({ user_id: 456, message_id: 2, message: [{ type: 'at', data: { qq: 'all' } }, { type: 'at', data: { qq: '123' } }] }, chat.key, '123');
  const failed = { ...parseMessage({ user_id: 123, message_id: 3, message: '失败' }, chat.key, '123'), sendState: 'failed' as const };
  const uncertain = { ...failed, id: '4', sendState: 'uncertain' as const }, recalled = { ...failed, id: '5', recalled: true };
  const view = renderTranscript(chat, [all, me, failed, uncertain, recalled], '123');
  assert.ok(view.allMentionLines.length); assert.ok(view.allMentionLines.every(line => view.messages.get(line) === '1'));
  assert.equal(view.failedLines.length, 1); assert.equal(view.uncertainLines.length, 1);
  assert.equal(view.messages.get(view.failedLines[0]), '3'); assert.equal(view.messages.get(view.uncertainLines[0]), '4');
});
