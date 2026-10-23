import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { QQApp } from '../src/extension';
import { newChat, parseMessage } from '../src/model';
import { MockNapCat, png, until } from './fixture';
import { TestUI } from './ui';
import { DRAFT_DIVIDER } from '../src/nativeEditor';

async function clickDraftAction(ui: TestUI, label: string): Promise<void> {
  const point = await ui.waitFor(`(() => {const el=[...document.querySelectorAll('.editor-group-container.active .codelens-decoration a')].find(el=>el.textContent.trim()===${JSON.stringify(label)} && el.getBoundingClientRect().width>0);if(!el)return null;const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await ui.call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
  await ui.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
  await ui.call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
}

export async function testAttention(app: QQApp, backend: MockNapCat, ui: TestUI, checks: string[]): Promise<void> {
  const store = app.store!, key = 'group:20002', sent = backend.sent.length;
  const config = vscode.workspace.getConfiguration('qq'), previousLanguage = config.get('codeLanguage');
  const label = '上一个 @ 或回复';
  const buttons = `Array.from(document.querySelectorAll('.codelens-decoration a')).filter(el=>{const r=el.getBoundingClientRect();return el.textContent.includes(${JSON.stringify(label)}) && r.width>0 && r.top>100 && r.bottom<window.innerHeight-40;})`;
  const code = await vscode.workspace.openTextDocument({ content: 'const ordinaryCode = 1;', language: 'javascript' });
  const base = Math.floor(Date.now() / 1000) + 500;
  const add = (n: number, parts: unknown, chat = key, own = false) => {
    const sender = own ? store.selfId : '10001';
    const message = parseMessage({ ...backend.message(880000 + n), time: base + n, user_id: sender, sender: { user_id: sender, nickname: own ? '我' : '验收成员' }, message: parts }, chat, store.selfId);
    store.add(message, !own); return message.id;
  };
  const click = async () => {
    const point = await ui.waitFor(`(() => {const el=(${buttons})[0];if(!el)return null;const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await ui.call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    await ui.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await ui.call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
  };
  const aboveMessage = async (editor: vscode.TextEditor, id: string) => {
    const start = app.transcript!.rendered.get(key)!.starts.get(id)!;
    const lenses = app.editor.provideCodeLenses(editor.document);
    assert.deepEqual(lenses.filter(lens => lens.range.start.line === start).map(lens => lens.command?.command), ['qq.previousAttention']);
    assert.ok(lenses.filter(lens => lens.command?.command !== 'qq.previousAttention').every(lens => lens.range.start.line === editor.document.positionAt(app.native.region(editor.document)!.start).line - 1));
    const stamp = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.exec(editor.document.lineAt(start).text)![0];
    await ui.waitFor(`(() => {
      const link = (${buttons})[0];
      const date = [...document.querySelectorAll('.editor-group-container.active .view-line')].find(line => line.textContent.replace(/\\u00a0/g, ' ').includes(${JSON.stringify(stamp)}));
      return link && date && link.getBoundingClientRect().bottom <= date.getBoundingClientRect().top + 1;
    })()`);
  };
  try {
    await app.openChat(key); await app.loadHistory(key);
    store.setDraft(key, '定位后保留的草稿'); await app.native.sync(vscode.window.activeTextEditor!);
    await vscode.window.showTextDocument(code);
    const original = add(0, [{ type: 'text', data: { text: '我的原消息' } }], key, true);
    for (let i = 1; i <= 90; i++) add(i, i === 8 ? [{ type: 'reply', data: { id: original } }, { type: 'text', data: { text: '较早的回复' } }]
      : i === 40 ? [{ type: 'reply', data: { id: original } }, { type: 'at', data: { qq: store.selfId } }, { type: 'text', data: { text: '较新的回复与提及' } }]
      : [{ type: 'text', data: { text: `间隔消息 ${i}` } }]);
    add(200, [{ type: 'at', data: { qq: store.selfId } }], 'group:20001');
    store.markRead(key);
    assert.deepEqual(store.unseenAttention(key).map(m => m.id), ['880008', '880040']);
    await ui.waitFor(`(${buttons}).length === 0`);
    await app.openChat('private:10001'); await ui.waitFor(`(${buttons}).length === 0`);
    checks.push('写普通代码、查看无提醒会话时隐藏，其他会话的提醒不进入当前按钮');
    await app.openChat(key);
    const editor = vscode.window.activeTextEditor!;
    await ui.waitFor(`(${buttons}).length === 1`);
    assert.equal(app.editor.provideCodeLenses(editor.document).find(lens => lens.command?.command === 'qq.previousAttention')!.range.start.line, editor.document.positionAt(app.native.region(editor.document)!.start).line - 1);
    assert.deepEqual(app.editor.provideCodeLenses(editor.document).map(lens => lens.command!.title), ['表情', '图片', '文件', '转发', '↑ 上一个 @ 或回复']);
    await ui.waitFor(`(() => { const jump=(${buttons})[0], links=[...jump.parentElement.querySelectorAll('a')]; return links.map(el=>el.textContent.trim()).join('|')==='表情|图片|文件|转发|↑ 上一个 @ 或回复'; })()`);
    assert.ok(!editor.document.getText().includes(label), '提示不写入聊天文本或草稿');
    assert.equal(await ui.evaluate(`(${buttons})[0].textContent.trim().endsWith(${JSON.stringify(label)})`), true);
    await click();
    await until(() => app.transcript!.rendered.get(key)!.messages.get(editor.selection.active.line) === '880040');
    assert.deepEqual(store.unseenAttention(key).map(m => m.id), ['880008']);
    assert.equal(store.draft(key).text, '定位后保留的草稿');
    assert.equal(app.editor.isFollowing(editor), false);
    await aboveMessage(editor, '880040');
    assert.equal(app.editor.provideCodeLenses(editor.document).find(lens => lens.command?.command === 'qq.previousAttention')!.command!.arguments![1], '880008');
    assert.equal(await ui.evaluate(`Array.from(document.querySelectorAll('.statusbar-item')).some(el=>el.textContent.includes(${JSON.stringify(label)}))`), false);
    checks.push('草稿功能入口后面按需显示跳转；点击后历史消息 DATE 上方仅显示跳转，功能入口仍固定在草稿处且不写入正文');
    await config.update('codeLanguage', 'python', vscode.ConfigurationTarget.Global);
    await app.native.sync(editor, true);
    await until(() => app.native.historyMatches(editor.document) && editor.document.getText().includes('def '));
    await ui.waitFor(`(${buttons}).length === 1`);
    await aboveMessage(editor, '880040');
    await new Promise(resolve => setTimeout(resolve, 500));
    const shot = await ui.call('Page.captureScreenshot', { format: 'png' });
    const folder = path.join(__dirname, '..', '..', '.test-output'); await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, 'attention-button.png'), Buffer.from(shot.data, 'base64'));
    await click();
    try { await until(() => app.transcript!.rendered.get(key)!.messages.get(editor.selection.active.line) === '880008'); }
    catch (error) {
      console.log('文内定位失败', JSON.stringify({ selected: app.transcript!.rendered.get(key)!.messages.get(editor.selection.active.line), unseen: store.unseenAttention(key).map(m=>m.id), links: app.editor.provideCodeLenses(editor.document), draft: store.draft(key).text }));
      throw error;
    }
    await ui.waitFor(`(${buttons}).length === 0`);
    assert.equal(store.draft(key).text, '定位后保留的草稿');
    checks.push('沿消息上的链接继续向前查看，切换代码风格仍定位正确，看完后仅跳转链接消失');
    const reference = app.transcript!.provideDocumentLinks(editor.document).find(l => l.target?.path === 'qq.openReplyOriginal' && l.range.start.line > app.transcript!.rendered.get(key)!.starts.get('880008')!)!;
    assert.equal(editor.document.getText(reference.range), 'replay');
    await new Promise(resolve => setTimeout(resolve, 500));
    await ui.clickText('replay');
    try { await until(() => app.transcript!.rendered.get(key)!.messages.get(editor.selection.active.line) === original); }
    catch (error) {
      console.log('引用定位失败', JSON.stringify({ selected: editor.selection, command: app.transcript!.clickCommand(editor.document, editor.selection.active)?.toString(), source: original, history: app.native.historyMatches(editor.document), hasOriginal: store.messages.get(key)?.some(m=>m.id===original) }));
      throw error;
    }
    assert.equal(store.draft(key).text, '定位后保留的草稿');
    checks.push('回复引用的 replay 字段可单击跳到缓存中的原消息，引用内图片等操作保持独立');
    await vscode.window.showTextDocument(code);
    const visible = add(100, [{ type: 'at', data: { qq: store.selfId } }, { type: 'text', data: { text: '底部可见的提及' } }]);
    await app.openChat(key);
    await until(() => store.messages.get(key)!.find(m => m.id === visible)!.attentionUnseen === false);
    await ui.waitFor(`(${buttons}).length === 0`);
    const late = add(101, [{ type: 'reply', data: { id: 'not-cached-original' } }, { type: 'text', data: { text: '引用结果迟到' } }]);
    await app.native.sync(vscode.window.activeTextEditor!); await vscode.commands.executeCommand('qq.latest');
    await until(() => store.messages.get(key)!.find(m => m.id === late)!.attentionUnseen === false);
    store.enrichMessage({ ...store.messages.get(key)!.find(m => m.id === late)!, replyToSelf: true });
    await ui.waitFor(`(${buttons}).length === 0`);
    checks.push('自然滚动看到的消息自动消除待看状态，已看过消息的回复判断迟到不会再次提醒');
    await vscode.window.showTextDocument(code);
    const recalled = add(110, [{ type: 'at', data: { qq: store.selfId } }]);
    for (let i = 111; i <= 140; i++) add(i, [{ type: 'text', data: { text: '撤回验收间隔' } }]);
    await app.openChat(key); await ui.waitFor(`(${buttons}).length === 1`);
    store.recall(key, recalled); await ui.waitFor(`(${buttons}).length === 0`);
    const manual = add(150, [{ type: 'at', data: { qq: store.selfId } }]);
    await vscode.window.showTextDocument(code);
    await vscode.commands.executeCommand('qq.markRead', key);
    assert.equal(store.messages.get(key)!.find(m => m.id === manual)!.attentionUnseen, false);
    assert.equal(backend.sent.length, sent);
    checks.push('撤回和主动标记已读会清理待看状态，验收只操作本地草稿，不向 QQ 发送消息');
    await testStatusBar(app, backend, ui, checks, code);
    await testDraftSend(app, backend, ui, checks, code);
    // Keep the chat tab open across extension shutdown/start, as on window restore.
    const restoredUri = vscode.window.activeTextEditor!.document.uri.toString();
    await app.shutdown();
    const restarted = new QQApp(app.context);
    try {
      await restarted.start();
      assert.equal(vscode.window.activeTextEditor!.document.uri.toString(), restoredUri);
      assert.equal(restarted.target, 'group:20002', '启动时从已恢复的会话标签初始化目标');
      await testFileSelection(restarted, backend, ui, checks);
    } finally { await restarted.shutdown(); }
  } finally { await config.update('codeLanguage', previousLanguage, vscode.ConfigurationTarget.Global); }
}

async function testDraftSend(app: QQApp, backend: MockNapCat, ui: TestUI, checks: string[], code: vscode.TextDocument): Promise<void> {
  const store = app.store!, key = 'group:20002'; await app.openChat(key);
  const editor = vscode.window.activeTextEditor!;
  store.setDraft(key, '分界线发送验收', undefined, []); await app.native.sync(editor);
  const dividerLine = editor.document.positionAt(app.native.region(editor.document)!.start).line - 1;
  assert.equal(editor.document.lineAt(dividerLine).text, DRAFT_DIVIDER);
  assert.ok(!DRAFT_DIVIDER.includes('草稿') && !DRAFT_DIVIDER.includes('[发送]'));
  const uri = editor.document.uri.toString(), sent = backend.sent.length;
  await vscode.window.showTextDocument(code); await vscode.commands.executeCommand('qq.send', uri);
  assert.equal(backend.sent.length, sent); assert.equal(store.draft(key).text, '分界线发送验收');
  await app.focusInput();
  await until(() => !app.native.isUpdating(editor.document) && app.native.historyMatches(editor.document));
  await ui.waitFor(`document.querySelector('.editor-group-container.active .view-lines')?.textContent.includes('分界线发送验收')`);
  await ui.enter();
  await until(() => backend.sent.length === sent + 1 && store.draft(key).text === '' && !app.native.isUpdating(editor.document));
  assert.equal(backend.sent.at(-1).message[0].data.text, '分界线发送验收');
  await ui.enter(); await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(backend.sent.length, sent + 1);
  checks.push('分界线仅显示发送换行提示，Enter 实际发送草稿，空草稿不重复提交，旧会话参数不能跨文档发送');
}

async function testFileSelection(app: QQApp, backend: MockNapCat, ui: TestUI, checks: string[]): Promise<void> {
  const config = vscode.workspace.getConfiguration('files'), previous = config.get('simpleDialog.enable');
  const store = app.store!, key = 'group:20002', sent = backend.sent.length;
  const folder = path.join(__dirname, '..', '..', '.test-output', 'picker-files'); await fs.mkdir(folder, { recursive: true });
  const image = path.join(folder, 'picker.png'), file = path.join(folder, 'picker.txt');
  await fs.writeFile(image, png); await fs.writeFile(file, '文件选择验收');
  // Exercise VS Code's real dialog API and filesystem picker. This does not
  // validate the separate Windows native-dialog rendering path.
  try {
    await config.update('simpleDialog.enable', true, vscode.ConfigurationTarget.Global);
    assert.equal(app.transcript!.key(vscode.window.activeTextEditor!.document.uri), key);
    store.setDraft(key, '保留文件选择草稿', undefined, []); await app.native.sync(vscode.window.activeTextEditor!);
    for (const [button, source, title] of [['image', image, '选择要发送的图片'], ['file', file, '选择要发送的文件']]) {
      // Restored qqchat tabs can be active before the legacy target is initialized.
      app.target = undefined;
      await clickDraftAction(ui, button === 'image' ? '图片' : '文件');
      await ui.waitFor(`document.querySelector('.quick-input-widget')?.textContent.includes(${JSON.stringify(title)})`);
      await ui.evaluate(`document.querySelector('.quick-input-widget input').focus()`);
      await ui.call('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
      await ui.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
      await ui.call('Input.insertText', { text: source });
      await new Promise(resolve => setTimeout(resolve, 500));
      const shot = await ui.call('Page.captureScreenshot', { format: 'png' });
      await fs.writeFile(path.join(folder, `${button}-dialog.png`), Buffer.from(shot.data, 'base64'));
      await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
      await until(() => store.draft(key).attachments.some(a => a.label === path.basename(source)));
      assert.equal(app.target, key);
      assert.ok(store.draft(key).text.includes('保留文件选择草稿'));
    }
    assert.ok(store.draft(key).attachments.some(a => a.kind === 'image'));
    assert.ok(store.draft(key).attachments.some(a => a.kind === 'file'));
    assert.equal(backend.sent.length, sent);
    checks.push('保留 QQ 标签重启插件后恢复当前会话；清空旧 target 后实际点击图片和文件文字入口，打开 VS Code 简易文件框并选入磁盘资源；未覆盖 Windows 原生弹窗');
  } finally { await config.update('simpleDialog.enable', previous, vscode.ConfigurationTarget.Global); }
}

async function testStatusBar(app: QQApp, backend: MockNapCat, ui: TestUI, checks: string[], code: vscode.TextDocument): Promise<void> {
  const store = app.store!, config = vscode.workspace.getConfiguration('qq');
  const originalNotifications = config.get('notifications'), originalButtons = config.get('statusBarButtons');
  const statusText = `Array.from(document.querySelectorAll('.statusbar-item')).filter(el=>el.getBoundingClientRect().width>0).map(el=>el.textContent).join('|')`;
  const count = async (n: number) => ui.waitFor(`document.querySelector('[id$="qq.unread"]')?.textContent.trim() === '${n}'`);
  const buttonVisible = (key: string) => `Array.from(document.querySelectorAll('.editor-group-container.active .codelens-decoration a')).some(el=>el.textContent.trim()===${JSON.stringify(({ emojis: '表情', image: '图片', file: '文件', forward: '转发' } as Record<string, string>)[key] ?? key)} && el.getBoundingClientRect().width>0)`;
  const add = (id: number, key: string, body: string) => {
    const message = parseMessage({ ...backend.message(id), message: body }, key, store.selfId);
    store.add(message, true); return message;
  };
  try {
    assert.deepEqual(config.get('statusBarButtons'), ['emojis', 'image', 'file', 'forward']);
    await app.openChat('group:20002');
    await ui.waitFor(`${buttonVisible('emojis')} && ${buttonVisible('image')} && ${buttonVisible('file')} && ${buttonVisible('forward')}`);
    const lenses = app.editor.provideCodeLenses(vscode.window.activeTextEditor!.document);
    assert.equal(lenses.find(lens => lens.command?.title === '图片')?.command?.command, 'qq.insertImage');
    assert.equal(lenses.find(lens => lens.command?.title === '文件')?.command?.command, 'qq.insertFile');
    await ui.waitFor(`!!document.querySelector('[id$="qq.status.latest"]') && !document.querySelector('[id$="qq.status.emojis"]') && !document.querySelector('[id$="qq.status.image"]')`);
    const latestPoint = await ui.evaluate(`(() => {const r=document.querySelector('[id$="qq.status.latest"]').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    app.editor.follow(vscode.window.activeTextEditor!, false);
    await ui.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...latestPoint, button: 'left', clickCount: 1 });
    await ui.call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...latestPoint, button: 'left', clickCount: 1 });
    await until(() => app.editor.isFollowing(vscode.window.activeTextEditor!));
    const shot = await ui.call('Page.captureScreenshot', { format: 'png' });
    const folder = path.join(__dirname, '..', '..', '.test-output'); await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, 'draft-actions.png'), Buffer.from(shot.data, 'base64'));
    await vscode.window.showTextDocument(code);
    await ui.waitFor(`!(${buttonVisible('emojis')}) && !(${buttonVisible('image')}) && !(${buttonVisible('file')})`);
    const chatDocument = await vscode.workspace.openTextDocument(app.transcript!.uri(store.chats.get('group:20002')!));
    await vscode.window.showTextDocument(chatDocument, vscode.ViewColumn.One);
    const page = vscode.window.createWebviewPanel('qq.test.status', '普通页面', vscode.ViewColumn.Beside, {});
    try {
      page.webview.html = '<!doctype html><html><body>普通页面</body></html>';
      await ui.waitFor(`!(${buttonVisible('emojis')}) && !(${buttonVisible('image')}) && !(${buttonVisible('file')})`);
      const shot = await ui.call('Page.captureScreenshot', { format: 'png' });
      await fs.writeFile(path.join(folder, 'status-nonchat.png'), Buffer.from(shot.data, 'base64'));
    } finally { page.dispose(); }
    const imagePath = path.join(folder, 'status-visibility.png'); await fs.writeFile(imagePath, png);
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(imagePath), { viewColumn: vscode.ViewColumn.Beside, preview: false });
    try {
      await until(() => !(vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputText));
      await ui.waitFor(`!(${buttonVisible('emojis')}) && !(${buttonVisible('image')}) && !(${buttonVisible('file')})`);
    } finally { const tab = vscode.window.tabGroups.activeTabGroup.activeTab; if (tab) await vscode.window.tabGroups.close(tab); }
    await vscode.window.showTextDocument(code, vscode.ViewColumn.One);
    checks.push('QQ 会话仍在另一分栏可见时，普通页面和图片预览作为当前标签仍隐藏全部功能入口');
    for (const chat of store.chats.values()) store.markRead(chat.key);
    const quiet = newChat('group', '20009', '不计数免打扰'), ignored = newChat('private', '99001', '手动不提醒');
    store.upsert(quiet); store.setNotification(quiet.key, 'muted');
    store.upsert(ignored); store.toggleIgnoreUnread(ignored.key);
    store.setNotification('group:20002', 'notify');
    add(890001, quiet.key, '免打扰正文'); add(890002, ignored.key, '不提醒正文');
    const quietChat = store.chats.get(quiet.key)!;
    quietChat.unread = 13418; quietChat.mentioned = true; store.markReplyToSelf(quiet.key);
    await count(0);
    const message = add(890003, 'private:10001', 'status-secret-body');
    add(890004, 'group:20002', '另一个会话的正文');
    await count(2);
    const unreadChats = vscode.commands.executeCommand('qq.openUnread');
    await ui.waitFor(`document.querySelector('.quick-input-widget')?.textContent.includes('QQ 未读消息')`);
    assert.equal(await ui.evaluate(`document.querySelector('.quick-input-list')?.textContent.includes('不计数免打扰') || document.querySelector('.quick-input-list')?.textContent.includes('手动不提醒')`), false);
    await vscode.commands.executeCommand('workbench.action.closeQuickOpen'); await unreadChats;
    const text = await ui.evaluate(statusText);
    assert.ok(!text.includes('status-secret-body') && !text.includes('张三') && !text.includes('已连接'));
    store.markRead('group:20002'); await count(1);
    checks.push('普通代码中全局汇总未读数量，免打扰和手动不提醒不计入，已读实时扣减，不显示发送人及正文');
    await vscode.commands.executeCommand('notifications.clearAll');
    await app.settings.handle({ action: 'save', page: 'config', notifications: 'off' });
    await (app as any).notifyMessage(store, message);
    assert.equal(await ui.evaluate(`!!document.querySelector('.notifications-toasts')?.textContent.includes('status-secret-body')`), false);
    await count(1);
    await app.settings.handle({ action: 'save', page: 'config', notifications: 'all' });
    const toast = (app as any).notifyMessage(store, message);
    await ui.waitFor(`document.querySelector('.notifications-toasts')?.textContent.includes('status-secret-body')`);
    await vscode.commands.executeCommand('notifications.clearAll'); await toast;
    checks.push('配置页关闭弹窗后仍保留未读计数，重新启用后实际新消息通知正常出现');
    await app.openChat('group:20002');
    await config.update('statusBarButtons', ['emojis'], vscode.ConfigurationTarget.Global);
    await ui.waitFor(`${buttonVisible('emojis')} && !(${buttonVisible('settings')})`);
    await config.update('statusBarButtons', ['file', 'forward', 'chats', 'search', 'settings', 'refresh'], vscode.ConfigurationTarget.Global);
    await ui.waitFor(`${buttonVisible('file')} && ${buttonVisible('forward')} && !(${buttonVisible('emojis')}) && !(${buttonVisible('chats')}) && !(${buttonVisible('search')}) && !(${buttonVisible('settings')}) && !(${buttonVisible('refresh')})`);
    await config.update('statusBarButtons', [], vscode.ConfigurationTarget.Global);
    await ui.waitFor(`!(${buttonVisible('settings')}) && !(${buttonVisible('chats')})`);
    await config.update('statusBarButtons', ['emojis'], vscode.ConfigurationTarget.Global);
    await app.openChat('group:20002');
    const previousDraft = store.draft('group:20002').text, sent = backend.sent.length;
    await clickDraftAction(ui, '表情');
    const panel = await ui.webview('#basicFaces');
    await until(async () => await panel.evaluate(`document.querySelectorAll('#basicFaces button').length > 0`));
    await panel.evaluate(`document.getElementById('tabBasic').click();document.querySelector('#basicFaces button').click()`);
    await until(() => !(app.emojis as any).view?.visible);
    assert.ok(store.draft('group:20002').text.startsWith(previousDraft));
    assert.ok(store.draft('group:20002').attachments.some(a => a.kind === 'face'));
    assert.equal(backend.sent.length, sent);
    checks.push('草稿入口实时增删并支持全部关闭，底栏置底实际可用；表情链接真实点击后只插入一次草稿并收起，不自动发送');
  } finally {
    await config.update('notifications', originalNotifications, vscode.ConfigurationTarget.Global);
    await config.update('statusBarButtons', originalButtons, vscode.ConfigurationTarget.Global);
  }
}
