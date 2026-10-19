// Service identities are scoped to private chats; the same number can be a group.
export function systemChatName(type: string, id: string): string | undefined {
  if (type === 'private' && id === '2010741172') return 'QQ邮箱';
}

export function chatDisplayName(type: string, id: string, name: string): string {
  return !name.trim() || name.trim() === id ? systemChatName(type, id) || id : name;
}
