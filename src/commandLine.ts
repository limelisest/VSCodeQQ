import { availableSlashCommands, commandGroups, SlashCommand, SlashField, SlashScope, validateSlashField } from './slashCatalog';

export function commandGroup(text: string) {
  const name = /^\s*\/([a-z]+)(?:\s|$)/i.exec(text)?.[1].toLowerCase();
  return commandGroups.find(group => group.name === name);
}
function entries(text: string, type: SlashScope) {
  const group = commandGroup(text);
  if (!group || group.scope && group.scope !== type) return [];
  const commands = availableSlashCommands(type);
  return Object.entries(group.entries).flatMap(([path, name]) => {
    const command = commands.find(command => command.name === name);
    return command ? [{ path: path.split(' '), command }] : [];
  });
}
export function lineCommand(text: string, type: SlashScope): { command: SlashCommand; length: number } | undefined {
  const words = commandWords(text).slice(1).map(word => word.value.toLowerCase());
  const entry = entries(text, type).find(entry => entry.path.every((part, index) => words[index] === part));
  return entry && { command: entry.command, length: entry.path.length + 1 };
}
interface Word { value: string; start: number; end: number; closed: boolean; }
// Mention placeholders and quoted text remain one argument even when names contain spaces.
export function commandWords(text: string): Word[] {
  const words: Word[] = [];
  for (let index = 0; index < text.length;) {
    if (/\s/.test(text[index])) { index++; continue; }
    const start = index;
    if (text.startsWith('[@:', index)) {
      const end = text.indexOf(']', index + 3);
      index = end < 0 ? text.length : end + 1;
      words.push({ value: text.slice(start, index), start, end: index, closed: end >= 0 });
    } else if (text[index] === '"' || text[index] === "'") {
      const quote = text[index++]; let value = '', closed = false;
      while (index < text.length) {
        const char = text[index++];
        if (char === quote) { closed = true; break; }
        if (char === '\\' && (text[index] === quote || text[index] === '\\')) value += text[index++];
        else value += char;
      }
      words.push({ value, start, end: index, closed });
    } else {
      while (index < text.length && !/\s/.test(text[index])) index++;
      words.push({ value: text.slice(start, index), start, end: index, closed: true });
    }
  }
  return words;
}
export function commandLineCompletion(text: string, type: SlashScope): { command?: SlashCommand; field?: SlashField; prefix: string; start: number; choices?: { name: string; description: string; continues: boolean }[] } | undefined {
  if (!commandGroup(text)) return;
  const words = commandWords(text), last = words.at(-1)!;
  const next = /\s$/.test(text) && last.closed;
  const index = next ? words.length : words.length - 1;
  if (index < 1) return;
  const prefix = next ? '' : last.value, start = next ? text.length : last.start;
  const target = lineCommand(text, type);
  if (target && index >= target.length) return { command: target.command, field: target.command.fields?.[index - target.length], prefix, start };
  const previous = words.slice(1, index).map(word => word.value.toLowerCase());
  const labels: Record<string, string> = { notice: '群公告', essence: '精华消息', files: '群文件' };
  const choices = new Map<string, { name: string; description: string; continues: boolean }>();
  for (const entry of entries(text, type)) {
    if (!previous.every((part, index) => entry.path[index] === part)) continue;
    const name = entry.path[previous.length];
    if (!name || !name.startsWith(prefix.toLowerCase())) continue;
    const branch = entry.path.length > previous.length + 1;
    choices.set(name, { name, description: branch ? labels[name] ?? name : entry.command.description, continues: branch || !!entry.command.fields?.length });
  }
  return { prefix, start, choices: [...choices.values()] };
}
export function parseCommandLine(text: string, type: SlashScope, bindings: Record<string, string> = {}, members: readonly { id: string; name: string; nickname?: string }[] = []): { command: SlashCommand; values: Record<string, string> } {
  const words = commandWords(text);
  const group = commandGroup(text);
  if (!group) throw new Error('请输入分类指令');
  if (group.scope && group.scope !== type) throw new Error('此指令仅用于群聊');
  if (words.some(word => !word.closed)) throw new Error('请补全引号或成员');
  const target = lineCommand(text, type);
  if (!target) throw new Error('请选择' + group.description + '子命令');
  const command = target.command;
  const args = words.slice(target.length), fields = command.fields ?? [], values: Record<string, string> = {};
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index];
    let value: string | undefined = args[index]?.value;
    if (field.kind === undefined && index === fields.length - 1 && value !== undefined) value = args.slice(index).map(arg => arg.value).join(' ');
    if (value === undefined) value = field.initial;
    if (value === undefined) throw new Error('请填写' + (field.kind === 'user' ? '成员' : field.label));
    if (field.kind === 'user') {
      if (value.startsWith('[@:')) {
        if (!Object.hasOwn(bindings, value)) throw new Error('请重新选择成员');
        value = bindings[value];
      } else if (/^@\[\d+\]$/.test(value)) value = value.slice(2, -1);
      else if (value.startsWith('@')) {
        const name = value.slice(1), matches = members.filter(member => member.id === name || member.name === name || member.nickname === name);
        const ids = [...new Set(matches.map(member => member.id))];
        if (ids.length !== 1) throw new Error(ids.length ? '成员重名，请从候选中选择' : '未找到成员，请从候选中选择');
        value = ids[0];
      }
    }
    const error = validateSlashField(field, value);
    if (error) throw new Error(error);
    values[field.key] = value;
  }
  if ((args.length > fields.length && fields.at(-1)?.kind !== undefined) || (args.length && !fields.length)) throw new Error('参数过多');
  return { command, values };
}
