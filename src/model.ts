import { outgoingReply } from './replies';
import { randomUUID } from 'node:crypto';

export type ChatType = 'group' | 'private';
export interface Chat {
  key: string; id: string; type: ChatType; name: string;
  unread: number; mentioned: boolean; lastTime: number; preview: string;
  replied?: boolean;
  notification?: 'notify' | 'muted' | 'unknown';
  ignoreUnread?: boolean;
  remark?: string; nickname?: string;
}
export interface ImageRef { file: string; url?: string; }
export interface VideoRef { file: string; url?: string; name?: string; }
export function mediaFilename(value: unknown, url?: string): string | undefined {
  if (typeof value === 'string' && /\.(?:mp4|mov|webm|mkv|avi|flv)(?:[?#]|$)/i.test(value)) {
    const name = value.split(/[\\/]/).pop()?.split(/[?#]/)[0]; if (name) return inline(name);
  }
  if (url) try { return mediaFilename(decodeURIComponent(new URL(url).pathname)); } catch {}
}
export interface FileRef { id: string; name: string; url?: string; busid?: number; size?: number; }
export type Segment =
  | { type: 'text'; text: string }
  | { type: 'mention'; qq: string; name?: string; text: string }
  | { type: 'file'; file: FileRef; text: string }
  | { type: 'face'; id: string; text: string }
  | { type: 'forward'; id: string; text: string; content?: unknown[] }
  | { type: 'video'; video: VideoRef; text: string }
  | { type: 'image'; image: ImageRef };
// Read v2 caches without guessing identities from ordinary text like "@123".
export function normalizeSegments(segments: unknown[]): Segment[] {
  return segments.flatMap<Segment>(value => {
    if (!value || typeof value !== 'object') return [];
    const s = value as Record<string, any>;
    if (s.type === 'image' && s.image && typeof s.image.file === 'string') return [{ type: 'image', image: s.image }];
    if (s.type === 'video' && s.video && typeof s.video.file === 'string') return [{ type: 'video', video: s.video, text: '[视频]' }];
    if (typeof s.text !== 'string') return [];
    if (s.type === 'forward' && typeof s.id === 'string') return [{ type: 'forward', id: s.id, text: '[合并转发]', ...(Array.isArray(s.content) ? { content: s.content } : {}) }];
    if ((s.type === 'file' || s.type === 'text') && s.file && typeof s.file.name === 'string') return [{ type: 'file', file: s.file, text: s.text }];
    const qq = s.type === 'mention' ? s.qq : s.type === 'text' ? s.at : undefined;
    if (typeof qq === 'string') return [{ type: 'mention', qq, name: s.name ?? s.atName, text: s.text }];
    if (s.type === 'face' && typeof s.id === 'string') return [{ type: 'face', id: s.id, text: s.text }];
    return [{ type: 'text', text: s.text }];
  });
}
export interface Message {
  id: string; chatKey: string; senderId: string; senderName: string;
  time: number; segments: Segment[]; replyId?: string; mentioned: boolean; replyToSelf?: boolean;
  recalled?: boolean;
  senderTitle?: string; senderRole?: string;
  senderRemark?: string; senderNickname?: string;
  sendState?: 'queued' | 'sending' | 'sent' | 'failed' | 'uncertain' | 'cancelled';
  sendError?: string;
  sendProgress?: { stage: 'upload' | 'confirm'; sent: number; total: number; bytesPerSecond?: number };
  outgoing?: Draft;
  forwardDelivery?: boolean;
  localImages?: Attachment[];
  localVideos?: Attachment[];
  fileIds?: string[];
  systemNotice?: string;
}
export interface Member { id: string; name: string; title: string; role: string; nickname?: string; }
export interface Attachment { id: string; kind: 'image' | 'video' | 'face' | 'file'; label: string; size?: number; file?: string; faceId?: string; sticker?: boolean; placeholder?: string; }
export interface Draft { text: string; replyId?: string; replyPlaceholder?: string; replies?: Record<string, string>; version: number; attachments: Attachment[]; mentions?: Record<string, string>; }
export const emptyDraft = (): Draft => ({ text: '', version: 0, attachments: [] });
export const attachmentPattern = /\[(?:(?:图片|视频|表情):\d+|文件:[^\]\r\n]+)\]/g;
export function draftParts(text: string, attachments: Attachment[]): (string | Attachment)[] {
  const parts: (string | Attachment)[] = []; let offset = 0;
  for (const match of text.matchAll(attachmentPattern)) {
    const attachment = attachments.find(a => a.placeholder === match[0]);
    if (!attachment) throw new Error(`占位符 ${match[0]} 没有对应附件，请重新导入或删除它`);
    if (match.index! > offset) parts.push(text.slice(offset, match.index));
    parts.push(attachment); offset = match.index! + match[0].length;
  }
  if (offset < text.length) parts.push(text.slice(offset));
  // Compatibility with drafts saved by 0.1.0, before inline placeholders existed.
  parts.push(...attachments.filter(a => !a.placeholder));
  return parts;
}
// File uploads are independent operations so retries never resend successful neighbours.
export function outgoingDrafts(draft: Draft): Draft[] {
  draft = outgoingReply(draft);
  const parts = draftParts(draft.text, draft.attachments);
  if (!parts.some(p => typeof p !== 'string' && p.kind === 'file')) return [draft];
  const result: Draft[] = []; let chunk: (string | Attachment)[] = [];
  const flush = () => {
    if (!chunk.length) return;
    const text = chunk.map(p => typeof p === 'string' ? p : p.placeholder ?? '').join('');
    const attachments = chunk.filter((p): p is Attachment => typeof p !== 'string');
    if (text.trim() || attachments.length) result.push({ ...draft, text, attachments, replyId: result.length ? undefined : draft.replyId });
    chunk = [];
  };
  for (const part of parts) {
    if (typeof part !== 'string' && part.kind === 'file') {
      flush(); result.push({ ...draft, text: part.placeholder ?? '', attachments: [part], replyId: undefined });
    } else chunk.push(part);
  }
  flush(); return result;
}
export const inline = (text: unknown): string => String(text ?? '').replace(/[\r\n\t\u0000-\u0008\u000b-\u001f\u2028\u2029]/g, ' ');
export function id(value: unknown): string { return typeof value === 'number' || typeof value === 'string' ? String(value) : ''; }
export function chatKey(type: ChatType, value: unknown): string { return `${type}:${id(value)}`; }
export function splitKey(key: string): { type: ChatType; id: string } {
  const match = /^(group|private):(\d+)$/.exec(key);
  if (!match) throw new Error('无效的会话标识');
  return { type: match[1] as ChatType, id: match[2] };
}
export function newChat(type: ChatType, value: unknown, name: unknown): Chat {
  const key = chatKey(type, value); splitKey(key);
  return { key, type, id: id(value), name: inline(name) || id(value), unread: 0, mentioned: false, lastTime: 0, preview: '' };
}
export function parseMessage(raw: any, key?: string, selfId = ''): Message {
  if (!raw || typeof raw !== 'object') throw new Error('无效的消息');
  const type: ChatType = raw.message_type === 'group' ? 'group' : 'private';
  const senderId = id(raw.sender?.user_id ?? raw.user_id);
  // NapCat's own private-message events identify the recipient with target_id.
  const target = type === 'group' ? raw.group_id : (senderId === selfId ? (raw.target_id ?? raw.user_id) : raw.user_id);
  const result: Message = {
    id: id(raw.message_id) && id(raw.message_id) !== '0' ? id(raw.message_id) : `local:${randomUUID()}`,
    chatKey: key ?? chatKey(type, target), senderId,
    senderName: inline(raw.sender?.card || raw.sender?.nickname || senderId),
    time: Number.isFinite(Number(raw.time)) ? Number(raw.time) : Math.floor(Date.now() / 1000),
    segments: [], mentioned: false
  };
  result.senderTitle = inline(raw.sender?.title);
  result.senderNickname = inline(raw.sender?.nickname);
  result.senderRole = ['owner', 'admin', 'member'].includes(raw.sender?.role) ? raw.sender.role : undefined;
  splitKey(result.chatKey);
  const input = Array.isArray(raw.message) ? raw.message : [{ type: 'text', data: { text: String(raw.message ?? raw.raw_message ?? '') } }];
  for (const part of input) {
    if (!part || typeof part !== 'object') continue;
    const data = part.data ?? {};
    switch (part.type) {
      case 'text': result.segments.push({ type: 'text', text: String(data.text ?? '').replace(/\r\n?/g, '\n').replace(/\0/g, '') }); break;
      case 'file': {
        const name = inline(data.name || data.file_name || data.file || '文件');
        result.segments.push({ type: 'file', text: `[文件:${name}]`, file: { id: id(data.file_id ?? data.file), name, url: typeof data.url === 'string' ? data.url : undefined, busid: Number(data.busid ?? data.bus_id) || undefined, size: Number(data.size ?? data.file_size) || undefined } });
        const fileId = id(data.file_id ?? data.file); if (fileId) (result.fileIds ??= []).push(fileId);
        break;
      }
      case 'image': result.segments.push({ type: 'image', image: { file: String(data.file ?? data.file_id ?? ''), url: typeof data.url === 'string' ? data.url : undefined } }); break;
      case 'video': result.segments.push({ type: 'video', text: '[视频]', video: { file: String(data.file ?? data.file_id ?? ''), url: typeof data.url === 'string' ? data.url : undefined, name: inline(data.name || data.file_name) || mediaFilename(data.file, data.url) } }); break;
      case 'face': result.segments.push({ type: 'face', id: id(data.id), text: `[表情:${inline(data.id)}]` }); break;
      case 'forward': result.segments.push({ type: 'forward', id: id(data.id ?? data.resid), text: '[合并转发]', ...(Array.isArray(data.content) ? { content: data.content } : {}) }); break;
      case 'json': {
        let forwardId = '';
        try {
          const card = typeof data.data === 'string' ? JSON.parse(data.data) : data.data;
          if (card?.app === 'com.tencent.multimsg') forwardId = id(card.meta?.detail?.resid);
        } catch { /* Ordinary or malformed cards remain text placeholders. */ }
        result.segments.push(forwardId ? { type: 'forward', id: forwardId, text: '[合并转发]' } : { type: 'text', text: '[卡片]' });
        break;
      }
      case 'reply': result.replyId = id(data.id) || undefined; break;
      case 'at': {
        const qq = id(data.qq);
        result.mentioned ||= qq === selfId || qq === 'all';
        result.segments.push({ type: 'mention', qq, name: inline(data.name) || undefined, text: qq === 'all' ? '@全体成员' : `@${inline(data.name || qq)}` });
        break;
      }
      default: {
        const names: Record<string, string> = { face: '表情', mface: '表情', sface: '表情', video: '视频', record: '语音', forward: '合并转发', file: '文件', json: '卡片', xml: '卡片' };
        result.segments.push({ type: 'text', text: `[${names[part.type] ?? '消息'}${part.type === 'file' && data.name ? `：${inline(data.name)}` : part.type === 'face' ? `:${inline(data.id)}` : ''}]` });
      }
    }
  }
  return result;
}
export const messageText = (message: Message): string => message.segments.map(s => s.type === 'image' ? '[图片]' : s.text).join('');
export const isPending = (m: Message): boolean => (!!m.outgoing || !!m.forwardDelivery) && !['sent', 'cancelled'].includes(m.sendState ?? '');
export function mergeMessages(history: Message[], live: Message[], limit: number): Message[] {
  const values = new Map<string, Message>();
  // A late history/detail response must not restore a recalled message.
  for (const item of [...history, ...live]) {
    const existing = values.get(item.id);
    values.set(item.id, existing?.recalled ? existing : item);
  }
  const sorted = [...values.values()].sort((a, b) => a.time - b.time);
  const retained = sorted.filter(m => !isPending(m)).slice(-limit);
  // Keep the stable order of equal-second messages when retaining pending sends.
  const retainedIds = new Set(retained.map(m => m.id));
  return sorted.filter(m => isPending(m) || retainedIds.has(m.id));
}
