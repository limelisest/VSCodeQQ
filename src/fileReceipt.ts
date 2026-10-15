import { OneBotClient } from './onebot';
import { Attachment, Message, parseMessage } from './model';

// Observe this upload's live echo; no extra OneBot query or filename-only match.
export class FileReceipt {
  private matches = new Map<string, Message>();
  private changed?: () => void;
  constructor(private client: OneBotClient, private selfId: string, private key: string,
    private file: Attachment, private existing: ReadonlySet<string>, private signal: AbortSignal) {
    client.on('event', this.observe);
  }
  private observe = (raw: any) => {
    if (this.signal.aborted || raw?.post_type !== 'message_sent' || raw.self_id && String(raw.self_id) !== this.selfId) return;
    try {
      const message = parseMessage(raw, undefined, this.selfId);
      if (message.senderId !== this.selfId || message.chatKey !== this.key || !/^-?\d+$/.test(message.id) || this.existing.has(message.id)) return;
      const files = message.segments.filter(s => s.type === 'file');
      if (message.segments.length !== 1 || files.length !== 1 || files[0].type !== 'file' || !files[0].file.id || !(this.file.size! > 0) || files[0].file.name !== this.file.label || files[0].file.size !== this.file.size) return;
      this.matches.set(message.id, message); this.changed?.();
    } catch { /* An unrelated or malformed event is not a receipt. */ }
  };
  private result(): Message | undefined { return !this.signal.aborted && this.matches.size === 1 ? [...this.matches.values()][0] : undefined; }
  async wait(): Promise<Message | undefined> {
    if (this.signal.aborted || this.matches.size) return this.result();
    // Only the error path waits briefly for an echo that is already on its way.
    await new Promise<void>(resolve => {
      const finish = () => { clearTimeout(timer); this.signal.removeEventListener('abort', finish); this.changed = undefined; resolve(); };
      const timer = setTimeout(finish, 1200);
      this.changed = finish; this.signal.addEventListener('abort', finish, { once: true });
      if (this.signal.aborted) finish();
    });
    return this.result();
  }
  dispose(): void { this.client.off('event', this.observe); this.changed?.(); }
}
