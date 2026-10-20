import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface CacheInfo { bytes: number; count: number; reclaimableBytes?: number; protectedBytes?: number; categories?: { name: string; bytes: number; count: number }[]; folder?: string; ready?: boolean; }
const categories = [{ folder: 'outgoing', name: '发送附件' }, { folder: 'images', name: '接收图片、文件与视频' }, { folder: 'recent-emojis', name: '最近使用表情' }];
export class CacheManagement {
  constructor(readonly folder: string, private references: () => Promise<Set<string>>, private current = () => true) {}
  private async entries() {
    const result: { file: string; size: number; time: number; category: string; keep: boolean }[] = [];
    const scan = async (folder: string, category: string, keep: boolean): Promise<void> => {
      for (const entry of await fs.readdir(folder, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; })) {
        const file = path.join(folder, entry.name);
        if (entry.isDirectory()) await scan(file, category, keep);
        else if (entry.isFile()) { try { const stat = await fs.lstat(file); if (stat.isFile()) result.push({ file, size: stat.size, time: stat.mtimeMs, category, keep: keep || /\.(download|tmp)$/.test(file) }); } catch (error: any) { if (error.code !== 'ENOENT') throw error; } }
      }
    };
    for (const category of categories) await scan(path.join(this.folder, category.folder), category.name, category.folder === 'recent-emojis');
    return result;
  }
  async info(): Promise<CacheInfo> {
    const entries = await this.entries(), refs = await this.references();
    const protectedFile = (entry: typeof entries[number]) => entry.keep || refs.has(path.resolve(entry.file)) || Date.now() - entry.time < 3600000;
    const protectedBytes = entries.filter(protectedFile).reduce((n, entry) => n + entry.size, 0), bytes = entries.reduce((n, entry) => n + entry.size, 0);
    return { bytes, count: entries.length, protectedBytes, reclaimableBytes: bytes - protectedBytes, folder: this.folder, ready: this.current(), categories: categories.map(category => ({ name: category.name, bytes: entries.filter(e => e.category === category.name).reduce((n, entry) => n + entry.size, 0), count: entries.filter(e => e.category === category.name).length })) };
  }
  async clean(retentionDays: number): Promise<number> {
    const entries = await this.entries(), refs = await this.references(); let bytes = 0;
    for (const entry of entries) {
      if (!this.current()) break;
      if (entry.keep || refs.has(path.resolve(entry.file)) || Date.now() - entry.time < Math.max(1 / 24, retentionDays) * 86400000) continue;
      try { const stat = await fs.lstat(entry.file); if (!this.current()) break; if (!stat.isFile() || stat.mtimeMs !== entry.time) continue; await fs.unlink(entry.file); bytes += stat.size; }
      catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    }
    return bytes;
  }
}
