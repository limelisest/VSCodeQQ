import { randomUUID } from 'node:crypto';
import { Message, id } from './model';

// NapCat supplies a peer and outcome, but no file ID/name for these notices.
// Show a conversation notice rather than guessing which upload it belongs to.
export function fileTransferNotice(event: any, selfId: string): Message | undefined {
  if (event?.post_type !== 'notice' || event.self_id && id(event.self_id) !== selfId) return;
  const text = event.notice_type === 'online_file_send'
    ? event.sub_type === 'receive' ? '对方已接收文件' : event.sub_type === 'refuse' ? '对方拒绝接收文件' : undefined
    : event.notice_type === 'online_file_receive' && event.sub_type === 'cancel' ? '对方取消了文件传输（或转为离线发送）' : undefined;
  const peer = id(event.peer_id);
  if (!text || !/^\d+$/.test(peer) || peer === '0') return;
  return {
    id: `notice:${randomUUID()}`, chatKey: `private:${peer}`, senderId: '', senderName: '系统',
    time: Number.isFinite(Number(event.time)) && Number(event.time) > 0 ? Number(event.time) : Math.floor(Date.now() / 1000),
    segments: [{ type: 'text', text }], mentioned: false, systemNotice: text
  };
}
