import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { AttachmentFiles } from './attachments';
import { Attachment } from './model';
import { MediaCache } from './media';

const imagePath = (value: string) => /\.(?:png|jpe?g|gif|webp|bmp)(?:[?#]|$)/i.test(value);
const imageUrl = (value: string) => /^https?:\/\//i.test(value) && imagePath(value);
const videoUrl = (value: string) => /^https?:\/\//i.test(value) && /\.(?:mp4|mov|webm|mkv|avi|flv)(?:[?#]|$)/i.test(value);
export function localResource(value: string): vscode.Uri | undefined {
  value = value.trim().replace(/^"(.*)"$/, '$1');
  if (/^(?:[a-z]:[\\/]|\\\\)/i.test(value) || value.startsWith('/')) return vscode.Uri.file(value);
  if (/^file:/i.test(value)) return vscode.Uri.parse(value);
}

export async function transferFiles(data: vscode.DataTransfer, files: AttachmentFiles, media: MediaCache | undefined,
  check: () => void): Promise<Attachment[]> {
  check();
  const resources = new Map<string, vscode.Uri>();
  const identity = (uri: vscode.Uri) => process.platform === 'win32' ? uri.toString().toLowerCase() : uri.toString();
  const add = (uri: vscode.Uri) => { resources.set(identity(uri), uri); };
  const external = new Map<vscode.DataTransferFile, vscode.DataTransferFile>();
  const fileData = new Map<string, vscode.DataTransferFile>();
  const entries: { mime: string; file: vscode.DataTransferFile }[] = [];
  const captured = new Map<vscode.DataTransferFile, Promise<{ bytes: Uint8Array } | { error: unknown }>>();
  const capture = (file: vscode.DataTransferFile) => {
    let result = captured.get(file);
    if (!result) {
      try { result = Promise.resolve(file.data()).then(bytes => ({ bytes }), error => ({ error })); }
      catch (error) { result = Promise.resolve({ error }); }
      captured.set(file, result);
    }
    return result;
  };
  // External apps can expose short-lived File handles. Start reading before any
  // asynchronous metadata lookup; keep disk paths first when choosing the source.
  for (const [mime, item] of data) {
    const file = item.asFile(); if (!file) continue;
    entries.push({ mime, file });
    if (!file.uri || mime.startsWith('image/') || imagePath(file.name)) capture(file);
  }
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
      // A missing image path is a failed image import, not ordinary draft text.
      if (existing.every(Boolean) || uris.every(uri => imagePath(uri.path))) uris.forEach(add);
    }
  }
  for (const { file } of entries) {
    if (file.uri) {
      const uri = /^[a-z]$/i.test(file.uri.scheme) ? vscode.Uri.file(file.uri.scheme + ':' + file.uri.path) : file.uri;
      add(uri); fileData.set(identity(uri), file);
    } else if (!external.has(file)) external.set(file, file);
  }
  const isImageResource = (uri: vscode.Uri) => imagePath(uri.path) || entries.some(({ mime, file }) =>
    file === fileData.get(identity(uri)) && (mime.startsWith('image/') || imagePath(file.name)));
  const imageOnly = external.size > 0 && entries.filter(({ file }) => !file.uri)
    .every(({ mime, file }) => mime.startsWith('image/') || imagePath(file.name));
  const png = entries.find(entry => entry.mime === 'image/png')?.file;
  const singleImage = imageOnly && (external.size === 1 || !!png && !png.uri);
  const raw = [...external.values()];
  if (singleImage && png && !png.uri) raw.sort((a, b) => Number(b === png) - Number(a === png));
  // HTML is another representation of the same image, even when the native
  // File exists but its backing temporary file has already disappeared.
  let htmlImage: string | undefined;
  if (resources.size <= 1 && (!resources.size || singleImage || isImageResource([...resources.values()][0]))) {
    const html = await data.get('text/html')?.asString();
    const matches = html ? [...html.matchAll(/<img\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)] : [];
    if (matches.length === 1) htmlImage = (matches[0][1] || matches[0][2] || matches[0][3]).replace(/&amp;/g, '&');
  }
  const staged: Attachment[] = [];
  try {
    const stageData = async (file: vscode.DataTransferFile) => {
      check(); const result = await capture(file); check();
      if ('error' in result) throw result.error;
      return files.stageAuto(Buffer.from(result.bytes), file.name || '粘贴的图片');
    };
    const stageUri = async (uri: vscode.Uri): Promise<Attachment> => {
      check();
      if (uri.scheme === 'file') return files.stageAutoPath(uri.fsPath, path.basename(uri.fsPath));
      if (media && /^https?$/.test(uri.scheme)) {
        if (videoUrl(uri.toString())) {
          const video = await media.getVideo({ file: '', url: uri.toString() }); check();
          return files.stageAutoPath(video, '拖入的视频' + path.extname(video));
        }
        const image = await media.get({ file: '', url: uri.toString() }); check();
        return files.stage(await fs.readFile(image), '拖入的图片');
      }
      const file = fileData.get(identity(uri));
      if (file) return stageData(file);
      throw new Error('无法读取拖入的附件');
    };
    const stageHtml = htmlImage ? async () => {
      check();
      const inline = /^data:image\/[a-z0-9.+-]+;base64,([a-z0-9+/=\s]+)$/i.exec(htmlImage);
      if (inline) return files.stage(Buffer.from(inline[1], 'base64'), '粘贴的图片');
      const uri = localResource(htmlImage!) ?? (/^https?:\/\//i.test(htmlImage!) ? vscode.Uri.parse(htmlImage!) : undefined);
      if (uri) return stageUri(uri);
      throw new Error('无法读取拖入的图片来源');
    } : undefined;
    const attempt = async (sources: (() => Promise<Attachment>)[]) => {
      let failure: unknown;
      for (const source of sources) {
        check();
        try { return await source(); } catch (error) { check(); failure = error; }
      }
      throw failure;
    };
    const alternate = resources.size === 1 && singleImage;
    for (const uri of resources.values()) {
      const candidates = [() => stageUri(uri)];
      const file = fileData.get(identity(uri));
      if (file) candidates.push(() => stageData(file));
      if (alternate || resources.size === 1 && isImageResource(uri)) {
        if (stageHtml) candidates.push(stageHtml);
        if (alternate) candidates.push(...raw.map(file => () => stageData(file)));
      }
      staged.push(await attempt(candidates));
    }
    if (!resources.size && (singleImage || !raw.length && stageHtml)) {
      const candidates = [...(stageHtml ? [stageHtml] : []), ...raw.map(file => () => stageData(file))];
      staged.push(await attempt(candidates));
    } else if (!alternate) for (const file of raw) staged.push(await stageData(file));
    check(); return staged;
  } catch (error) { await files.discard(staged); throw error; }
}
