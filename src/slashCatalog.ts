// A single catalog drives editor completion, /help, parameter dialogs and API coverage.
// Keep this module independent of VS Code so validation and session guards are testable.
export type SlashScope = 'group' | 'private';
export interface SlashContext { key: string; type: SlashScope; id: string; name: string; selfId: string; }
export interface SlashField {
  key: string; label: string; kind?: 'user' | 'message' | 'integer' | 'choice';
  initial?: string; min?: number; max?: number; allowEmpty?: boolean;
  choices?: { label: string; value: string | boolean }[];
}
export interface SlashCommand {
  name: string; description: string; category: string; scope?: SlashScope;
  local?: string; special?: 'help' | 'reply' | 'requests' | 'files' | 'poke';
  action?: string; fields?: SlashField[]; defaults?: Record<string, unknown>;
  group?: boolean; mutation?: boolean; confirm?: string; sensitive?: boolean;
}
const user = (label = '选择成员或输入 QQ 号'): SlashField => ({ key: 'user_id', label, kind: 'user' });
const message: SlashField = { key: 'message_id', label: '选择消息', kind: 'message' };
const text = (key: string, label: string, allowEmpty = false): SlashField => ({ key, label, allowEmpty });
const integer = (key: string, label: string, initial: string, min: number, max: number): SlashField => ({ key, label, kind: 'integer', initial, min, max });
const local = (name: string, description: string, command: string, scope?: SlashScope): SlashCommand => ({ name, description, category: '聊天', local: command, scope });
const query = (name: string, description: string, action: string, fields: SlashField[] = [], group = false): SlashCommand => ({ name, description, category: '查询', action, fields, group, scope: group ? 'group' : undefined });
const change = (name: string, description: string, action: string, fields: SlashField[], group = false): SlashCommand => ({ ...query(name, description, action, fields, group), category: group ? '群管理' : '操作', mutation: true, confirm: description });
const groupChange = (name: string, description: string, action: string, fields: SlashField[], defaults?: Record<string, unknown>): SlashCommand => ({ ...change(name, description, action, fields, true), defaults });
export const slashCommands: readonly SlashCommand[] = [
  local('emoji', '表情：收藏、最近使用和 QQ 表情', 'qq.emojis'),
  local('image', '图片：选择图片并插入草稿占位符', 'qq.insertImage'),
  local('video', '视频：选择视频并插入草稿占位符', 'qq.insertVideo'),
  local('file', '文件：选择文件并插入草稿占位符', 'qq.insertFile'),
  local('mention', '提及：选择群成员插入真实 @', 'qq.mentionMember', 'group'),
  { name: 'reply', description: '回复：选择当前会话中的消息', category: '聊天', special: 'reply' },
  local('cancel_reply', '取消当前草稿的回复', 'qq.cancelReply'),
  local('history', '加载更多聊天记录', 'qq.loadHistory'),
  local('latest', '跳到最新消息和草稿区', 'qq.latest'),
  local('search', '搜索并打开会话', 'qq.search'),
  local('favorite', '收藏或取消收藏当前会话', 'qq.toggleFavorite'),
  local('archive', '放入或移出收纳箱', 'qq.toggleCollapsed', 'group'),
  local('read', '将当前会话标记为已读', 'qq.markRead'),
  local('mute', '切换本机会话提醒', 'qq.toggleIgnoreUnread'),
  local('settings', '打开连接与聊天设置', 'qq.configure'),
  local('style', '选择聊天记录的代码风格', 'qq.chooseCodeLanguage'),
  local('refresh', '刷新好友和群聊列表', 'qq.refresh'),
  { name: 'help', description: '查看全部英文指令及中文说明', category: '帮助', special: 'help' },
  change('recall', '撤回所选消息', 'delete_msg', [message]),
  query('message', '查看消息详情', 'get_msg', [message]),
  local('forward_info', '查看合并转发内容', 'qq.viewForward'),
  local('forward', '转发：选择消息和目标会话', 'qq.forwardMessage'),
  local('merge_forward', '选择多条消息合并转发', 'qq.mergeForward'),
  change('like', '给好友资料点赞', 'send_like', [user(), integer('times', '点赞次数', '1', 1, 10)]),
  { name: 'poke', description: '戳一戳当前好友或群成员', category: '操作', special: 'poke', mutation: true },
  query('login', '查看当前登录账号', 'get_login_info'),
  { ...query('user', '查看 QQ 用户资料', 'get_stranger_info', [user()]), defaults: { no_cache: true } },
  query('friends', '查看好友列表', 'get_friend_list'),
  query('groups', '查看群聊列表', 'get_group_list'),
  { ...query('group', '查看当前群资料', 'get_group_info', [], true), defaults: { no_cache: true } },
  { ...query('member', '查看群成员资料', 'get_group_member_info', [user()], true), defaults: { no_cache: true } },
  query('members', '查看当前群成员列表', 'get_group_member_list', [], true),
  { ...query('honors', '查看群荣誉', 'get_group_honor_info', [], true), defaults: { type: 'all' } },
  query('status', '查看 OneBot 运行状态', 'get_status'),
  query('version', '查看 NapCat 和协议版本', 'get_version_info'),
  query('can_image', '检查图片发送能力', 'can_send_image'),
  query('can_voice', '检查语音发送能力', 'can_send_record'),
  query('image_info', '获取图片文件信息', 'get_image', [text('file', '图片文件标识')]),
  query('record_info', '获取语音文件信息', 'get_record', [text('file', '语音文件标识'), { key: 'out_format', label: '输出格式', kind: 'choice', choices: ['mp3', 'wav', 'ogg', 'flac', 'amr', 'spx', 'wma', 'm4a'].map(value => ({ label: value, value })) }]),
  groupChange('ban', '禁言群成员', 'set_group_ban', [user(), integer('duration', '禁言秒数（0 解除禁言）', '1800', 0, 2592000)]),
  groupChange('unban', '解除成员禁言', 'set_group_ban', [user()], { duration: 0 }),
  groupChange('ban_all', '开启全员禁言', 'set_group_whole_ban', [], { enable: true }),
  groupChange('unban_all', '关闭全员禁言', 'set_group_whole_ban', [], { enable: false }),
  groupChange('kick', '将成员移出群聊', 'set_group_kick', [user()], { reject_add_request: false }),
  groupChange('admin', '设置群管理员', 'set_group_admin', [user()], { enable: true }),
  groupChange('unadmin', '取消群管理员', 'set_group_admin', [user()], { enable: false }),
  groupChange('card', '修改群名片（留空恢复默认）', 'set_group_card', [user(), text('card', '新的群名片', true)]),
  groupChange('title', '修改成员专属头衔（留空清除）', 'set_group_special_title', [user(), text('special_title', '新的专属头衔', true)], { duration: -1 }),
  groupChange('rename', '修改群名称', 'set_group_name', [text('group_name', '新的群名称')]),
  groupChange('leave', '退出当前群聊', 'set_group_leave', [], { is_dismiss: false }),
  groupChange('dismiss', '解散当前群聊（仅群主）', 'set_group_leave', [], { is_dismiss: true }),
  { name: 'requests', description: '处理本次连接收到的好友、入群申请和邀请', category: '申请', special: 'requests', mutation: true },
  query('group_requests', '查看服务端群申请和邀请', 'get_group_system_msg'),
  query('notices', '查看群公告', '_get_group_notice', [], true),
  groupChange('notice', '发布群公告', '_send_group_notice', [text('content', '公告正文')]),
  groupChange('notice_delete', '删除群公告', '_del_group_notice', [text('notice_id', '要删除的公告 ID')]),
  query('essence', '查看群精华消息', 'get_essence_msg_list', [], true),
  { ...groupChange('essence_add', '将消息设为群精华', 'set_essence_msg', [message]), group: false },
  { ...groupChange('essence_remove', '移除群精华消息', 'delete_essence_msg', [message]), group: false },
  { name: 'group_files', description: '浏览群文件和文件夹、下载文件', category: '群文件', scope: 'group', special: 'files' },
  query('file_space', '查看群文件空间用量', 'get_group_file_system_info', [], true),
  groupChange('folder', '新建群文件夹', 'create_group_file_folder', [text('name', '文件夹名称')]),
  groupChange('folder_delete', '删除群文件夹及其中内容', 'delete_group_folder', [text('folder_id', '要删除的文件夹 ID')]),
  groupChange('group_file_delete', '删除群文件', 'delete_group_file', [text('file_id', '要删除的文件 ID'), integer('busid', '文件业务 ID', '102', 0, 2147483647)]),
  { ...change('react', '给消息添加表情回应', 'set_msg_emoji_like', [message, text('emoji_id', '表情 ID，例如 76（赞）')]), defaults: { set: true } },
  { ...change('unreact', '取消消息表情回应', 'set_msg_emoji_like', [message, text('emoji_id', '表情 ID，例如 76（赞）')]), defaults: { set: false } },
  { ...change('friend_remark', '修改当前好友备注', 'set_friend_remark', [text('remark', '新的好友备注', true)]), scope: 'private' },
  groupChange('group_remark', '修改本机 QQ 群备注', 'set_group_remark', [text('remark', '新的群备注', true)]),
  change('signature', '修改 QQ 个性签名', 'set_self_longnick', [text('longNick', '新的个性签名', true)]),
  query('online_clients', '查看在线客户端', 'get_online_clients'),
  query('friend_categories', '查看好友分组', 'get_friends_with_category'),
  { ...query('recent_contacts', '查看最近会话', 'get_recent_contact'), defaults: { count: 50 } },
  query('at_all_remaining', '查看 @全体成员剩余次数', 'get_group_at_all_remain', [], true),
  query('group_bans', '查看群禁言成员', 'get_group_shut_list', [], true),
  groupChange('sign', '群签到', 'send_group_sign', []),
  ...[
    query('cookies', '查看指定域名的 QQ Cookies（敏感）', 'get_cookies', [text('domain', '域名，例如 qun.qq.com')]),
    query('csrf', '查看 QQ CSRF Token（敏感）', 'get_csrf_token'),
    query('credentials', '查看指定域名的 QQ 凭证（敏感）', 'get_credentials', [text('domain', '域名，例如 qun.qq.com')])
  ].map(command => ({ ...command, category: '高级', sensitive: true })),
  { ...change('restart', '重启 OneBot 后端，连接将中断', 'set_restart', []), category: '高级', defaults: { delay: 0 } },
  { ...change('backend_cache', '清理 NapCat 和 QQ 的图片、语音、视频与文件缓存', 'clean_cache', []), category: '高级' }
];
export const availableSlashCommands = (type: SlashScope): readonly SlashCommand[] => slashCommands.filter(command => !command.scope || command.scope === type);
export function exactSlashCommand(text: string, type: SlashScope): SlashCommand | undefined {
  const match = /^\/([a-z][a-z0-9_]*)$/i.exec(text.trim());
  return match ? availableSlashCommands(type).find(command => command.name === match[1].toLowerCase()) : undefined;
}
export function validateSlashField(field: SlashField, value: string): string | undefined {
  if (!value.trim() && !field.allowEmpty) return '请输入' + field.label;
  if (field.kind === 'user' && !/^[1-9]\d{0,15}$/.test(value.trim())) return '请输入有效的 QQ 号';
  if (field.kind === 'message' && (!/^-?\d+$/.test(value.trim()) || Number(value) === 0 || !Number.isSafeInteger(Number(value)))) return '请输入有效的消息 ID';
  if (field.kind === 'integer' && (!/^\d+$/.test(value.trim()) || !Number.isSafeInteger(Number(value)) || Number(value) < (field.min ?? 0) || Number(value) > (field.max ?? Number.MAX_SAFE_INTEGER))) return `请输入 ${field.min ?? 0} 到 ${field.max ?? Number.MAX_SAFE_INTEGER} 之间的整数`;
  return undefined;
}
export interface SlashIO {
  check(): void;
  ask(field: SlashField): Promise<string | boolean | undefined>;
  confirm(command: SlashCommand, context: SlashContext, params: Record<string, unknown>): Promise<boolean>;
  call(action: string, params: Record<string, unknown>): Promise<unknown>;
  result(command: SlashCommand, data: unknown, params: Record<string, unknown>): Promise<void>;
}
export async function executeSlashApi(command: SlashCommand, context: SlashContext, io: SlashIO): Promise<boolean> {
  io.check();
  if (!command.action || command.scope && command.scope !== context.type) throw new Error('当前会话不能使用此指令');
  const params: Record<string, unknown> = { ...command.defaults, ...(command.group ? { group_id: context.id } : {}) };
  if (command.name === 'friend_remark') params.user_id = context.id;
  for (const field of command.fields ?? []) {
    const value = await io.ask(field); io.check();
    if (value === undefined) return false;
    if (typeof value === 'string') { const error = validateSlashField(field, value); if (error) throw new Error(error); }
    params[field.key] = field.kind === 'integer' ? Number(value) : typeof value === 'string' && field.kind !== undefined ? value.trim() : value;
  }
  if (command.mutation || command.sensitive) { const accepted = await io.confirm(command, context, params); io.check(); if (!accepted) return false; }
  io.check();
  const result = await io.call(command.action, params); io.check();
  await io.result(command, result, params);
  return true;
}
