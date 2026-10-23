import { codeLanguages } from './codeStyle';
export const languageLabels = { c: 'C', python: 'Python', javascript: 'JavaScript', typescript: 'TypeScript', dart: 'Dart', kotlin: 'Kotlin', java: 'Java', swift: 'Swift' } as const;
export const draftActions = {
  emojis: { label: '表情', command: 'qq.emojis', arguments: [{ autoClose: true }] },
  image: { label: '图片', command: 'qq.insertImage' },
  file: { label: '文件', command: 'qq.insertFile' },
  forward: { label: '转发', command: 'qq.forwardMessage' }
} as const;
export const reminderColors = {
  mentionColor: { label: '@我', default: '#E5A030' }, replyColor: { label: '回复我', default: '#409CFF' },
  allMentionColor: { label: '@全体成员', default: '#C586C0' }, ownColor: { label: '自己发送的消息', default: '#389A65' },
  recalledColor: { label: '已撤回', default: '#F14C4C' }, failedColor: { label: '发送失败', default: '#F14C4C' },
  uncertainColor: { label: '发送结果未确认', default: '#D7BA7D' }, systemColor: { label: '系统与文件传输通知', default: '#9A83D7' },
  unreadColor: { label: '普通未读', default: '#409CFF' }
} as const;
const extraColors = Object.fromEntries(Object.entries(reminderColors).filter(([key]) => !['mentionColor', 'replyColor'].includes(key)).map(([key, value]) => [key, { type: 'string', default: value.default, pattern: '^#[0-9a-fA-F]{6}$' }])) as Record<Exclude<keyof typeof reminderColors, 'mentionColor' | 'replyColor'>, { type: 'string'; default: string; pattern: string }>;
export const chatSettings = {
  codeLanguage: { type: 'string', default: 'c', enum: [...codeLanguages] },
  historyCount: { type: 'number', default: 50, minimum: 10, maximum: 500 },
  messageLimit: { type: 'number', default: 500, minimum: 50, maximum: 2000 },
  notifications: { type: 'string', default: 'all', enum: ['all', 'mentions', 'off'] },
  emojiOrder: { type: 'string', default: 'original', enum: ['original', 'reverse'] },
  statusBarButtons: { type: 'array', default: ['emojis', 'image', 'file', 'forward'], items: { type: 'string', enum: Object.keys(draftActions) }, uniqueItems: true },
  cacheRetentionDays: { type: 'number', default: 7, minimum: 1, maximum: 90 },
  mentionColor: { type: 'string', default: '#E5A030', pattern: '^#[0-9a-fA-F]{6}$' },
  replyColor: { type: 'string', default: '#409CFF', pattern: '^#[0-9a-fA-F]{6}$' },
  ...extraColors
} as const;
export type ChatSetting = keyof typeof chatSettings;
export const settingsPages = {
  connection: [],
  appearance: ['codeLanguage', 'emojiOrder', 'statusBarButtons', ...Object.keys(reminderColors) as (keyof typeof reminderColors)[]],
  config: ['historyCount', 'messageLimit', 'notifications'],
  cache: ['cacheRetentionDays']
} satisfies Record<string, ChatSetting[]>;
export type SettingsPage = keyof typeof settingsPages;
export function isSettingsPage(value: unknown): value is SettingsPage {
  return typeof value === 'string' && Object.hasOwn(settingsPages, value);
}
export function validateChatSettings(input: Record<string, unknown>): [ChatSetting, unknown][] {
  const updates: [ChatSetting, unknown][] = [];
  for (const key of Object.keys(chatSettings) as ChatSetting[]) {
    const value = input[key], definition = chatSettings[key];
    if (value === undefined) continue;
    if ('items' in definition) {
      if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !definition.items.enum.includes(item)) || new Set(value).size !== value.length) throw new Error('草稿入口选项无效');
    } else if ('minimum' in definition) {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < definition.minimum || value > definition.maximum) throw new Error(`${key} 必须为 ${definition.minimum}～${definition.maximum} 的整数`);
    } else if ('enum' in definition) {
      if (!(definition.enum as readonly unknown[]).includes(value)) throw new Error(`${key} 选项无效`);
    } else if (typeof value !== 'string' || !new RegExp(definition.pattern).test(value)) throw new Error('高亮颜色格式无效');
    updates.push([key, value]);
  }
  return updates;
}
