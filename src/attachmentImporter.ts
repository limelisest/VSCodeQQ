import * as vscode from 'vscode';
import * as path from 'node:path';
import * as os from 'node:os';
import { Attachment } from './model';
import { AttachmentFiles } from './attachments';
import { ChatStore } from './store';
export function selectAttachmentFiles(title: string, filters?: Record<string, string[]>): Thenable<vscode.Uri[] | undefined> {
  return vscode.window.showOpenDialog({ defaultUri: vscode.Uri.file(os.homedir()), canSelectFiles: true, canSelectFolders: false, canSelectMany: true, title, filters });
}
interface Host {
  store?: ChatStore; attachments?: AttachmentFiles;
  attachToDraft(key: string, attachments: Attachment[]): Promise<void>;
}
export class AttachmentImporter {
  constructor(private host: Host) {}
  async selectImages(key: string): Promise<void> {
    const store = this.host.store;
    const uris = await selectAttachmentFiles('选择要发送的图片', { '图片': ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] });
    if (!uris?.length || store !== this.host.store) return;
    const files = this.host.attachments; if (!files) return;
    const staged: Attachment[] = [];
    try {
      for (const uri of uris) {
        const attachment = await files.stageAutoPath(uri.fsPath, path.basename(uri.fsPath));
        staged.push(attachment);
        if (attachment.kind !== 'image') throw new Error('请选择 PNG、JPEG、GIF、WebP 或 BMP 图片');
      }
      if (store !== this.host.store) throw new Error('账号已切换，请重新导入');
      await this.host.attachToDraft(key, staged);
    } catch (error) { await files.discard(staged); throw error; }
  }
  async pasteImage(key: string, base64: string): Promise<void> {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new Error('剪贴板图片格式无效');
    await this.stageImages(key, [async () => ({ bytes: Buffer.from(base64, 'base64'), label: '粘贴的图片' })]);
  }
  private async stageImages(key: string, sources: (() => Promise<{bytes: Buffer; label: string}>)[]): Promise<void> {
    const store = this.host.store, files = this.host.attachments;
    if (!store?.chats.has(key) || !files) return;
    const staged: Attachment[] = [];
    try {
      for (const source of sources) { const {bytes, label} = await source(); staged.push(await files.stage(bytes, label)); }
      if (store !== this.host.store) throw new Error('账号已切换，请重新导入');
      await this.host.attachToDraft(key, staged);
    } catch (error) { await files.discard(staged); throw error; }
  }
}
