import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { AttachmentFiles } from './attachments';
import { Attachment } from './model';
import { MediaCache } from './media';

const imageUrl = (value: string) => /^https?:\/\//i.test(value) && /\.(?:png|jpe?g|gif|webp|bmp)(?:[?#]|$)/i.test(value);
const videoUrl = (value: string) => /^https?:\/\//i.test(value) && /\.(?:mp4|mov|webm|mkv|avi|flv)(?:[?#]|$)/i.test(value);
export function localResource(value: string): vscode.Uri | undefined {
  value = value.trim().replace(/^"(.*)"$/, '$1');
  if (/^(?:[a-z]:[\\/]|\\\\)/i.test(value) || value.startsWith('/')) return vscode.Uri.file(value);
  if (/^file:/i.test(value)) return vscode.Uri.parse(value);
}

export async function transferFiles(data: vscode.DataTransfer, files: AttachmentFiles, media: MediaCache | undefined,
  check: () => void): Promise<Attachment[]> {
  const resources = new Map<string, vscode.Uri>();
  const add = (uri: vscode.Uri) => { resources.set(process.platform === 'win32' ? uri.toString().toLowerCase() : uri.toString(), uri); };
  const uriList = data.get('text/uri-list');
  if (uriList) for (const value of (await uriList.asString()).split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#'))) {
    const uri = localResource(value);
    if (uri) add(uri); else if (imageUrl(value) || videoUrl(value)) add(vscode.Uri.parse(value));
  }
  if (!resources.size) {
    const plain = await data.get('text/plain')?.asString();
    const values = plain?.trim().split(/\r?\n/).filter(Boolean) ?? [];
    if (values.length && values.every(value => !!localResource(value))) {
      const uris = values.map(value => localResource(value)!);
      const existing = await Promise.all(uris.map(uri => fs.stat(uri.fsPath).then(stat => stat.isFile(), () => false)));
      if (existing.every(Boolean)) uris.forEach(add);
    }
  }
  const external = new Map<vscode.DataTransferFile, vscode.DataTransferFile>();
  for (const [, item] of data) {
    const file = item.asFile(); if (!file) continue;
    if (file.uri) {
      const uri = /^[a-z]$/i.test(file.uri.scheme) ? vscode.Uri.file(file.uri.scheme + ':' + file.uri.path) : file.uri;
      add(uri);
    } else if (!external.has(file)) external.set(file, file);
  }
  // A browser may supply only HTML plus the image URL, with no OS file entry.
  if (!resources.size && !external.size) {
    const html = await data.get('text/html')?.asString();
    const match = html && /<img\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(html);
    const url = match && (match[1] || match[2] || match[3]).replace(/&amp;/g, '&');
    if (url && /^https?:\/\//i.test(url)) add(vscode.Uri.parse(url));
  }
  if (resources.size + external.size > 8) throw new Error('每条消息最多附带 8 个附件');
  const staged: Attachment[] = [];
  try {
    for (const uri of resources.values()) {
      check();
      if (uri.scheme === 'file') staged.push(await files.stageAutoPath(uri.fsPath, path.basename(uri.fsPath)));
      else if (media && /^https?:$/.test(uri.scheme + ':')) {
        if (videoUrl(uri.toString())) {
          const video = await media.getVideo({ file: '', url: uri.toString() }); check();
          staged.push(await files.stageAutoPath(video, '拖入的视频' + path.extname(video))); continue;
        }
        const image = await media.get({ file: '', url: uri.toString() }); check();
        staged.push(await files.stage(await fs.readFile(image), '拖入的图片'));
      }
    }
    // Raw image formats are usually alternative encodings of one clipboard image.
    const png = data.get('image/png')?.asFile();
    const raw = !resources.size && png && [...data].filter(([, item]) => item.asFile()).every(([mime]) => mime.startsWith('image/')) ? [png] : [...external.values()];
    for (const file of raw) { check(); staged.push(await files.stageAuto(Buffer.from(await file.data()), file.name || '粘贴的图片')); }
    check(); return staged;
  } catch (error) { await files.discard(staged); throw error; }
}
