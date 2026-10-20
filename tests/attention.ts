import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ChatStore } from '../src/store';
import { newChat, parseMessage } from '../src/model';

const message = (id: number, extra: Record<string, unknown> = {}) => parseMessage({ message_id: id, time: id, user_id: 456, message: [{ type: 'at', data: { qq: '123' } }], ...extra }, 'group:1', '123');

test('新提及与回复独立于普通未读，逐条查看、撤回及去重', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-attention-')), store = new ChatStore(folder, '123');
  try {
    store.upsert(newChat('group', 1, '群'));
    store.add(message(1, { user_id: 123, message: '我发的原文' }), false);
    store.add(message(2), true);
    const reply = message(3, { message: [{ type: 'reply', data: { id: '1' } }, { type: 'at', data: { qq: '123' } }] });
    store.add(reply, true); assert.equal(store.add(reply, true), false);
    store.history('group:1', [message(0)]);
    store.markRead('group:1');
    assert.deepEqual(store.unseenAttention('group:1').map(m => m.id), ['2', '3']);
    store.markViewed('group:1', new Set(['3']));
    assert.deepEqual(store.unseenAttention('group:1').map(m => m.id), ['2']);
    store.recall('group:1', '2'); assert.equal(store.unseenAttention('group:1').length, 0);
  } finally { await store.dispose(); await fs.rm(folder, { recursive: true, force: true }); }
});

test('引用原文迟到时，已看过的回复不会重新提醒，未看过的会出现', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-attention-late-')), store = new ChatStore(folder, '123');
  try {
    store.upsert(newChat('group', 1, '群'));
    const first = message(1, { message: [{ type: 'reply', data: { id: 'missing' } }] });
    const second = { ...first, id: '2', time: 2 };
    store.add(first, true); store.add(second, true);
    assert.equal(store.unseenAttention('group:1').length, 0);
    store.markViewed('group:1', new Set(['1']));
    store.enrichMessage({ ...first, replyToSelf: true });
    store.enrichMessage({ ...second, replyToSelf: true });
    assert.deepEqual(store.unseenAttention('group:1').map(m => m.id), ['2']);
  } finally { await store.dispose(); await fs.rm(folder, { recursive: true, force: true }); }
});

test('待看记录重启保留，历史补拉不恢复已查看状态，也不把旧历史标成新提醒', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-attention-restore-'));
  let store = new ChatStore(folder, '123');
  try {
    store.upsert(newChat('group', 1, '群')); store.add(message(1), true); store.add(message(2), true);
    store.markViewed('group:1', new Set(['1'])); await store.dispose();
    store = new ChatStore(folder, '123'); await store.restore(); await store.load('group:1');
    store.history('group:1', [message(1), message(2), message(3)]);
    assert.deepEqual(store.unseenAttention('group:1').map(m => m.id), ['2']);
    assert.equal(store.messages.get('group:1')!.find(m => m.id === '1')!.attentionUnseen, false);
  } finally { await store.dispose(); await fs.rm(folder, { recursive: true, force: true }); }
});
