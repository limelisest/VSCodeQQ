import { Chat, Message, inline } from './model';
import { CodeLanguage, codeStyle } from './codeStyle';

export const TRANSCRIPT_HELP = '底部草稿 Enter 发送 · Shift/Ctrl+Enter 换行 · 点击 msg 回复 · 点击 name 提及 · 图片悬浮预览';

export interface Span { line: number; start: number; end: number; messageId: string; imageIndex: number; }
export interface MentionSpan { kind: 'sender' | 'mention'; line: number; start: number; end: number; qq: string; name: string; }
export interface Rendered { text: string; forwards: { line: number; start: number; end: number; messageId: string; forwardIndex: number }[]; images: Span[]; videos: { line: number; start: number; end: number; messageId: string; videoIndex: number }[]; mentions: MentionSpan[]; files: { line: number; start: number; end: number; messageId: string; fileIndex: number }[]; actions: { line: number; start: number; end: number; messageId: string; kind: 'reply' | 'retry' | 'cancel' }[]; messages: Map<number, string>; starts: Map<string, number>; ownLines: number[]; recalledLines: number[]; attentionLines: number[]; mentionLines: number[]; replyLines: number[]; }
// Escape only the display projection; copy/reply/send continue using the original message.
export const codeString = (text: string): string => JSON.stringify(text).slice(1, -1)
  .replace(/[\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
export function renderTranscript(chat: Chat, messages: Message[], selfId: string, language: CodeLanguage = 'c'): Rendered {
  const style = codeStyle(language);
  const escape = (text: string) => style.escape(codeString(text));
  const quote = (text: string) => `"${escape(text)}"`;
  const lines = [style.constant('CHAT_NAME', [quote(chat.name)]), style.constant(chat.type === 'group' ? 'GROUP_ID' : 'FRIEND_ID', [quote(chat.id)]), `${style.comment} ${TRANSCRIPT_HELP}`, ''];
  const rendered: Rendered = { text: '', forwards: [], images: [], videos: [], mentions: [], files: [], actions: [], messages: new Map(), starts: new Map(), ownLines: [], recalledLines: [], attentionLines: [], mentionLines: [], replyLines: [] };
  const byId = new Map(messages.map(m => [m.id, m]));
  let lastDay = '';
  for (const m of messages) {
    const date = new Date(m.time * 1000);
    const day = Number.isFinite(date.getTime()) ? date.toLocaleDateString('zh-CN') : '';
    if (day && day !== lastDay) { lines.push(`${style.comment} ── ${day} ──`, ''); lastDay = day; }
    const start = lines.length;
    rendered.starts.set(m.id, start);
    const pad = (value: number) => String(value).padStart(2, '0');
    const stamp = Number.isFinite(date.getTime())
      ? `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
      : '----/--/-- --:--:--';
    if (m.systemNotice) {
      rendered.messages.set(lines.length, m.id);
      lines.push(`${style.comment} ${stamp} · 文件传输：${inline(m.systemNotice)}`, '');
      continue;
    }
    const self = m.senderId === selfId;
    const target = m.replyId ? byId.get(m.replyId) : undefined;
    const tags = [self ? '我' : '', m.senderRole === 'owner' ? '群主' : m.senderRole === 'admin' ? '管理员' : '', !self && m.mentioned ? '@我' : '', !self && (m.replyToSelf || target?.senderId === selfId) ? '回复我' : ''].filter(Boolean);
    let state = m.sendState ? ({ queued: '等待发送…', sending: '发送中…', sent: '', failed: '发送失败 · [重试]', uncertain: '结果未确认 · [重试]', cancelled: '' })[m.sendState] : '';
    if (m.forwardDelivery) state = state.replace(' · [重试]', '');
    if (m.sendState === 'sending' && m.sendProgress) {
      const p = m.sendProgress, percent = p.total ? Math.min(100, Math.floor(p.sent / p.total * 100)) : 0;
      const filled = Math.floor(percent / 10);
      state = p.stage === 'confirm' ? '附件已传至 NapCat · 等待 QQ 确认…' : `上传到 NapCat [${'█'.repeat(filled)}${'░'.repeat(10 - filled)}] ${percent}% · ${(p.sent / 1048576).toFixed(1)}/${(p.total / 1048576).toFixed(1)} MB${p.bytesPerSecond ? ` · ${(p.bytesPerSecond / 1048576).toFixed(2)} MB/s` : ''}`;
    }
    lines.push(style.constant('DATE', [quote(stamp)]));
    const fn = self ? (m.replyId ? 'send_reply' : 'send') : (m.replyId ? 'reply' : 'recv');
    lines.push(`${style.function(`${fn}_${/^\d+$/.test(m.senderId) ? m.senderId : 'unknown'}`)}${tags.length ? `  ${style.comment} ${tags.join(' · ')}` : ''}`);
    if (m.senderTitle) lines.push(style.string('title') + escape(m.senderTitle) + style.stringEnd);
    const remark = m.senderRemark && m.senderRemark !== m.senderName ? `  ${style.comment} 备注：${inline(m.senderRemark)}` : '';
    if (chat.type === 'group' && !self && /^\d+$/.test(m.senderId)) {
      const start = style.string('name').indexOf('name');
      rendered.mentions.push({ kind: 'sender', line: lines.length, start, end: start + 4, qq: m.senderId, name: m.senderName });
    }
    lines.push(style.string('name') + escape(m.senderName) + style.stringEnd + remark);
    if (m.replyId) {
      let replay = style.string('replay');
      if (target) {
        replay += escape(`${target.senderName}：`);
        let remaining = 160, replyImageIndex = 0, replyVideoIndex = 0, replyFileIndex = 0, truncated = false;
        for (const part of target.segments) {
          if (part.type === 'image') {
            rendered.images.push({ line: lines.length, start: replay.length, end: replay.length + 4, messageId: target.id, imageIndex: replyImageIndex++ });
            replay += '[图片]';
          } else if (part.type === 'video') {
            rendered.videos.push({ line: lines.length, start: replay.length, end: replay.length + 4, messageId: target.id, videoIndex: replyVideoIndex++ });
            replay += '[视频]';
          } else if (part.type === 'file') {
            const label = escape(part.text);
            rendered.files.push({ line: lines.length, start: replay.length, end: replay.length + label.length, messageId: target.id, fileIndex: replyFileIndex++ });
            replay += label;
          } else if (part.type === 'mention' && chat.type === 'group') {
            const text = escape(part.text);
            rendered.mentions.push({ kind: 'mention', line: lines.length, start: replay.length, end: replay.length + text.length, qq: part.qq, name: part.name || part.qq });
            replay += text;
          } else {
            replay += escape(part.text.slice(0, remaining));
            if (part.text.length > remaining && !truncated) { replay += '…'; truncated = true; }
            remaining = Math.max(0, remaining - part.text.length);
          }
        }
      } else replay += escape(`回复消息 ${m.replyId}（未加载）`);
      lines.push(replay + style.stringEnd);
    }
    let current = style.string('msg');
    const canReply = !m.recalled && /^-?\d+$/.test(m.id) && m.id !== '0';
    const replySpan = (start: number, end: number) => {
      if (canReply && end > start) rendered.actions.push({ line: lines.length, start, end, messageId: m.id, kind: 'reply' });
    };
    // Keep the reply target on the variable, leaving message text free to select and copy.
    const msgStart = current.indexOf('msg'); replySpan(msgStart, msgStart + 3);
    let imageIndex = 0, videoIndex = 0, fileIndex = 0, forwardIndex = 0;
    const resources: { type: 'video' | 'file'; index: number; name: string; alias?: { line: number; start: number; end: number; messageId: string } }[] = [];
    for (const part of m.segments) {
      if (part.type === 'image') {
        rendered.images.push({ line: lines.length, start: current.length, end: current.length + 4, messageId: m.id, imageIndex: imageIndex++ });
        current += '[图片]';
      } else if (part.type === 'video') {
        const index = videoIndex++, label = `[视频:${index + 1}]`;
        rendered.videos.push({ line: lines.length, start: current.length, end: current.length + label.length, messageId: m.id, videoIndex: index });
        resources.push({ type: 'video', index, name: m.localVideos?.[index]?.label || part.video.name || '未命名视频' });
        current += label;
      } else if (part.type === 'forward') {
        rendered.forwards.push({ line: lines.length, start: current.length, end: current.length + part.text.length, messageId: m.id, forwardIndex: forwardIndex++ });
        current += part.text;
      } else if (part.type === 'mention' && chat.type === 'group') {
        const text = escape(part.text);
        rendered.mentions.push({ kind: 'mention', line: lines.length, start: current.length, end: current.length + text.length, qq: part.qq, name: part.name || part.qq });
        current += text;
      } else if (part.type === 'file') {
        const index = fileIndex++, label = `[文件:${index + 1}]`;
        resources.push({ type: 'file', index, name: part.file.name, alias: { line: lines.length, start: current.length, end: current.length + label.length, messageId: m.id } });
        current += label;
      } else {
        const parts = part.text.split('\n');
        for (let index = 0; index < parts.length; index++) {
          if (index) { lines.push(current + '\\n"' + style.join); current = style.continuation; }
          const text = escape(parts[index]);
          current += text;
        }
      }
    }
    current += style.stringEnd;
    lines.push(current);
    for (const resource of resources) {
      const prefix = style.resource(`${resource.type}_${resource.index + 1}`);
      const name = inline(resource.name).replace(/\[/g, '［').replace(/\]/g, '］');
      const label = escape(`[${resource.type === 'video' ? '视频' : '文件'}:${name}]`);
      const span = { line: lines.length, start: prefix.length, end: prefix.length + label.length, messageId: m.id };
      if (resource.type === 'video') rendered.videos.push({ ...span, videoIndex: resource.index });
      else {
        rendered.files.push({ ...span, fileIndex: resource.index });
        if (resource.alias) rendered.files.push({ ...resource.alias, fileIndex: resource.index });
      }
      lines.push(prefix + label + style.stringEnd);
    }
    const ending = `${style.ending}${state ? `  ${style.comment} ${state}` : ''}`;
    if (ending.includes('[重试]')) rendered.actions.push({ line: lines.length, start: ending.indexOf('[重试]'), end: ending.indexOf('[重试]') + 4, messageId: m.id, kind: 'retry' });
    const cancellable = m.sendState === 'queued' || (m.sendState === 'sending' && m.sendProgress?.stage === 'upload');
    const footer = ending + (cancellable ? ' · [取消]' : '');
    if (cancellable) rendered.actions.push({ line: lines.length, start: footer.indexOf('[取消]'), end: footer.indexOf('[取消]') + 4, messageId: m.id, kind: 'cancel' });
    lines.push(footer + (m.recalled ? `  ${style.comment} 已撤回` : ''));
    for (let line = start; line < lines.length; line++) { rendered.messages.set(line, m.id); if (m.recalled) rendered.recalledLines.push(line); else if (self) rendered.ownLines.push(line); else if (m.mentioned || m.replyToSelf || target?.senderId === selfId) { rendered.attentionLines.push(line); (m.mentioned ? rendered.mentionLines : rendered.replyLines).push(line); } }
    lines.push('');
  }
  if (!messages.length) lines.push(`${style.comment} 暂无消息。`);
  rendered.text = lines.join('\n');
  return rendered;
}
