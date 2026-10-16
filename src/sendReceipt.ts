import { createHash } from 'node:crypto';
import { ChatStore } from './store';
import { Message, Segment } from './model';

export interface SendReceipt { echo?: Message; close(): void; }
interface Attempt extends SendReceipt {
  store: ChatStore; localId: string; key: string; fingerprint: string;
  started: number; expires: number; existing: Set<string>; signal: AbortSignal;
}
// QQ identifies image/video files by their content MD5. Never equate two [图片]
// placeholders or compare expiring download URLs. Unknown resources do not match.
export function mediaDigest(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  if (value.startsWith('base64://')) return createHash('md5').update(Buffer.from(value.slice(9), 'base64')).digest('hex');
  return /(?:^|[\\/])([a-f0-9]{32})(?:\.[a-z0-9]+)?$/i.exec(value)?.[1].toLowerCase();
}
function fingerprint(message: Message): string | undefined {
  const parts: (string[])[] = [];
  for (const segment of message.segments) {
    if (segment.type === 'text') {
      const text = segment.text.replace(/\r\n?/g, '\n').replace(/\0/g, '');
      if (!text) continue;
      if (parts.at(-1)?.[0] === 'text') parts.at(-1)![1] += text;
      else parts.push(['text', text]);
    } else if (segment.type === 'mention') parts.push(['at', segment.qq]);
    else if (segment.type === 'face') parts.push(['face', segment.id]);
    else if (segment.type === 'image' || segment.type === 'video') {
      const resource = segment.type === 'image' ? segment.image : segment.video;
      const digest = mediaDigest(resource.file); if (!digest) return;
      parts.push([segment.type, digest]);
    } else return;
  }
  if (!parts.length) return;
  return createHash('sha256').update(JSON.stringify([message.replyId ?? '', parts])).digest('hex');
}
export class SendReceipts {
  private attempts = new Set<Attempt>();
  private signal?: AbortSignal;
  private clear = () => { this.attempts.clear(); };
  begin(store: ChatStore, local: Message, segments: Segment[], signal: AbortSignal, timeout: number): SendReceipt | undefined {
    this.prune();
    if (this.signal !== signal) {
      this.signal?.removeEventListener('abort', this.clear); this.clear();
      this.signal = signal; signal.addEventListener('abort', this.clear, { once: true });
    }
    // A user-confirmed retry starts a new attempt for this local record.
    for (const attempt of this.attempts) if (attempt.store === store && attempt.localId === local.id) attempt.close();
    const expected = fingerprint({ ...local, segments }); if (!expected || signal.aborted) return;
    const started = Date.now();
    const attempt: Attempt = {
      store, localId: local.id, key: local.chatKey, fingerprint: expected, signal, started,
      // Allow a delayed event after the request has timed out, but never attach
      // a much later, deliberate duplicate to an old uncertain attempt.
      expires: started + timeout + 60000,
      existing: new Set(store.messages.get(local.chatKey)?.map(m => m.id)),
      close: () => { this.attempts.delete(attempt); }
    };
    this.attempts.add(attempt);
    return attempt;
  }
  observe(store: ChatStore, raw: any, message: Message): boolean {
    this.prune();
    if (!['message', 'message_sent'].includes(raw?.post_type) || String(raw.self_id ?? '') !== store.selfId || message.senderId !== store.selfId || !/^-?[1-9]\d*$/.test(message.id) || !Number.isFinite(Number(raw.time))) return false;
    const digest = fingerprint(message); if (!digest) return false;
    const candidates = [...this.attempts].filter(attempt => {
      const local = store.messages.get(attempt.key)?.find(m => m.id === attempt.localId);
      return attempt.store === store && attempt.key === message.chatKey && !attempt.existing.has(message.id)
        && message.time >= Math.floor(attempt.started / 1000) - 2 && message.time <= Math.ceil(attempt.expires / 1000)
        && attempt.fingerprint === digest && local?.outgoing && !local.recalled
        && ['sending', 'uncertain'].includes(local.sendState ?? '');
    });
    if (candidates.length !== 1) return false;
    const attempt = candidates[0];
    attempt.echo = message; attempt.close();
    store.settleOutgoing(message.chatKey, attempt.localId, { ...message, sendProgress: undefined });
    return true;
  }
  private prune(): void {
    for (const attempt of this.attempts) if (attempt.signal.aborted || Date.now() > attempt.expires) attempt.close();
  }
}
