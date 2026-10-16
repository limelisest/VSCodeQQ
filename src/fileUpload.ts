import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { OneBotClient } from './onebot';
import { Message } from './model';

// Bounded memory: only one 512 KiB chunk is encoded at a time. No plugin file-size cap.
export async function uploadToNapCat(client: OneBotClient, source: string,
  progress: (value: NonNullable<Message['sendProgress']>) => void, check: () => void = () => {}, onChunk?: (bytes: Buffer) => void): Promise<string> {
  const handle = await fs.open(source, 'r');
  try {
    const { size } = await handle.stat();
    if (!size) throw new Error('不能发送空文件');
    const extension = path.extname(source).toLowerCase();
    const suffix = ['.mp4', '.mov', '.webm', '.mkv', '.avi', '.flv', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'].includes(extension) ? extension : '.attachment';
    const stream_id = randomUUID(), chunkSize = 512 * 1024, total_chunks = Math.ceil(size / chunkSize);
    const buffer = Buffer.allocUnsafe(chunkSize);
    let sent = 0; const started = Date.now();
    progress({ stage: 'upload', sent, total: size });
    for (let index = 0; index < total_chunks; index++) {
      check();
      const length = Math.min(chunkSize, size - sent);
      let filled = 0;
      while (filled < length) {
        const { bytesRead } = await handle.read(buffer, filled, length - filled, sent + filled);
        if (!bytesRead) throw new Error('附件在上传时发生变化，请重新导入');
        filled += bytesRead;
      }
      check();
      onChunk?.(buffer.subarray(0, length));
      const result = await client.call('upload_file_stream', {
        stream_id, chunk_data: buffer.subarray(0, length).toString('base64'), chunk_index: index,
        total_chunks, file_size: size, filename: `qq-${stream_id}${suffix}`, file_retention: 3600000
      }, 120000);
      check();
      if (result?.status !== 'chunk_received' || result.received_chunks !== index + 1) throw new Error('NapCat 未确认文件分片，请检查版本是否支持上传文件流');
      sent += length; progress({ stage: 'upload', sent, total: size, bytesPerSecond: sent / Math.max(0.001, (Date.now() - started) / 1000) });
    }
    check();
    const result = await client.call('upload_file_stream', { stream_id, is_complete: true }, 300000);
    check();
    if (result?.status !== 'file_complete' || typeof result.file_path !== 'string' || !result.file_path || result.file_size !== size) throw new Error('NapCat 文件合并结果不完整');
    progress({ stage: 'confirm', sent, total: size });
    return result.file_path;
  } finally { await handle.close(); }
}
