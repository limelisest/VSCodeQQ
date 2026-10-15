import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import type { QQApp } from '../src/extension';
import { until } from './fixture';
import { TestUI } from './ui';

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
  await list.evaluate(`(() => {const r=document.getElementById('results');r.style.flex='none';r.style.height='48px';r.scrollTop=0;})()`);
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
