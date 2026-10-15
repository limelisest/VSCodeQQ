import { Message, id, splitKey } from './model';
import { OneBotClient, OneBotRequestError } from './onebot';

// NapCat's numeric message IDs refer to a bounded in-memory peer/message map.
// A cached transcript may outlive that map. Never let the server silently omit
// unresolved nodes from a merged forward: validate every reference before send.
export async function ensureForwardSources(client: Pick<OneBotClient, 'call'>, messages: Message[], check: () => void): Promise<void> {
  const groups = new Map<string, Message[]>();
  for (const message of messages) groups.set(message.chatKey, [...groups.get(message.chatKey) ?? [], message]);
  const readable = async (message: Message): Promise<boolean> => {
    check();
    try {
      const raw = await client.call('get_msg', { message_id: message.id });
      check();
      return id(raw?.message_id) === message.id && raw.message !== undefined;
    } catch (error) {
      check();
      if (error instanceof OneBotRequestError && error.kind === 'rejected') return false;
      throw error;
    }
  };
  for (const [key, selected] of groups) {
    let missing = new Set<string>();
    for (const message of selected) if (!await readable(message)) missing.add(message.id);
    if (!missing.size) continue;
    const source = splitKey(key);
    let cursor = '';
    // Bounded recovery also covers messages outside the first 500 history rows.
    // Fetch only the source chat, without resolving every history image/forward.
    for (let page = 0; page < 4 && missing.size; page++) {
      check();
      const data = await client.call(source.type === 'group' ? 'get_group_msg_history' : 'get_friend_msg_history', {
        [source.type === 'group' ? 'group_id' : 'user_id']: source.id,
        count: 500, parse_mult_msg: false, disable_get_url: true, quick_reply: true,
        ...(cursor ? { message_seq: cursor } : {})
      });
      check();
      const rows = Array.isArray(data?.messages) ? data.messages : [];
      if (!rows.length) break;
      for (const row of rows) missing.delete(id(row?.message_id));
      const oldest = [...rows].sort((a, b) => Number(a?.time ?? 0) - Number(b?.time ?? 0))[0];
      const next = id(oldest?.message_id);
      if (!next || next === cursor) break;
      cursor = next;
    }
    // History registers IDs, but a deleted/expired message may still be absent.
    // Recheck all nodes so a partially recovered selection is never sent.
    missing = new Set<string>();
    for (const message of selected) if (!await readable(message)) missing.add(message.id);
    if (missing.size) throw new Error(`${missing.size} 条来源消息暂时无法从 NapCat 读取，已停止合并转发。请重新加载来源会话历史后再选择；不会只发送其余消息。`);
  }
  check();
}
