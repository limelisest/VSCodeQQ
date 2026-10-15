import { randomUUID } from 'node:crypto';
import { Attachment, ImageRef, VideoRef, FileRef } from './model';

export const RESOURCE_MIME = 'application/vnd.limelisest.qq-resources';
export type ClipboardResource = { kind: 'attachment'; attachment: Attachment }
  | { kind: 'image'; image: ImageRef; local?: Attachment }
  | { kind: 'file'; file: FileRef; key: string }
  | { kind: 'video'; video: VideoRef; local?: Attachment }
  | { kind: 'mention'; qq: string; name: string };
export interface ResourceSpan { start: number; end: number; identity: string; resource: ClipboardResource; }
export interface ResourceCopy { account: string; key: string; text: string; spans: ResourceSpan[]; }

// Clipboard metadata contains only an opaque handle. Resource paths/URLs never
// come from another application's untrusted clipboard payload.
export class ResourceClipboard {
  private copies = new Map<string, ResourceCopy>();
  put(copy: ResourceCopy): string {
    const handle = randomUUID(); this.copies.set(handle, structuredClone(copy));
    while (this.copies.size > 20) this.copies.delete(this.copies.keys().next().value!);
    return handle;
  }
  get(handle: string, account: string, text: string): ResourceCopy | undefined {
    const copy = this.copies.get(handle);
    return copy?.account === account && copy.text.replace(/\r\n/g, '\n') === text.replace(/\r\n/g, '\n') ? copy : undefined;
  }
  references(account: string): string[] {
    return [...this.copies.values()].filter(c => c.account === account).flatMap(c => c.spans.flatMap(s => {
      const attachment = s.resource.kind === 'attachment' ? s.resource.attachment : s.resource.kind === 'image' || s.resource.kind === 'video' ? s.resource.local : undefined;
      return attachment?.file ? [attachment.file] : [];
    }));
  }
  clear(): void { this.copies.clear(); }
}
