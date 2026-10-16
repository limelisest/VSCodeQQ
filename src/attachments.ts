import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Attachment } from './model';
import { imageExtension, videoExtension } from './media';

export const basicFaces = [
  { id: '14', name: '微笑', icon: '🙂' }, { id: '1', name: '撇嘴', icon: '😒' },
  { id: '4', name: '得意', icon: '😎' }, { id: '5', name: '流泪', icon: '😢' },
  { id: '6', name: '害羞', icon: '😊' }, { id: '9', name: '大哭', icon: '😭' },
  { id: '13', name: '呲牙', icon: '😁' }, { id: '20', name: '偷笑', icon: '🤭' },
  { id: '32', name: '疑问', icon: '❓' }, { id: '66', name: '爱心', icon: '❤️' },
  { id: '76', name: '赞', icon: '👍' }, { id: '78', name: '握手', icon: '🤝' },
  { id: '79', name: '胜利', icon: '✌️' }, { id: '99', name: '鼓掌', icon: '👏' }
];
export class AttachmentFiles {
  constructor(readonly folder: string) {}
  async stage(bytes: Buffer, label: string, sticker = false): Promise<Attachment> {
    const ext = imageExtension(bytes); if (!ext) throw new Error('请选择 PNG、JPEG、GIF、WebP 或 BMP 图片');
    await fs.mkdir(this.folder, { recursive: true });
    const id = randomUUID(), file = path.join(this.folder, id + ext);
    await fs.writeFile(file, bytes);
    return { id, kind: 'image', label, file, sticker };
  }
  async stageFile(bytes: Buffer, name: string): Promise<Attachment> {
    const label = name.split(/[\\/]/).pop()?.replace(/[\r\n\0]/g, ' ') || '文件';
    const id = randomUUID(), file = path.join(this.folder, id + '.attachment');
    await fs.mkdir(this.folder, { recursive: true });
    await fs.writeFile(file, bytes);
    return { id, kind: 'file', label, file, size: bytes.length };
  }
  async stageAuto(bytes: Buffer, name: string): Promise<Attachment> {
    if (imageExtension(bytes)) return this.stage(bytes, name);
    const attachment = await this.stageFile(bytes, name);
    const ext = videoExtension(bytes);
    return ext ? this.videoFile(attachment, ext) : attachment;
  }
  private async videoFile(attachment: Attachment, ext: string): Promise<Attachment> {
    const file = path.join(this.folder, attachment.id + ext);
    await fs.rename(attachment.file!, file); return { ...attachment, kind: 'video', file };
  }
  async stageAutoPath(source: string, name: string): Promise<Attachment> {
    const stat = await fs.stat(source);
    if (!stat.isFile()) throw new Error('请拖入文件，文件夹请先压缩');
    const handle = await fs.open(source, 'r');
    const header = Buffer.alloc(4096);
    let length: number;
    try { length = (await handle.read(header, 0, header.length, 0)).bytesRead; } finally { await handle.close(); }
    const video = videoExtension(header.subarray(0, length));
    if (video) return this.videoFile(await this.stageFilePath(source, name), video);
    if (!imageExtension(header.subarray(0, length))) return this.stageFilePath(source, name);
    const ext = imageExtension(header.subarray(0, length))!;
    const attachment = await this.stageFilePath(source, name);
    const file = path.join(this.folder, attachment.id + ext);
    await fs.rename(attachment.file!, file); return { ...attachment, kind: 'image', file };
  }
  async stageFilePath(source: string, name: string): Promise<Attachment> {
    const stat = await fs.stat(source);
    if (!stat.isFile()) throw new Error('请拖入文件，文件夹请先压缩');
    if (!stat.size) throw new Error('不能发送空文件');
    const id = randomUUID(), file = path.join(this.folder, id + '.attachment');
    await fs.mkdir(this.folder, { recursive: true });
    await fs.copyFile(source, file);
    const size = (await fs.stat(file)).size;
    return { id, kind: 'file', label: name, file, size };
  }
  async filePath(attachment: Attachment): Promise<string> {
    if (!attachment.file || path.dirname(path.resolve(attachment.file)) !== path.resolve(this.folder)) throw new Error('附件路径无效');
    if (!(await fs.stat(attachment.file)).isFile()) throw new Error('附件缓存已失效');
    return attachment.file;
  }
  async read(attachment: Attachment): Promise<Buffer> { return fs.readFile(await this.filePath(attachment)); }
  async cacheInfo(): Promise<{ bytes: number; count: number }> {
    const entries = await this.entries();
    return { bytes: entries.reduce((n, f) => n + f.size, 0), count: entries.length };
  }
  private async entries() {
    const names = await fs.readdir(this.folder).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return []; throw e; });
    const entries = await Promise.all(names.map(async name => {
      const file = path.join(this.folder, name), stat = await fs.lstat(file);
      return { file, size: stat.size, time: stat.mtimeMs, regular: stat.isFile() };
    }));
    return entries.filter(e => e.regular);
  }
  async prune(references: Set<string>, retentionDays = 7): Promise<number> {
    let removed = 0;
    for (const entry of await this.entries()) {
      // A grace period also protects imports that have not reached the draft yet.
      if (references.has(path.resolve(entry.file)) || Date.now() - entry.time < Math.max(1 / 24, retentionDays) * 86400000) continue;
      await fs.unlink(entry.file); removed += entry.size;
    }
    return removed;
  }
  async discard(items: Attachment[]): Promise<void> {
    for (const item of items) {
      if (item.file && path.dirname(path.resolve(item.file)) === path.resolve(this.folder)) await fs.unlink(item.file).catch(() => {});
    }
  }
  async segments(attachments: Attachment[]): Promise<unknown[]> {
    const segments: unknown[] = [];
    for (const attachment of attachments) {
      if (attachment.kind === 'face') {
        if (!basicFaces.some(face => face.id === attachment.faceId)) throw new Error('无效的 QQ 表情');
        segments.push({ type: 'face', data: { id: attachment.faceId } });
      } else {
        if (attachment.kind === 'file' || attachment.kind === 'video') throw new Error('文件和视频必须先上传到 NapCat');
        const bytes = await this.read(attachment);
        segments.push({ type: 'image', data: { file: `base64://${bytes.toString('base64')}`, ...(attachment.sticker ? { sub_type: 1 } : {}) } });
      }
    }
    return segments;
  }
}
