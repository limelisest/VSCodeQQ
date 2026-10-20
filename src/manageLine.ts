import { availableSlashCommands, SlashCommand, SlashField, validateSlashField } from './slashCatalog';

export const manageCommands = () => availableSlashCommands('group').filter(command => command.category === '群管理');
export const isManageLine = (text: string) => /^\s*\/manage(?:\s|$)/i.test(text);
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
export function manageCompletion(text: string): { command?: SlashCommand; field?: SlashField; prefix: string; start: number } | undefined {
  if (!isManageLine(text)) return;
  const words = commandWords(text), last = words.at(-1)!;
  const next = /\s$/.test(text) && last.closed;
  const index = next ? words.length : words.length - 1;
  if (index < 1) return;
  const prefix = next ? '' : last.value, start = next ? text.length : last.start;
  if (index === 1) return { prefix, start };
  const command = manageCommands().find(c => c.name === words[1].value.toLowerCase());
  if (command) return { command, field: command.fields?.[index - 2], prefix, start };
}
export function parseManageLine(text: string, bindings: Record<string, string> = {}, members: readonly { id: string; name: string; nickname?: string }[] = []): { command: SlashCommand; values: Record<string, string> } {
  const words = commandWords(text);
  if (!isManageLine(text)) throw new Error('请输入 /manage 子命令');
  if (words.some(word => !word.closed)) throw new Error('请补全引号或成员');
  const command = manageCommands().find(c => c.name === words[1]?.value.toLowerCase());
  if (!command) throw new Error('请选择群管理子命令');
  const args = words.slice(2), fields = command.fields ?? [], values: Record<string, string> = {};
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index];
    let value: string | undefined = args[index]?.value;
    if (field.kind === undefined && index === fields.length - 1 && value !== undefined) value = args.slice(index).map(arg => arg.value).join(' ');
    if (value === undefined) value = field.initial ?? (field.allowEmpty ? '' : undefined);
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
