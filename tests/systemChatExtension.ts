import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import type { QQApp } from '../src/extension';
import { MockNapCat, until } from './fixture';
import { TestUI } from './ui';

export async function testSystemChat(app: QQApp, backend: MockNapCat, ui: TestUI, checks: string[]): Promise<void> {
  const key = 'private:2010741172', store = app.store!, sentBefore = backend.sent.length;
  const notifications = vscode.workspace.getConfiguration('qq').get('notifications');
  try {
    await vscode.workspace.getConfiguration('qq').update('notifications', 'off', vscode.ConfigurationTarget.Global);
    backend.emit({ post_type: 'message', self_id: Number(store.selfId), message_type: 'private', sub_type: 'other',
      user_id: 2010741172, message_id: 991070, time: Math.floor(Date.now() / 1000),
      sender: { user_id: 2010741172, nickname: '2010741172' }, message: [{ type: 'json', data: { data: JSON.stringify({
        prompt: '[QQ邮箱] 收到新邮件', meta: { detail: { title: '系统通知适配测试', desc: '测试邮件摘要', url: 'https://mail.qq.com/' } }
      }) } }]
    });
    await until(() => !!store.messages.get(key)?.some(m => m.id === '991070'));
    assert.equal(store.chats.get(key)!.name, 'QQ邮箱');
    assert.equal(store.chats.get(key)!.unread, 1);
    assert.ok(store.chats.get(key)!.preview.includes('系统通知适配测试'));
    const tree = app.trees[0].getTreeItem(store.chats.get(key)!);
    assert.equal((tree.iconPath as vscode.ThemeIcon).id, 'mail');
    assert.ok(String(tree.tooltip).includes('系统通知'));
    await app.openChat(key);
    await until(() => !!vscode.window.activeTextEditor?.document.getText().includes('系统通知适配测试'));
    const text = vscode.window.activeTextEditor!.document.getText();
    assert.ok(text.includes('QQ邮箱')); assert.ok(text.includes('测试邮件摘要'));
    assert.ok(text.includes('https://mail.qq.com/')); assert.ok(!text.includes('[卡片]'));
    await vscode.commands.executeCommand('qq.show.list');
    const list = await ui.webview('body[data-section="list"] #search');
    await until(async () => await list.evaluate(`document.querySelector('[data-key="${key}"] .name')?.textContent === 'QQ邮箱'`));
    assert.equal(await list.evaluate(`document.querySelector('[data-key="${key}"] .kind')?.title`), '系统通知');
    const otherKey = 'private:900000001';
    backend.strangerNames.set('900000001', '其他服务通知');
    backend.emit({ post_type: 'message', self_id: Number(store.selfId), message_type: 'private', sub_type: 'other',
      user_id: 900000001, message_id: 991071, time: Math.floor(Date.now() / 1000),
      message: [{ type: 'json', data: { data: JSON.stringify({ meta: { news: { title: '通用通知标题', desc: '其他服务通知摘要' } } }) } }]
    });
    await until(() => store.chats.get(otherKey)?.name === '其他服务通知');
    await app.openChat(otherKey);
    await until(() => !!vscode.window.activeTextEditor?.document.getText().includes('通用通知标题'));
    assert.ok(backend.calls.some(call => call.action === 'get_stranger_info' && String(call.params.user_id) === '900000001'));
    assert.equal(backend.sent.length, sentBefore);
    checks.push('QQ 邮箱显示名称、通知图标及卡片内容；未知服务号通过资料接口补全名称，不向 QQ 发消息');
  } finally {
    await vscode.workspace.getConfiguration('qq').update('notifications', notifications, vscode.ConfigurationTarget.Global);
    store.chats.delete(key); store.messages.delete(key); app.trees.forEach(tree => tree.refresh());
    store.chats.delete('private:900000001'); store.messages.delete('private:900000001'); backend.strangerNames.delete('900000001');
  }
}
