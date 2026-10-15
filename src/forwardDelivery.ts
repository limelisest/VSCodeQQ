import { randomUUID } from 'node:crypto';
import { AccountSession } from './accountSession';
import { ChatStore } from './store';
import { OneBotClient, OneBotRequestError } from './onebot';
import { Chat, Message, id, parseMessage } from './model';
import { forwardRequest } from './forwardMessages';
import { ensureForwardSources } from './forwardSources';

interface Host { store?: ChatStore; session: AccountSession; ready: boolean; client: Pick<OneBotClient, 'call'>; }
// Forwarding owns a delivery record, never a conversation's draft or its attachments.
export async function deliverForward(host: Host, target: Chat, messages: Message[], merged: boolean, log: (error: unknown) => void): Promise<void> {
  const store = host.store, token = host.session.capture();
  const current = () => store === host.store && token.current() && host.ready;
  const check = () => { if (!store || !current()) throw new Error('账号或连接已变化，请重新操作'); };
  check();
  const request = forwardRequest(target, messages, merged);
  await store!.load(target.key); check();
  const local: Message = {
    id: `local:${randomUUID()}`, chatKey: target.key, senderId: store!.selfId, senderName: '我',
    time: Math.floor(Date.now() / 1000), mentioned: false, sendState: 'sending', forwardDelivery: true,
    segments: merged ? [{ type: 'forward', id: '', text: '[合并转发]' }] : structuredClone(messages[0].segments)
  };
  let requested = false, confirmed = false;
  const fail = (error: unknown) => {
    local.sendState = requested && !(error instanceof OneBotRequestError && error.kind === 'rejected') ? 'uncertain' : 'failed';
    local.sendError = local.sendState === 'uncertain' ? '转发结果未确认，请先检查目标会话，不要直接重复转发。' : error instanceof Error ? error.message : String(error);
    store!.enrichMessage(local);
  };
  // Mark the captured account before its store is replaced/disposed. Late results
  // must never publish into another connection, even when the QQ account is the same.
  const abort = () => { if (!confirmed) fail(new Error('连接已变化，转发已停止')); };
  token.signal.addEventListener('abort', abort, { once: true });
  store!.add(local, false);
  try {
    await store!.flush(); check();
    if (merged) await ensureForwardSources(host.client, messages, check);
    check();
    // Readonly recovery may take time; revalidate recalls before submission.
    const latest = messages.map(message => store!.messages.get(message.chatKey)?.find(value => value.id === message.id) ?? message);
    if (latest.some(message => message.recalled)) throw new Error('来源消息已被撤回，请重新选择');
    requested = true;
    const result = await host.client.call(request.action, request.params);
    check();
    const messageId = id(result?.message_id);
    if (!messageId || messageId === '0') throw new Error('转发接口未返回消息 ID');
    store!.settleOutgoing(target.key, local.id, { ...local, id: messageId,
      segments: merged && id(result?.forward_id) ? [{ type: 'forward', id: id(result.forward_id), text: '[合并转发]' }] : local.segments });
    confirmed = true;
    try {
      const raw = await host.client.call('get_msg', { message_id: messageId });
      if (current() && raw?.message && id(raw.message_id) === messageId) {
        const detail = parseMessage(raw, target.key, store!.selfId);
        if (detail.senderId === store!.selfId) store!.enrichMessage({ ...detail, sendState: 'sent', forwardDelivery: undefined }, true);
      }
    } catch (error) { log(`转发已成功，详情补取失败：${error instanceof Error ? error.message : String(error)}`); }
    // The receipt is definitive; persistence/detail errors cannot turn it into a failed send.
    if (current()) await store!.flush().catch(log);
  } catch (error) {
    if (current() && !confirmed) fail(error);
    if (local.sendState === 'uncertain') throw new Error(local.sendError);
    throw error;
  } finally { token.signal.removeEventListener('abort', abort); }
}
