import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import type { QQApp } from '../src/extension';
import { until } from './fixture';
import { TestUI } from './ui';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export async function testListSearch(app: QQApp, ui: TestUI, checks: string[]): Promise<void> {
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
