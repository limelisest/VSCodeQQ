import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import type { QQApp } from '../src/extension';
import { newChat } from '../src/model';
import { MockNapCat, until } from './fixture';
import { TestUI } from './ui';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

async function closeChatTabs(app: QQApp, keys: string[]): Promise<void> {
  const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input instanceof vscode.TabInputText && keys.includes(app.transcript?.key(tab.input.uri) ?? ''));
  const documents = vscode.workspace.textDocuments.filter(doc => keys.includes(app.transcript?.key(doc.uri) ?? ''));
  await until(() => documents.every(doc => !app.native.isUpdating(doc)));
  for (const doc of documents) if (doc.isDirty) assert.equal(await doc.save(), true);
  if (tabs.length) await vscode.window.tabGroups.close(tabs, true);
}

export async function testListSearch(app: QQApp, ui: TestUI, checks: string[]): Promise<void> {
  await Promise.all(['private:10001', 'group:20001', 'group:20002'].map(key => app.loadHistory(key)));
  await vscode.commands.executeCommand('qq.show.list');
  await vscode.commands.executeCommand('qq.search.list');
  const list = await ui.webview('body[data-section="list"] #search');
  const search = async (query: string) => {
    await vscode.commands.executeCommand('qq.search.list');
    await list.evaluate(`(() => {const input=document.getElementById('search');input.value=${JSON.stringify(query)};input.dispatchEvent(new Event('input',{bubbles:true}));input.focus();})()`);
    await until(() => app.trees[0].filter === query);
    await until(async () => await list.evaluate(`document.querySelectorAll('.row').length === 1`));
  };
  const cleared = async (key: string, count: number) => {
    await until(() => app.target === key && vscode.window.activeTextEditor?.document.uri.path.includes('/' + key.replace(':', '/') + '/') === true);
    await until(() => app.trees[0].filter === '');
    await until(async () => await list.evaluate(`document.getElementById('search').value === '' && document.getElementById('count').textContent === '' && document.querySelectorAll('.row').length === ${count} && document.getElementById('collapsed').getAttribute('aria-pressed') === 'false'`));
  };
  await app.openChat('private:10001');
  await search('20001');
  await list.evaluate(`document.querySelector('[data-key="group:20001"] .name').click()`);
  await cleared('group:20001', 3);
  checks.push('鼠标选择搜索结果后清空搜索、结果计数及持久化筛选，恢复完整列表');

  await search('20002');
  await list.key('Enter', 13);
  await cleared('group:20002', 3);
  await search('20001');
  await list.key('ArrowDown', 40); await list.key('Enter', 13);
  await cleared('group:20001', 3);
  checks.push('搜索框 Enter 和方向键选择后 Enter 使用相同的清空搜索流程');

  const favorite = app.store!.favorites.has('group:20002');
  const collapsed = app.store!.collapsed.has('group:20002');
  try {
    await search('20002');
    await list.evaluate(`document.querySelector('[data-key="group:20002"] [data-action="favorite"]').click()`);
    await until(() => app.store!.favorites.has('group:20002') !== favorite);
    assert.equal(app.trees[0].filter, '20002');
    assert.equal(await list.evaluate(`document.getElementById('search').value`), '20002');
    if (!app.store!.collapsed.has('group:20002')) app.store!.toggleCollapsed('group:20002');
    await list.evaluate(`document.getElementById('clear').click()`);
    await until(() => app.trees[0].filter === '');
    await list.evaluate(`document.getElementById('collapsed').click()`);
    await until(async () => await list.evaluate(`document.getElementById('collapsed').getAttribute('aria-pressed') === 'true'`));
    await search('20002');
    await list.evaluate(`document.querySelector('[data-key="group:20002"] .name').click()`);
    await cleared('group:20002', 2);
    assert.equal(app.store!.collapsed.has('group:20002'), true);
    checks.push('收纳箱搜索选择后回主列表且保留收纳状态，收藏操作不清空搜索');
  } finally {
    if (app.store!.favorites.has('group:20002') !== favorite) app.store!.toggleFavorite('group:20002');
    if (app.store!.collapsed.has('group:20002') !== collapsed) app.store!.toggleCollapsed('group:20002');
    app.filterList('list', '');
  }
}


export async function testListActive(app: QQApp, ui: TestUI, checks: string[]): Promise<void> {
  await vscode.commands.executeCommand('qq.show.list');
  const list = await ui.webview('body[data-section="list"] #search');
  const editorA = await app.openChat('group:20001').then(() => vscode.window.activeTextEditor!);
  const editorB = await app.openChat('private:10001').then(() => vscode.window.activeTextEditor!);
  const active = async (key: string) => {
    await until(async () => await list.evaluate(`document.querySelector('.row.active')?.dataset.key === ${JSON.stringify(key)} && document.querySelectorAll('[aria-current="true"]').length === 1`));
  };
  await active('private:10001');
  // Simulate switching existing editor tabs, bypassing qq.openChat and list clicks.
  await vscode.window.showTextDocument(editorA.document, { preview: false });
  await active('group:20001');
  await list.evaluate(`(() => {const r=document.getElementById('results'),style=getComputedStyle(r);r.style.flex='none';r.style.height=(Math.ceil(r.firstElementChild.getBoundingClientRect().height)+parseFloat(style.paddingTop)+parseFloat(style.paddingBottom)+2)+'px';r.scrollTop=0;})()`);
  const lastKey = await list.evaluate(`document.querySelector('.row:last-child').dataset.key`);
  await app.openChat(lastKey === 'private:10001' ? 'group:20001' : 'private:10001');
  await app.openChat(lastKey);
  await active(lastKey);
  await until(async () => await list.evaluate(`(() => {const r=document.getElementById('results').getBoundingClientRect(),a=document.querySelector('.row.active').getBoundingClientRect();return a.top>=r.top-1&&a.bottom<=r.bottom+1;})()`));
  checks.push('切换已有聊天标签同步当前会话高亮，自动滚动到可见位置');
  await list.evaluate(`document.getElementById('results').style.cssText=''`);

  const ordinary = await vscode.workspace.openTextDocument({ content: '普通编辑器页面' });
  await vscode.window.showTextDocument(ordinary, { preview: false });
  await until(async () => await list.evaluate(`!document.querySelector('.row.active') && !document.querySelector('[aria-current="true"]')`));
  await vscode.window.showTextDocument(editorB.document, { preview: false }); await active('private:10001');
  await vscode.commands.executeCommand('qq.search.list');
  await list.evaluate(`document.getElementById('search').focus()`);
  await active('private:10001');
  assert.equal(await list.evaluate(`document.activeElement.id`), 'search', '同步当前会话不应抢走搜索框焦点');
  await list.evaluate(`(() => {const i=document.getElementById('search');i.value='20001';i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await until(() => app.trees[0].filter === '20001');
  await vscode.window.showTextDocument(editorB.document, { preview: false });
  assert.equal(app.trees[0].filter, '20001');
  app.filterList('list', '');
  checks.push('普通页面清除当前会话高亮，列表焦点和主动搜索不被会话同步覆盖');
}

export async function testListAvatars(app: QQApp, ui: TestUI, checks: string[]): Promise<void> {
  const config = vscode.workspace.getConfiguration('qq'), previous = config.get('showAvatars');
  const themes = vscode.workspace.getConfiguration('workbench'), previousTheme = themes.get('colorTheme');
  const store = app.store!, key = 'group:20001', original = { ...store.chats.get(key)! };
  await vscode.commands.executeCommand('qq.show.list');
  const list = await ui.webview('body[data-section="list"] #search');
  const output = path.join(__dirname, '..', '..', '.test-output');
  const capture = async (name: string) => {
    const shot = await ui.call('Page.captureScreenshot', { format: 'png' });
    await fs.writeFile(path.join(output, name), Buffer.from(shot.data, 'base64'));
  };
  try {
    assert.equal(config.get('showAvatars'), true, '新安装默认显示头像');
    await until(async () => await list.evaluate(`document.querySelectorAll('.avatar img').length === 3`));
    const sources = await list.evaluate(`[...document.querySelectorAll('.row')].map(row=>({key:row.dataset.key,src:row.querySelector('img').src,loading:row.querySelector('img').loading,referrer:row.querySelector('img').referrerPolicy}))`);
    assert.equal(sources.find((row: any) => row.key === 'private:10001').src, 'https://q1.qlogo.cn/g?b=qq&nk=10001&s=100');
    assert.equal(sources.find((row: any) => row.key === key).src, 'https://p.qlogo.cn/gh/20001/20001/100');
    assert.ok(sources.every((row: any) => row.loading === 'lazy' && row.referrer === 'no-referrer'));
    await app.openChat('private:10001');
    await list.evaluate(`window.testAvatar = document.querySelector('[data-key="${key}"] img')`);
    Object.assign(store.chats.get(key)!, { unread: 12, mentioned: true, notification: 'notify', lastTime: Math.floor(Date.now()/1000), name: '界面设计讨论组 · 较长的会话名称', preview: '新的界面稿已经更新，稍后一起确认' });
    app.trees[0].refresh();
    await until(async () => await list.evaluate(`document.querySelector('[data-key="${key}"] .count')?.textContent === '@ 12'`));
    assert.equal(await list.evaluate(`document.querySelector('[data-key="${key}"] img') === window.testAvatar`), true, '未读刷新保留同一个头像，不重建图片请求');
    await until(async () => await list.evaluate(`[...document.querySelectorAll('.avatar img')].some(img=>img.complete && img.naturalWidth>0)`), 15000);
    await fs.mkdir(output, { recursive: true });
    await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
    for (const [theme, kind, file] of [['Default Dark Modern', 'vscode-dark', 'chat-list-avatars-dark.png'], ['Default Light Modern', 'vscode-light', 'chat-list-avatars-light.png'], ['Default High Contrast', 'vscode-high-contrast', 'chat-list-avatars-contrast.png']]) {
      await themes.update('colorTheme', theme, vscode.ConfigurationTarget.Global);
      await until(async () => await list.evaluate(`document.body.classList.contains('${kind}')`));
      await capture(file);
    }
    await themes.update('colorTheme', 'Default Dark Modern', vscode.ConfigurationTarget.Global);
    await list.evaluate(`document.body.style.width='220px';document.querySelector('[data-key="${key}"]').focus()`);
    await list.hover(`[data-key="${key}"]`);
    const layout = await list.evaluate(`(() => {const row=document.querySelector('[data-key="${key}"]'), badge=row.querySelector('.count').getBoundingClientRect(), actions=row.querySelector('.row-actions').getBoundingClientRect(), bounds=row.getBoundingClientRect();return {overflow:document.documentElement.scrollWidth>innerWidth, badgeVisible:badge.width>0, actionsVisible:actions.width>0, overlap:badge.left<actions.right&&badge.right>actions.left&&badge.top<actions.bottom&&badge.bottom>actions.top, fits:actions.right<=bounds.right+1};})()`);
    assert.equal(layout.overflow, false); assert.equal(layout.badgeVisible, true); assert.equal(layout.actionsVisible, true);
    assert.equal(layout.overlap, false, '窄列表中操作按钮不得遮住未读数字'); assert.equal(layout.fits, true);
    await capture('chat-list-avatars-narrow.png');
    await list.evaluate(`document.body.style.width='';document.querySelector('[data-key="${key}"] img').dispatchEvent(new Event('error'))`);
    assert.equal(await list.evaluate(`document.querySelector('[data-key="${key}"] img').hidden`), true, '图片加载失败时回到类型图标');
    await list.evaluate(`document.querySelector('[data-key="${key}"] .avatar').click()`);
    await until(() => app.target === key);
    checks.push('默认显示好友与群头像，图片按需加载；未读刷新复用头像，加载失败保留可点击的类型图标');
    await list.evaluate(`const input=document.getElementById('search');input.value='20001';input.dispatchEvent(new Event('input',{bubbles:true}));input.focus()`);
    await until(() => app.trees[0].filter === '20001');
    await config.update('showAvatars', false, vscode.ConfigurationTarget.Global);
    await until(async () => await list.evaluate(`!document.body.classList.contains('show-avatars') && !document.querySelector('.avatar img')`));
    assert.equal(await list.evaluate(`document.getElementById('search').value`), '20001');
    assert.equal(await list.evaluate(`document.querySelector('.row.active')?.dataset.key`), key);
    assert.equal(await list.evaluate(`document.querySelector('.avatar').getBoundingClientRect().width`), 16);
    await list.evaluate(`document.getElementById('clear').click()`);
    await capture('chat-list-avatars-off.png');
    await config.update('showAvatars', true, vscode.ConfigurationTarget.Global);
    await until(async () => await list.evaluate(`document.querySelectorAll('.avatar img').length === 3`));
    checks.push('头像开关立即生效，关闭时不创建图片并保留搜索和当前会话；明暗、高对比及窄侧栏布局通过');
  } finally {
    await config.update('showAvatars', previous, vscode.ConfigurationTarget.Global);
    await themes.update('colorTheme', previousTheme, vscode.ConfigurationTarget.Global);
    Object.assign(store.chats.get(key)!, original); app.filterList('list', '');
  }
}

export async function testListReferences(app: QQApp, backend: MockNapCat, ui: TestUI, checks: string[]): Promise<void> {
  const store = app.store!, key = 'group:29991', sourceId = 99191, replyId = 99192;
  const config = vscode.workspace.getConfiguration('qq'), notifications = config.get('notifications');
  const clipboard = await vscode.env.clipboard.readText(), sent = backend.sent.length;
  await vscode.commands.executeCommand('qq.show.list');
  const list = await ui.webview('body[data-section="list"] #search');
  const clock = Math.floor(Date.now()/1000) + 600;
  const at = { type: 'at', data: { qq: '10001' } };
  try {
    await config.update('notifications', 'off', vscode.ConfigurationTarget.Global);
    backend.masks.set('29991', 1);
    backend.masks.set('29992', 1);
    backend.emit({ ...backend.message(99190), group_id: 29992, time: clock, message: [{ type: 'at', data: { qq: 'all' } }] });
    await until(async () => await list.evaluate(`document.querySelector('[data-key="group:29992"] .preview')?.textContent.endsWith('@全体成员')`));
    assert.equal(backend.calls.some(call => call.action === 'get_group_member_list' && String(call.params.group_id) === '29992'), false, '@全体成员已有明确名称，无须获取整群资料');

    backend.emit({ ...backend.message(sourceId), group_id: 29991, time: clock, message: [at, { type: 'text', data: { text: ' 保留文字 @10001' } }] });
    const preview = (text: string) => `document.querySelector('[data-key="${key}"] .preview')?.textContent.endsWith(${JSON.stringify(text)})`;
    await until(async () => await list.evaluate(preview('@群名片 保留文字 @10001')));
    assert.ok(backend.calls.some(call => call.action === 'get_group_member_list' && String(call.params.group_id) === '29991'), '未打开的群聊也按需获取提及名称');
    store.setMembers(key, [{ user_id: 10001, card: '更新名片' }]);
    await until(async () => await list.evaluate(preview('@更新名片 保留文字 @10001')));
    assert.ok((await list.evaluate(`document.querySelector('[data-key="${key}"]').title`)).includes('@更新名片'));
    backend.emit({ ...backend.message(replyId), group_id: 29991, time: clock + 1, message: [{ type: 'reply', data: { id: String(sourceId) } }, at, { type: 'text', data: { text: ' 回复正文' } }] });
    await until(async () => await list.evaluate(preview('@更新名片 回复正文')));
    await app.openChat(key);
    const editor = vscode.window.activeTextEditor!;
    await until(() => !app.native.isUpdating(editor.document) && editor.document.getText().split('\n').some(line => line.includes('replay') && line.includes('[@:更新名片]')));
    const rendered = app.transcript!.rendered.get(key)!;
    const action = rendered.actions.find(action => action.messageId === String(replyId) && action.kind === 'reply')!;
    editor.selection = new vscode.Selection(action.line, 0, action.line, 0);
    await vscode.commands.executeCommand('qq.copyMessage');
    assert.equal(await vscode.env.clipboard.readText(), '@更新名片 回复正文');
    const reference = rendered.replyLinks.find(link => link.messageId === String(sourceId))!;
    const command = app.transcript!.clickCommand(editor.document, new vscode.Position(reference.line, reference.start))!;
    assert.equal(command.path, 'qq.openReplyOriginal');
    await vscode.commands.executeCommand(command.path, ...JSON.parse(decodeURIComponent(command.query)));
    assert.equal(app.transcript!.messageAt(editor.document.uri, editor.selection.active.line)?.id, String(sourceId));
    store.setReply(key, String(sourceId), '更新名片');await app.native.sync(editor);
    const region = app.native.region(editor.document)!, hover = await app.native.hover(editor.document, editor.document.positionAt(region.start + 2));
    assert.ok(hover?.contents.some(content => content instanceof vscode.MarkdownString && content.value.includes('@更新名片') && !content.value.includes('[@:')));
    assert.equal(store.messages.get(key)!.find(message => message.id === String(sourceId))!.segments[0].type, 'mention');
    assert.equal(backend.sent.length, sent, '读取、复制与定位引用不会发送消息');
    checks.push('未打开会话按需解析 @ 名称，成员更新刷新列表和提示；普通 @数字原文保持不变');
    checks.push('回复正文与原文名称一致，复制不含内部占位符；引用跳转、草稿悬浮及原始提及绑定正常');
  } finally {
    await config.update('notifications', notifications, vscode.ConfigurationTarget.Global);
    await vscode.env.clipboard.writeText(clipboard);
    await app.openChat('private:10001');
    await closeChatTabs(app, [key, 'group:29992']);
    for (const target of [key, 'group:29992']) { store.drafts.delete(target);store.chats.delete(target);store.messages.delete(target);store.members.delete(target); }
    app.trees[0].refresh();
  }
}

export async function testListEmpty(app: QQApp, backend: MockNapCat, ui: TestUI, checks: string[]): Promise<void> {
  const store = app.store!, config = vscode.workspace.getConfiguration('qq'), previous = config.get('notifications');
  const emptyGroup = 'group:29980', emptyBox = 'group:29981', emptyFriend = 'private:10091', cached = 'private:10090';
  const keys = [emptyGroup, emptyBox, emptyFriend, cached], clock = Math.floor(Date.now()/1000) + 700;
  await vscode.commands.executeCommand('qq.show.list');
  const list = await ui.webview('body[data-section="list"] #search');
  const row = (key: string) => `document.querySelector('[data-key="${key}"]')`;
  const search = async (query: string) => {
    await list.evaluate(`(() => {const input=document.getElementById('search');input.value=${JSON.stringify(query)};input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await until(() => app.trees[0].filter === query);
  };
  try {
    await config.update('notifications', 'off', vscode.ConfigurationTarget.Global);
    await search('');
    const folded = await list.evaluate(`document.getElementById('collapsed').textContent`);
    backend.emptyHistories.add('29980');backend.emptyHistories.add('29981');backend.emptyHistories.add('10091');
    store.upsert(newChat('group', 29980, '空白群聊'));store.toggleFavorite(emptyGroup);
    store.upsert(newChat('group', 29981, '空白收纳'));store.toggleCollapsed(emptyBox);
    store.upsert({ ...newChat('private', 10091, '空白好友'), remark: '空白备注', nickname: '空白昵称' });
    store.upsert({ ...newChat('private', 10090, '本地历史'), lastTime: clock, preview: '尚未加载的历史摘要' });
    await until(async () => await list.evaluate(`!!(${row(cached)}) && !(${row(emptyGroup)}) && !(${row(emptyFriend)}) && !(${row(emptyBox)})`));
    assert.equal(store.messages.has(cached), false, '已知历史未加载时也应保留默认列表');
    assert.equal(await list.evaluate(`document.getElementById('collapsed').textContent`), folded, '空收纳会话不增加默认收纳数量');
    assert.ok(!app.trees[0].getChildren().some(chat => [emptyGroup, emptyFriend, emptyBox].includes(chat.key)));
    for (const [query, key] of [['空白备注', emptyFriend], ['空白昵称', emptyFriend], ['29981', emptyBox], ['空白群聊', emptyGroup]]) {
      await search(query);await until(async () => await list.evaluate(`!!(${row(key)})`));
      assert.ok(app.trees[0].getChildren().some(chat => chat.key === key));
    }
    await list.evaluate(`${row(emptyGroup)}.querySelector('.name').click()`);
    await until(() => app.target === emptyGroup && app.trees[0].filter === '');
    await until(async () => await list.evaluate(`!(${row(emptyGroup)})`));
    assert.equal(store.messages.get(emptyGroup)!.length, 0, '打开空历史不能生成虚假的消息记录');
    store.setDraft(emptyGroup, '尚未发送的草稿');
    assert.equal(store.hasMessages(emptyGroup), false);
    await search('');
    assert.equal(await list.evaluate(`!!(${row(emptyGroup)})`), false, '草稿和收藏不让空会话进入默认列表');
    checks.push('默认隐藏空会话与空收纳会话，保留未加载的已知历史；名称、备注、昵称和号码搜索仍可找到并打开');
    backend.emit({ ...backend.message(99280, '第一条真实消息'), group_id: 29980, time: clock + 1 });
    await until(async () => await list.evaluate(`${row(emptyGroup)}?.querySelector('.preview').textContent.endsWith('第一条真实消息')`));
    assert.equal(store.draft(emptyGroup).text, '尚未发送的草稿');
    backend.emit({ ...backend.message(99281, '收纳中的第一条消息'), group_id: 29981, time: clock + 2 });
    await until(async () => await list.evaluate(`document.getElementById('collapsed').textContent.includes('收纳箱 (1)')`));
    assert.equal(await list.evaluate(`!!(${row(emptyBox)})`), false);
    await list.evaluate(`document.getElementById('collapsed').click()`);
    await until(async () => await list.evaluate(`!!(${row(emptyBox)})`));
    checks.push('收到首条消息后自动进入默认列表并保留草稿；收纳会话出现首条消息后数量和内容同步更新');
  } finally {
    await list.evaluate(`document.getElementById('clear').click();if(document.getElementById('collapsed').getAttribute('aria-pressed')==='true')document.getElementById('collapsed').click()`);
    await app.openChat('private:10001');
    await closeChatTabs(app, keys);
    for (const key of keys) { store.chats.delete(key);store.messages.delete(key);store.members.delete(key);store.drafts.delete(key);store.favorites.delete(key);store.collapsed.delete(key); }
    for (const id of ['29980', '29981', '10091']) backend.emptyHistories.delete(id);
    app.filterList('list', '');
    await config.update('notifications', previous, vscode.ConfigurationTarget.Global);
  }
}
