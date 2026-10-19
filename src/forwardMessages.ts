import { Message, Chat, parseMessage } from './model';

export function forwardNodes(data: unknown): unknown[] | undefined {
  const value = data as { messages?: unknown; message?: unknown } | null;
  if (Array.isArray(value?.messages) && value.messages.length) return value.messages;
  if (Array.isArray(value?.message)) return value.message;
  return Array.isArray(value?.messages) ? value.messages : undefined;
}

// Forward nodes do not necessarily have a message ID, and repeated IDs are valid.
export function parseForwardMessages(data: unknown, key: string): Message[] {
  const nodes = forwardNodes(data);
  if (!Array.isArray(nodes)) throw new Error('服务端未返回有效的合并转发内容');
  const parsed = nodes.map(value => {
    if (!value || typeof value !== 'object') throw new Error('合并转发包含无效消息');
    const raw = value as Record<string, any>;
    const node = raw.type === 'node' ? raw.data : raw;
    if (!node || typeof node !== 'object') throw new Error('合并转发包含无效节点');
    const body = Array.isArray(node.message) && !node.message.length && Array.isArray(node.content) && node.content.length ? node.content : node.message ?? node.content;
    const message = parseMessage({ ...node, message: body,
      sender: node.sender ?? { user_id: node.user_id ?? node.uin, nickname: node.nickname ?? node.name } }, key);
    return message;
  });
  // Each page owns its mapping. Duplicate IDs are deliberately unresolved.
  const counts = new Map<string, number>();
  const originals = new Set(parsed.flatMap(m => [m.id, m.replyId ?? '']));
  for (const m of parsed) if (!m.id.startsWith('local:')) counts.set(m.id, (counts.get(m.id) ?? 0) + 1);
  let prefix = 'forward:';
  while (parsed.some((_, i) => originals.has(`${prefix}${i}`))) prefix += 'node:';
  const unique = new Map(parsed.flatMap((m, i) => counts.get(m.id) === 1 ? [[m.id, `${prefix}${i}`] as const] : []));
  return parsed.map((m, i) => ({ ...m, id: `${prefix}${i}`, replyId: m.replyId ? unique.get(m.replyId) ?? m.replyId : undefined }));
}
export function forwardRequest(target: Chat, messages: Message[], merged: boolean): { action: string; params: Record<string, unknown> } {
  if (!messages.length || !merged && messages.length !== 1 || messages.some(m => !/^-?\d+$/.test(m.id) || m.id === '0' || m.recalled || m.sendState && m.sendState !== 'sent')) throw new Error('请选择已发送且未撤回的消息（单条转发只选一条）');
  const params = { [target.type === 'group' ? 'group_id' : 'user_id']: target.id };
  return merged ? {
    action: target.type === 'group' ? 'send_group_forward_msg' : 'send_private_forward_msg',
    params: { ...params, messages: messages.map(m => ({ type: 'node', data: { id: m.id } })) }
  } : { action: target.type === 'group' ? 'forward_group_single_msg' : 'forward_friend_single_msg', params: { ...params, message_id: messages[0].id } };
}
