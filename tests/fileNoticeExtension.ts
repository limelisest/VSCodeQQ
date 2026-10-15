import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import type { QQApp } from '../src/extension';
import { parseMessage } from '../src/model';
import { MockNapCat, until } from './fixture';

export async function testFileNotices(app: QQApp, backend: MockNapCat, checks: string[]): Promise<void> {
  const key = 'private:10001', store = app.store!;
  const sentBefore = backend.sent.length;
  store.add(parseMessage({ message_id: 99030, user_id: store.selfId, message: [
    { type: 'file', data: { file_id: 'receipt-file', name: '回执测试.txt' } }
  ] }, key, store.selfId), false);
  const unread = store.chats.get(key)!.unread;
  const notice = { post_type: 'notice', self_id: Number(store.selfId), peer_id: 10001, time: Math.floor(Date.now() / 1000), notice_type: 'online_file_send' };
  backend.emit({ ...notice, sub_type: 'receive' });
  await until(() => !!store.messages.get(key)?.some(m => m.systemNotice === '对方已接收文件'));
  assert.equal(store.chats.get(key)!.unread, unread);
  await app.openChat(key);
  await until(() => !!vscode.window.activeTextEditor?.document.getText().includes('文件传输：对方已接收文件'));
  backend.emit({ ...notice, sub_type: 'refuse' });
  backend.emit({ ...notice, notice_type: 'online_file_receive', sub_type: 'cancel' });
  await until(() => !!vscode.window.activeTextEditor?.document.getText().includes('对方取消了文件传输'));
  assert.ok(vscode.window.activeTextEditor!.document.getText().includes('对方拒绝接收文件'));
  assert.ok(vscode.window.activeTextEditor!.document.getText().includes('[文件:回执测试.txt]'));
  assert.equal(store.messages.get(key)!.find(m => m.id === '99030')!.systemNotice, undefined);
  assert.equal(backend.sent.length, sentBefore, '回执验证不得向 QQ 发送任何消息');
  checks.push('NapCat 文件接收、拒收和取消事件显示在私聊，保留原文件且不增加未读');
}
