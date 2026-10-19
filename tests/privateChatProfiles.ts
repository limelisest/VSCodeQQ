import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ChatStore } from '../src/store';
import { newChat, parseMessage } from '../src/model';
import { OneBotClient } from '../src/onebot';
import { PrivateChatProfiles } from '../src/privateChatProfiles';

function client(query: (id: string) => Promise<any>): Pick<OneBotClient, 'call'> {
  return { call: <T = any>(action: string, params: Record<string, unknown> = {}) => {
    assert.equal(action, 'get_stranger_info'); return query(String(params.user_id)) as Promise<T>;
  } };
}

test('不依赖系统账号名单，资料接口补全服务号和陌生私聊，保留好友备注', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-profiles-')), store = new ChatStore(folder, '123');
  const calls: string[] = [], names = new Map([['900001', '天气通知'], ['900002', '安全提醒'], ['900003', '陌生用户']]);
  const profiles = new PrivateChatProfiles(store, client(async id => { calls.push(id); return { user_id: id, nickname: names.get(id) }; }), () => true);
  try {
    for (const id of names.keys()) store.upsert(newChat('private', id, id));
    store.upsert({ ...newChat('private', '900004', '好友备注'), remark: '好友备注' });
    store.upsert(newChat('group', '900005', '900005'));
    store.upsert(newChat('private', '123', '123'));
    await profiles.refresh();
    assert.deepEqual(calls, [...names.keys()]);
    for (const [id, name] of names) assert.equal(store.chats.get(`private:${id}`)!.name, name);
    assert.equal(store.chats.get('private:900004')!.name, '好友备注');
    await profiles.refresh(); assert.equal(calls.length, 3);
    store.upsert(newChat('private', '900006', '900006'));
    await profiles.observe(parseMessage({ user_id: 900006, sender: { nickname: '通知中心' }, message: '通知' }, 'private:900006'));
    assert.equal(store.chats.get('private:900006')!.name, '通知中心');
    assert.equal(calls.length, 3, '实时事件已有名称时不额外查询资料');
  } finally { await store.dispose(); await fs.rm(folder, { recursive: true, force: true }); }
});

test('资料查询复用进行中的请求，迟到结果不覆盖新好友资料或新连接', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-profile-race-')), store = new ChatStore(folder, '123');
  let current = true, calls = 0;
  const releases = new Map<string, (value: any) => void>();
  const profiles = new PrivateChatProfiles(store, client(id => { calls++; return new Promise(resolve => releases.set(id, resolve)); }), () => current);
  try {
    for (const id of ['900001', '900002']) store.upsert(newChat('private', id, id));
    const first = profiles.ensure('private:900001');
    assert.equal(profiles.ensure('private:900001'), first); assert.equal(calls, 1);
    store.upsert({ ...store.chats.get('private:900001')!, name: '刚同步的备注', remark: '刚同步的备注' });
    releases.get('900001')!({ user_id: 900001, nickname: '迟到昵称' }); await first;
    assert.equal(store.chats.get('private:900001')!.name, '刚同步的备注');
    const second = profiles.ensure('private:900002'); current = false;
    releases.get('900002')!({ user_id: 900002, nickname: '旧连接昵称' }); await second;
    assert.equal(store.chats.get('private:900002')!.name, '900002');
  } finally { await store.dispose(); await fs.rm(folder, { recursive: true, force: true }); }
});

test('资料 API 不支持、返回数字名称或错误身份时保留原会话，失败不反复请求', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-profile-fallback-')), store = new ChatStore(folder, '123');
  let calls = 0;
  const profiles = new PrivateChatProfiles(store, client(async id => {
    calls++;
    if (id === '900001') throw new Error('unsupported');
    return { user_id: id === '900002' ? '999999' : id, nickname: id === '900002' ? '错误身份' : id };
  }), () => true);
  try {
    for (const id of ['900001', '900002', '2010741172']) store.upsert(newChat('private', id, id));
    await profiles.refresh(); await profiles.refresh(); assert.equal(calls, 3);
    assert.equal(store.chats.get('private:900001')!.name, '900001');
    assert.equal(store.chats.get('private:900002')!.name, '900002');
    assert.equal(store.chats.get('private:2010741172')!.name, 'QQ邮箱');
  } finally { await store.dispose(); await fs.rm(folder, { recursive: true, force: true }); }
});
