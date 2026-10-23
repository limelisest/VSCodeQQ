import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import type { QQApp } from '../src/extension';
import { parseMessage } from '../src/model';
import { MockNapCat, until } from './fixture';
import { TestUI } from './ui';

export async function testMessageNotifications(app: QQApp, backend: MockNapCat, ui: TestUI, checks: string[]): Promise<void> {
  const config = vscode.workspace.getConfiguration('qq'), previous = config.get('notifications');
  const store = app.store!, key = 'private:10001';
  const code = await vscode.workspace.openTextDocument({ content: '// notification timing test', language: 'typescript' });
  const probe = 'notification-preview-probe';
  const selector = `Array.from(document.querySelectorAll('.notifications-toasts .notification-list-item')).find(el => el.textContent.includes('${probe}'))`;
  try {
    await config.update('notifications', 'all', vscode.ConfigurationTarget.Global);
    await app.openChat(key); await vscode.window.showTextDocument(code);
    await vscode.commands.executeCommand('notifications.clearAll');
    await new Promise(resolve => setTimeout(resolve, 900));
    const message = parseMessage({ ...backend.message(99180, probe + ' ' + '多行内容\n'.repeat(80) + 'hidden-full-message-tail'), message_type: 'private', group_id: undefined }, key, store.selfId);
    store.add(message, true);
    const start = Date.now();
    await (app as any).notifyMessage(store, message);
    await ui.waitFor(`!!(${selector})`);
    const preview = await ui.evaluate(`(() => {
      const item = (${selector}), message = item.querySelector('.notification-list-item-message');
      const style = getComputedStyle(message);
      return { text: item.textContent, messageText: message.textContent, linkText: message.querySelector('a')?.textContent, height: message.getBoundingClientRect().height, lineHeight: parseFloat(style.lineHeight), links: [...message.querySelectorAll('a')].map(link => link.getAttribute('href')) };
    })()`);
    assert.ok(!preview.text.includes('hidden-full-message-tail'));
    assert.ok(preview.text.includes('…'));
    assert.ok(preview.height <= preview.lineHeight * 2, 'default notification preview stays compact');
    assert.equal(preview.links.length, 1);
    assert.ok(preview.links[0].startsWith('command:qq.openChat?'));
    assert.equal(preview.linkText, preview.messageText, '整段通知摘要都属于同一个会话链接');
    // This unrelated sticky error must survive the QQ notification's timer.
    void vscode.window.showErrorMessage('unrelated-notification-probe', '保留');
    await ui.waitFor(`document.querySelector('.notifications-toasts')?.textContent.includes('unrelated-notification-probe')`);
    const point = await ui.evaluate(`(() => { const el=(${selector}), r=el.getBoundingClientRect(); el.closest('.monaco-list')?.focus(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
    await ui.call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    assert.equal(await ui.evaluate(`(${selector}).matches(':hover')`), true);
    await new Promise(resolve => setTimeout(resolve, Math.max(0, start + 9000 - Date.now())));
    assert.equal(await ui.evaluate(`!!(${selector})`), true, 'preview remains until its deadline');
    await until(async () => !await ui.evaluate(`!!(${selector})`), 2500);
    assert.ok(Date.now() - start < 12000, 'hover/focus does not extend the ten-second lifetime');
    assert.equal(await ui.evaluate(`document.querySelector('.notifications-toasts')?.textContent.includes('unrelated-notification-probe')`), true);
    checks.push('原生消息通知截短摘要，不携带全文；悬停/焦点不延长10秒期限，关闭时不影响其它通知');

    await vscode.commands.executeCommand('notifications.clearAll');
    await assert.rejects(app.openChat({ account: 'other-account', key }), /其他 QQ 账号/);
    assert.equal(vscode.window.activeTextEditor?.document, code);
    await (app as any).notifyMessage(store, message);
    await ui.waitFor(`!!(${selector})`);
    const link = await ui.evaluate(`(() => {const link=(${selector}).querySelector('.notification-list-item-message a'), r=[...link.getClientRects()].find(r=>r.width>0 && r.height>0); return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await ui.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...link, button: 'left', clickCount: 1 });
    await ui.call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...link, button: 'left', clickCount: 1 });
    await until(() => app.transcript?.key(vscode.window.activeTextEditor!.document.uri) === key);
    // The same public command must work with another chat active and after a
    // toast is opened in the notification center, without relying on a target.
    await vscode.commands.executeCommand('notifications.clearAll');
    await app.openChat('group:20002');
    store.add(parseMessage({ ...backend.message(99181, probe + '-from-chat [原文](command:qq.disconnect) \\'), message_type: 'private', group_id: undefined }, key, store.selfId), true);
    await (app as any).notifyMessage(store, store.messages.get(key)!.find(message => message.id === '99181')!);
    await ui.waitFor(`!!(${selector})`);
    const publicLink = await ui.evaluate(`(${selector}).querySelector('a').getAttribute('href')`);
    assert.equal(await ui.evaluate(`(${selector}).querySelectorAll('.notification-list-item-message a').length`), 1, '正文中的命令样式文本不产生额外链接');
    const args = JSON.parse(decodeURIComponent(publicLink.slice(publicLink.indexOf('?') + 1)));
    assert.deepEqual(args, [{ account: store.selfId, key }]);
    await vscode.commands.executeCommand('notifications.showList');
    const centerSelector = `Array.from(document.querySelectorAll('.notifications-center .notification-list-item')).find(el => el.textContent.includes('${probe}-from-chat'))`;
    await ui.waitFor(`!!(${centerSelector})`);
    const centerLink = await ui.evaluate(`(() => {const r=[...(${centerSelector}).querySelector('a').getClientRects()].filter(r=>r.width>0 && r.height>0).at(-1);return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await ui.call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...centerLink });
    await ui.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...centerLink, button: 'left', clickCount: 1 });
    await ui.call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...centerLink, button: 'left', clickCount: 1 });
    await until(() => app.transcript?.key(vscode.window.activeTextEditor!.document.uri) === key);
    await vscode.commands.executeCommand('notifications.hideList');
    checks.push('通知整段摘要均可点击，首行与末行文字真实点击都打开绑定会话；正文中的命令样式文本不生成额外入口');
    await config.update('notifications', 'off', vscode.ConfigurationTarget.Global);
    await ui.waitFor(`!(${selector})`);
    checks.push('通知查看链接仅打开当前账号会话；关闭弹窗配置立即移除本扩展已有通知');
  } finally {
    await config.update('notifications', previous, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('notifications.clearAll');
  }
}
