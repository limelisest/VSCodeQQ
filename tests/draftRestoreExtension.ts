import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import type { QQApp } from '../src/extension';
import { ChatStore } from '../src/store';
import { DRAFT_DIVIDER } from '../src/nativeEditor';
import { newChat, parseMessage } from '../src/model';
import { MockNapCat, until } from './fixture';

export async function testDraftRestore(app: QQApp, backend: MockNapCat, checks: string[]): Promise<void> {
  const key = 'group:29000', store = app.store!;
  store.upsert(newChat('group', 29000, '恢复草稿测试'));
  await app.openChat(key);
  const editor = vscode.window.activeTextEditor!;
  try {
    store.setDraft(key, '昨天提交的失败消息'); await app.native.sync(editor);
    const beforeSubmit = editor.document.getText();
    backend.failSend = true;
    assert.equal(await app.sendMessage(key, app.native.draft(editor.document)), false);
    backend.failSend = false;
    await app.native.sync(editor);
    const failed = store.messages.get(key)!.find(m => m.sendState === 'failed')!;
    assert.ok(failed?.outgoing); assert.equal(store.draft(key).text, '');
    const failedSnapshot = editor.document.getText();
    await store.flush();
    const restored = new ChatStore(store.folder, store.selfId);
    await restored.restore(); await restored.load(key);
    assert.equal(restored.draft(key).text, '', '失败消息不会由聊天缓存自动恢复成草稿');
    assert.ok(restored.outbox.has(failed.id)); await restored.dispose();
    store.add(parseMessage({ message_id: 982000, user_id: 10001, time: failed.time + 86400, message: '第二天的新消息' }, key), false);
    const sentBeforeRestore = backend.sent.length;
    const restorePage = async (snapshot: string) => {
      await app.native.sync(editor);
      await until(() => !app.native.isUpdating(editor.document));
      // New extension session reads the canonical file; VS Code then reapplies its old hot-exit snapshot.
      app.editor.reset(); app.native.readFile(editor.document.uri);
      assert.equal(await editor.edit(edit => edit.replace(new vscode.Range(0, 0, editor.document.lineCount, 0), snapshot)), true);
      await until(() => !app.native.isUpdating(editor.document));
    };
    for (const suffix of [' [发送]', '']) {
      await restorePage(failedSnapshot.replace(DRAFT_DIVIDER, '// ─── 草稿 · Enter 发送 · Shift/Ctrl+Enter 换行 ───' + suffix));
      assert.equal(store.draft(key).text, '', '旧分割线恢复时不能把历史并入草稿');
      assert.ok(app.native.historyMatches(editor.document));
    }
    await restorePage(failedSnapshot);
    assert.equal(store.draft(key).text, '', '旧页面中的失败记录不能被并入第二天草稿');
    assert.equal(app.native.draft(editor.document), '');
    assert.ok(app.native.historyMatches(editor.document));
    checks.push('重启恢复旧页面时失败记录只留在历史中，不会混入第二天草稿');
    await restorePage(beforeSubmit);
    assert.equal(store.draft(key).text, '', '提交前的旧编辑器备份不能复活已经提交的消息');
    checks.push('旧编辑器备份中的待发送文字不会覆盖已清空的草稿');
    const sameHistory = editor.document.getText();
    await restorePage(sameHistory + '昨天提交的失败消息');
    assert.equal(store.draft(key).text, '', '历史相同时的整页恢复也不能覆盖已保存的草稿');
    store.setDraft(key, '今天真正未发送的新草稿'); await app.native.sync(editor);
    await restorePage(failedSnapshot);
    assert.ok(store.draft(key).text === '今天真正未发送的新草稿', '旧页面恢复必须保留已保存的新草稿');
    assert.equal(app.native.draft(editor.document), '今天真正未发送的新草稿');
    await editor.edit(edit => edit.insert(editor.document.positionAt(editor.document.getText().length), '，继续输入'));
    assert.equal(store.draft(key).text, '今天真正未发送的新草稿，继续输入');
    assert.equal(backend.sent.length, sentBeforeRestore, '恢复文档不会自动发送');
    assert.equal(store.messages.get(key)!.find(m => m.id === failed.id)!.sendState, 'failed');
    checks.push('恢复旧页面保留当前真实草稿与失败记录，随后正常编辑且不自动发送');
    const region = app.native.region(editor.document)!;
    await editor.edit(edit => edit.delete(new vscode.Range(editor.document.positionAt(region.boundary - 1), editor.document.positionAt(region.start + 2))));
    await until(() => !app.native.isUpdating(editor.document));
    assert.equal(store.draft(key).text, '真正未发送的新草稿，继续输入');
    assert.ok(app.native.historyMatches(editor.document));
    await editor.edit(edit => edit.delete(new vscode.Range(0, 0, editor.document.lineCount, 0)));
    await until(() => !app.native.isUpdating(editor.document));
    assert.equal(store.draft(key).text, ''); assert.ok(app.native.historyMatches(editor.document));
    checks.push('修复恢复流程后，跨分隔线删除和全选删除仍只清理草稿并保留历史');
  } finally {
    backend.failSend = false;
    if (!editor.document.isClosed) {
      await editor.document.save();
      const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === editor.document.uri.toString());
      await vscode.window.tabGroups.close(tabs);
    }
    store.chats.delete(key); store.messages.delete(key); store.drafts.delete(key);
    for (const [id, message] of store.outbox) if (message.chatKey === key) store.outbox.delete(id);
    app.trees.forEach(tree => tree.refresh());
    await app.openChat('group:20002');
  }
}
