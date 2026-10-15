import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileTransferNotice } from '../src/fileNotices';
import { newChat, messageText } from '../src/model';
import { codeLanguages, codeStyle } from '../src/codeStyle';
import { renderTranscript } from '../src/transcriptRenderer';
import { ChatStore } from '../src/store';

const event = { post_type: 'notice', self_id: 123, peer_id: 456, time: 1700000000, notice_type: 'online_file_send', sub_type: 'receive' };

test('文件回执使用 NapCat 的会话与结果，不猜测具体文件', () => {
  for (const [notice_type, sub_type, text] of [
    ['online_file_send', 'receive', '对方已接收文件'],
    ['online_file_send', 'refuse', '对方拒绝接收文件'],
    ['online_file_receive', 'cancel', '对方取消了文件传输（或转为离线发送）']
  ]) {
    const notice = fileTransferNotice({ ...event, notice_type, sub_type }, '123')!;
    assert.equal(notice.chatKey, 'private:456');
    assert.equal(notice.time, event.time);
    assert.equal(messageText(notice), text);
    assert.equal(notice.systemNotice, text);
    assert.equal(notice.fileIds, undefined);
    assert.notEqual(notice.id, fileTransferNotice(event, '123')!.id);
    for (const language of codeLanguages) {
      const view = renderTranscript(newChat('private', 456, '好友'), [notice], '123', language);
      const line = view.text.split('\n')[view.starts.get(notice.id)!];
      assert.ok(line.startsWith(codeStyle(language).comment));
      assert.ok(line.includes(`文件传输：${text}`));
      assert.equal(view.actions.length, 0);
      assert.equal(view.mentions.length, 0);
      assert.equal(view.ownLines.length, 0);
    }
  }
  for (const bad of [null, { ...event, self_id: 999 }, { ...event, peer_id: 0 }, { ...event, peer_id: undefined },
    { ...event, peer_id: '../456' }, { ...event, post_type: 'message' }, { ...event, sub_type: 'cancel' },
    { ...event, sub_type: 'toString' }, { ...event, notice_type: 'unknown' }]) {
    assert.equal(fileTransferNotice(bad, '123'), undefined);
  }
});

test('文件回执缓存恢复后仍可显示，不增加普通消息未读', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-file-notice-'));
  const store = new ChatStore(folder, '123');
  const restored = new ChatStore(folder, '123');
  try {
    const notice = fileTransferNotice(event, '123')!;
    store.upsert(newChat('private', 456, '好友'));
    store.add(notice, false);
    assert.equal(store.chats.get(notice.chatKey)!.unread, 0);
    await store.flush(); await restored.restore(); await restored.load(notice.chatKey);
    const messages = restored.displayMessages(notice.chatKey);
    assert.equal(messages[0].systemNotice, notice.systemNotice);
    assert.ok(renderTranscript(restored.chats.get(notice.chatKey)!, messages, '123').text.includes('对方已接收文件'));
  } finally {
    await store.dispose(); await restored.dispose(); await fs.rm(folder, { recursive: true, force: true });
  }
});
