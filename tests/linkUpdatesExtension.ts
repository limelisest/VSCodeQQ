import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import type { QQApp } from '../src/extension';
import { codeLanguages } from '../src/codeStyle';
import { newChat, parseMessage } from '../src/model';
import { MockNapCat, until } from './fixture';
import { TestUI } from './ui';

export async function testLinkUpdates(app: QQApp, backend: MockNapCat, ui: TestUI, checks: string[]): Promise<void> {
  const key = 'group:29001', store = app.store!;
  store.upsert(newChat('group', 29001, '链接更新测试')); await app.openChat(key); await app.loadHistory(key); await app.loadMembers(key);
  const editor = vscode.window.activeTextEditor!, doc = editor.document, transcript = app.transcript!;
  const source = parseMessage({ message_id: 983100, user_id: 10001, time: Math.floor(Date.now() / 1000) + 100, message: [
    { type: 'text', data: { text: '已有资源' } }, { type: 'image', data: { file: 'stable-image', url: backend.imageUrl } },
    { type: 'at', data: { qq: '10001' } }, { type: 'video', data: { file: '示例.mp4', url: backend.imageUrl + '?video' } },
    { type: 'file', data: { file_id: 'stable-file', name: '报告.txt' } }
  ] }, key);
  try {
    store.add(source, false); await app.native.sync(editor); await until(() => !app.native.isUpdating(doc));
    const original = transcript.rendered.get(key)!, links = transcript.provideDocumentLinks(doc);
    const image = links.find(link => link.target?.path === 'qq.openImage' && link.target.query.includes('983100'))!;
    assert.ok(image); assert.strictEqual(transcript.provideDocumentLinks(doc), links);
    const imageType = (app.editor as any).imageDecoration.key;
    let imageWrites = 0;
    const probe = { document: doc, setDecorations: (type: vscode.TextEditorDecorationType) => { if (type.key === imageType) imageWrites++; } } as unknown as vscode.TextEditor;
    app.editor.decorate(probe); app.editor.decorate(probe); assert.equal(imageWrites, 1);
    let started = false, release!: () => void;
    const held = { document: doc, edit: async (callback: any, options: any) => {
      started = true; await new Promise<void>(resolve => release = resolve); return editor.edit(callback, options);
    } } as unknown as vscode.TextEditor;
    store.add(parseMessage({ message_id: 983101, user_id: 10001, time: source.time + 1, message: '新增普通消息' }, key), false);
    const updating = app.native.sync(held);
    await until(() => started);
    try {
      assert.ok(app.native.historyMatches(doc), '等待正文写入期间保留旧投影');
      assert.strictEqual(transcript.rendered.get(key), original);
      const registered = await vscode.commands.executeCommand<vscode.DocumentLink[]>('vscode.executeLinkProvider', doc.uri);
      assert.ok(registered.some(link => link.target?.path === 'qq.openImage' && doc.getText(link.range) === '[图片]'));
      app.editor.decorate(probe); assert.equal(imageWrites, 1, '等待渲染不能临时清空图片链接高亮');
      await editor.edit(edit => edit.insert(doc.positionAt(doc.getText().length), '渲染期间输入'));
      assert.equal(store.draft(key).text, '渲染期间输入');
    } finally { release(); await updating; }
    await until(() => !app.native.isUpdating(doc));
    assert.equal(store.draft(key).text, '渲染期间输入');
    assert.equal(app.native.draft(doc), '渲染期间输入');
    const after = transcript.provideDocumentLinks(doc);
    assert.strictEqual(after.find(link => link.target?.toString() === image.target?.toString()), image);
    assert.equal(after.length, links.length); assert.ok(doc.getText().includes('新增普通消息'));
    app.editor.decorate(probe); assert.equal(imageWrites, 1, '追加普通消息不重画未变化的资源高亮');
    checks.push('消息渲染等待期间原生链接持续有效，正文与链接坐标同时生效');
    await editor.edit(edit => edit.insert(doc.positionAt(doc.getText().length), '编辑草稿'));
    await until(() => !app.native.isUpdating(doc));
    assert.strictEqual(transcript.provideDocumentLinks(doc), after);
    app.editor.decorate(probe); assert.equal(imageWrites, 1);
    checks.push('重复刷新、普通消息追加和草稿编辑复用旧链接，未变化的资源高亮只提交一次');
    const first = store.messages.get(key)![0];
    assert.notEqual(first.id, source.id);
    store.messages.set(key, store.messages.get(key)!.filter(message => message.id !== first.id)); store.history(key, []);
    store.add(parseMessage({ message_id: 983103, user_id: 10001, time: source.time + 3, message: '裁剪同时追加' }, key), false);
    const unchanged = doc.offsetAt(new vscode.Position(original.actions.find(a => a.messageId === source.id)!.line, 0));
    const replacements: { start: number; end: number }[] = [];
    const watching = vscode.workspace.onDidChangeTextDocument(event => {
      if (event.document === doc) for (const change of event.contentChanges) replacements.push({ start: change.rangeOffset, end: change.rangeOffset + change.rangeLength });
    });
    try { await app.native.sync(editor); await until(() => !app.native.isUpdating(doc)); }
    finally { watching.dispose(); }
    assert.ok(replacements.length >= 2, '裁剪和追加应拆成局部写入');
    assert.ok(!replacements.some(change => change.start <= unchanged && change.end > unchanged), '中间图片消息不重新写入');
    const shifted = transcript.provideDocumentLinks(doc).find(link => link.target?.toString() === image.target?.toString())!;
    assert.ok(shifted); assert.notStrictEqual(shifted, image); assert.equal(doc.getText(shifted.range), '[图片]');
    app.editor.decorate(probe); assert.equal(imageWrites, 2);
    const beforeFailure = transcript.rendered.get(key), failureLinks = transcript.provideDocumentLinks(doc);
    store.add(parseMessage({ message_id: 983102, user_id: 10001, time: source.time + 2, message: '写入失败测试' }, key), false);
    const failing = { document: doc, edit: async () => { throw new Error('模拟写入失败'); } } as unknown as vscode.TextEditor;
    await assert.rejects(app.native.sync(failing), /模拟写入失败/);
    assert.strictEqual(transcript.rendered.get(key), beforeFailure);
    assert.strictEqual(transcript.provideDocumentLinks(doc), failureLinks); assert.ok(app.native.historyMatches(doc));
    checks.push('历史裁剪后资源链接正确迁移，写入失败时继续使用原链接与高亮');
    await app.native.sync(editor); await until(() => !app.native.isUpdating(doc));
    const content = transcript.rendered.get(key)!;
    const msg = content.actions.find(a => a.messageId === source.id && a.kind === 'reply')!;
    const name = content.mentions.find(a => a.kind === 'sender' && a.line > content.starts.get(source.id)! && a.line < msg.line)!;
    const position = (s: { line: number; start: number }) => new vscode.Position(s.line, s.start);
    assert.equal(doc.getText(new vscode.Range(msg.line, msg.start, msg.line, msg.end)), 'msg');
    assert.equal(doc.getText(new vscode.Range(name.line, name.start, name.line, name.end)), 'name');
    const registered = await vscode.commands.executeCommand<vscode.DocumentLink[]>('vscode.executeLinkProvider', doc.uri);
    assert.ok(!registered.some(l => l.target?.path === 'qq.reply' || l.range.contains(position(name))));
    const body = new vscode.Position(msg.line, doc.lineAt(msg.line).text.indexOf('已有资源'));
    const value = new vscode.Position(name.line, doc.lineAt(name.line).text.indexOf('=') + 3);
    assert.equal(transcript.clickCommand(doc, body), undefined);
    assert.equal(transcript.clickCommand(doc, value), undefined);
    assert.equal(transcript.clickCommand(doc, position(msg))?.path, 'qq.reply');
    assert.equal(transcript.clickCommand(doc, position(name))?.path, 'qq.insertMention');
    const token = new vscode.CancellationTokenSource();
    try {
      assert.ok(await transcript.provideHover(doc, position(msg), token.token));
      assert.ok(await transcript.provideHover(doc, position(name), token.token));
      assert.equal(await transcript.provideHover(doc, body, token.token), undefined);
    } finally { token.dispose(); }
    const sent = backend.sent.length;
    store.setDraft(key, '保留草稿'); await app.native.sync(editor);
    const reveal = async (line: number) => {
      editor.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.AtTop);
      await new Promise(r => setTimeout(r, 300));
    };
    await reveal(msg.line);
    await until(async () => await ui.evaluate(`(() => {
      const line = [...document.querySelectorAll('.editor-group-container.active .view-line')].find(line => line.textContent.includes('已有资源'));
      return [...line?.querySelectorAll('span') ?? []].some(span => span.textContent === 'msg' && getComputedStyle(span).textDecorationLine.includes('underline'));
    })()`));
    await ui.clickText('已有资源');
    await new Promise(r => setTimeout(r, 350)); assert.equal(store.draft(key).replyId, undefined);
    await ui.clickText('msg[] = "已有资源');
    await until(() => store.draft(key).replyId === source.id && !app.native.isUpdating(doc));
    assert.ok(store.draft(key).text.includes('保留草稿'));
    await reveal(name.line); await ui.clickText('name[]');
    await until(() => Object.keys(store.draft(key).mentions ?? {}).length === 1 && !app.native.isUpdating(doc));
    assert.equal(Object.values(store.draft(key).mentions ?? {})[0], source.senderId);
    assert.equal(store.draft(key).replyId, source.id); assert.equal(backend.sent.length, sent);
    checks.push('真实鼠标单击 msg 回复、name 提及，正文单击不触发，变量直接绘制下横线且悬浮提示可用');
    const url = 'https://example.com/watch?v=1&x=2', second = 'https://example.com/second?q=test%20value';
    const urlMessage = parseMessage({ message_id: 983110, user_id: 10001, time: source.time + 10,
      message: [{ type: 'text', data: { text: `${url}\n${second}\n下一行` } }] }, key);
    store.add(urlMessage, false);
    store.add(parseMessage({ message_id: 983111, user_id: 10001, time: source.time + 11,
      message: [{ type: 'reply', data: { id: urlMessage.id } }, { type: 'text', data: { text: '引用网址' } }] }, key), false);
    const originalLanguage = app.config.codeLanguage;
    try {
      for (const language of codeLanguages) {
        await vscode.workspace.getConfiguration('qq').update('codeLanguage', language, vscode.ConfigurationTarget.Global);
        await app.native.sync(editor); await until(() => !app.native.isUpdating(doc));
        const urls = (await vscode.commands.executeCommand<vscode.DocumentLink[]>('vscode.executeLinkProvider', doc.uri)).filter(link => link.target?.scheme === 'https');
        for (const target of [url, second]) {
          const expected = vscode.Uri.parse(target).toString();
          const matching = urls.filter(link => link.target?.toString().startsWith(expected));
          assert.equal(matching.length, 2, `${language}: 正文与回复各识别一次 ${target}`);
          for (const link of matching) {
            assert.equal(link.target!.toString(), expected, `${language}: 网址目标不能带换行转义`);
            assert.equal(doc.getText(link.range), target, `${language}: 点击范围不能包含换行转义`);
          }
        }
      }
    } finally {
      await vscode.workspace.getConfiguration('qq').update('codeLanguage', originalLanguage, vscode.ConfigurationTarget.Global);
      await app.native.sync(editor);
    }
    checks.push('八种代码风格中的正文与回复网址保留正确目标和点击范围，换行不追加到网址');

  } finally {
    await app.native.sync(editor);
    if (!doc.isClosed) {
      await doc.save();
      const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === doc.uri.toString());
      await vscode.window.tabGroups.close(tabs);
    }
    store.chats.delete(key); store.messages.delete(key); store.drafts.delete(key);
    for (const [id, message] of store.outbox) if (message.chatKey === key) store.outbox.delete(id);
    app.trees.forEach(tree => tree.refresh()); await app.openChat('group:20002');
  }
}
