import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { ImageRef, VideoRef, FileRef, splitKey } from './model';
import { downloadFile } from './download';
import { OneBotClient } from './onebot';
import { imageSize } from 'image-size';

export function previewDimensions(bytes: Buffer, bounds = { width: 240, height: 160 }): { width: number; height: number } {
  const size = imageSize(bytes);
  const rotated = size.orientation !== undefined && size.orientation >= 5 && size.orientation <= 8;
  const width = rotated ? size.height : size.width, height = rotated ? size.width : size.height;
  if (!(width > 0 && height > 0)) throw new Error('无法识别图片尺寸');
  const scale = Math.min(1, bounds.width / width, bounds.height / height);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export function imageExtension(data: Buffer): string | undefined {
  if (data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return '.png';
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return '.jpg';
  if (/^GIF8[79]a$/.test(data.subarray(0, 6).toString('ascii'))) return '.gif';
  if (data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP') return '.webp';
  if (data.subarray(0, 2).toString() === 'BM') return '.bmp';
  return undefined;
}
export function videoExtension(data: Buffer): string | undefined {
  if (data.length >= 12 && data.subarray(4, 8).toString() === 'ftyp') {
    const brand = data.subarray(8, 12).toString();
    if (brand.startsWith('qt')) return '.mov';
    if (/^(?:isom|iso[2-9]|mp4.|M4V |avc1|MSNV|3g[p2].)$/.test(brand)) return '.mp4';
  }
  if (data.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
    if (data.includes(Buffer.from('matroska'))) return '.mkv';
    if (data.includes(Buffer.from('webm'))) return '.webm';
  }
  if (data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'AVI ') return '.avi';
  if (data.subarray(0, 3).toString() === 'FLV') return '.flv';
}
export class MediaCache {
  private pending = new Map<string, Promise<string>>();
  private active = 0;
  private waiters: (() => void)[] = [];
  constructor(readonly folder: string, private client: OneBotClient) {}
  getFile(ref: FileRef, key: string): Promise<string> {
    const hash = 'file-' + createHash('sha256').update(JSON.stringify([key, ref.id, ref.url])).digest('hex');
    const existing = this.pending.get(hash); if (existing) return existing;
    const task = this.limited(async () => {
      const folder = path.join(this.folder, 'files'); await fs.mkdir(folder, { recursive: true });
      await this.pruneResources(folder).catch(() => {});
      const file = path.join(folder, hash + '.attachment');
      try { if (Date.now() - (await fs.stat(file)).mtimeMs < 7 * 86400000) return file; } catch {}
      const receive = async (url?: string) => {
        if (!url || !/^https?:\/\//i.test(url)) throw new Error('NapCat 未提供可下载的文件地址');
        await downloadFile(url, file, AbortSignal.timeout(30 * 60 * 1000));
      };
      try { await receive(ref.url); }
      catch (error) {
        if (!ref.id || !this.client.connected) throw error;
        const chat = splitKey(key);
        const result = await this.client.call(chat.type === 'group' ? 'get_group_file_url' : 'get_private_file_url', {
          file_id: ref.id, ...(chat.type === 'group' ? { group_id: chat.id, busid: ref.busid } : { user_id: chat.id })
        });
        await receive(result?.url);
      }
      return file;
    });
    this.pending.set(hash, task);
    void task.then(() => this.pending.delete(hash), () => this.pending.delete(hash)); return task;
  }
  getVideo(ref: VideoRef): Promise<string> {
    const key = 'video-' + createHash('sha256').update(JSON.stringify([ref.file, ref.url])).digest('hex');
    const existing = this.pending.get(key); if (existing) return existing;
    const task = this.limited(async () => {
      const folder = path.join(this.folder, 'videos'); await fs.mkdir(folder, { recursive: true });
      await this.pruneResources(folder).catch(() => {});
      for (const ext of ['.mp4', '.mov', '.webm', '.mkv', '.avi', '.flv']) {
        const file = path.join(folder, key + ext);
        try { if (Date.now() - (await fs.stat(file)).mtimeMs < 7 * 86400000) return file; } catch {}
      }
      const temporary = path.join(folder, key + '.download');
      const receive = async (url?: string) => {
        if (!url || !/^https?:\/\//i.test(url)) throw new Error('NapCat 未提供可下载的视频地址');
        await downloadFile(url, temporary, AbortSignal.timeout(30 * 60 * 1000));
      };
      try {
        try { await receive(ref.url); }
        catch (error) {
          if (!ref.file || !this.client.connected) throw error;
          const info = await this.client.call('get_file', { file_id: ref.file }, 120000);
          await receive(info?.url);
        }
        const handle = await fs.open(temporary, 'r'), header = Buffer.alloc(4096);
        let count: number; try { count = (await handle.read(header, 0, header.length, 0)).bytesRead; } finally { await handle.close(); }
        const ext = videoExtension(header.subarray(0, count));
        if (!ext) throw new Error('下载内容不是受支持的视频');
        const file = path.join(folder, key + ext); await fs.rename(temporary, file); return file;
      } finally { await fs.unlink(temporary).catch(() => {}); }
    });
    this.pending.set(key, task);
    void task.then(() => this.pending.delete(key), () => this.pending.delete(key)); return task;
  }
  get(ref: ImageRef): Promise<string> {
    const key = createHash('sha256').update(ref.file || ref.url || '').digest('hex');
    let task = this.pending.get(key);
    if (!task) {
      task = this.limited(() => this.resolve(key, ref)).finally(() => this.pending.delete(key));
      this.pending.set(key, task);
    }
    return task;
  }
  private async limited<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active >= 4) await new Promise<void>(resolve => this.waiters.push(resolve));
    else this.active++;
    try { return await operation(); }
    finally { const next = this.waiters.shift(); if (next) next(); else this.active--; }
  }
  private async resolve(key: string, ref: ImageRef): Promise<string> {
    await fs.mkdir(this.folder, { recursive: true });
    for (const ext of ['.png', '.jpg', '.gif', '.webp', '.bmp']) {
      const file = path.join(this.folder, key + ext);
      try { const s = await fs.stat(file); if (Date.now() - s.mtimeMs < 7 * 86400000) return file; } catch {}
    }
    let bytes: Buffer | undefined;
    if (ref.url) { try { bytes = await this.download(ref.url); } catch {} }
    if (!bytes && ref.file && this.client.connected) {
      const result = await this.client.call('get_image', { file: ref.file });
      if (typeof result?.url === 'string') bytes = await this.download(result.url);
    }
    if (!bytes) throw new Error('图片暂时无法获取，地址可能已过期；请稍后重试');
    const ext = imageExtension(bytes);
    if (!ext) throw new Error('图片格式暂不支持');
    const file = path.join(this.folder, key + ext);
    await fs.writeFile(file, bytes);
    await this.prune().catch(() => {}); return file;
  }
  private async download(value: string): Promise<Buffer> {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol)) throw new Error('图片地址无效');
    const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!response.ok || !response.body) throw new Error('图片下载失败');
    const max = 16 * 1024 * 1024;
    if (Number(response.headers.get('content-length')) > max) { await response.body.cancel(); throw new Error('图片超过 16 MB'); }
    const reader = response.body.getReader(); const parts: Buffer[] = []; let size = 0;
    try {
      while (true) {
        const { done, value: chunk } = await reader.read(); if (done) break;
        size += chunk.byteLength;
        if (size > max) throw new Error('图片超过 16 MB');
        parts.push(Buffer.from(chunk));
      }
    } finally { await reader.cancel().catch(() => {}); }
    const bytes = Buffer.concat(parts);
    if (!imageExtension(bytes)) throw new Error('响应不是受支持的图片');
    return bytes;
  }
  private async pruneResources(folder: string): Promise<void> {
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const file = path.join(folder, entry.name);
      if (Date.now() - (await fs.stat(file)).mtimeMs >= 7 * 86400000) await fs.unlink(file);
    }
  }
  private async prune(): Promise<void> {
    const files = (await Promise.all((await fs.readdir(this.folder)).map(async name => {
      const file = path.join(this.folder, name); const stat = await fs.stat(file); return { file, size: stat.size, time: stat.mtimeMs, regular: stat.isFile() };
    }))).filter(file => file.regular);
    let total = files.reduce((n, f) => n + f.size, 0);
    for (const file of files.sort((a,b) => a.time - b.time)) {
      if (total <= 128 * 1024 * 1024 && Date.now() - file.time < 7 * 86400000) break;
      await fs.unlink(file.file).catch(() => {}); total -= file.size;
    }
  }
}
