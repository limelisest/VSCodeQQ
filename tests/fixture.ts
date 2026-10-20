import { WebSocketServer, WebSocket } from 'ws';
import { createServer, Server } from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
export const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
export const sendEventTimeout = 'Timeout: NTEvent serviceAndMethod:NodeIKernelMsgService/sendMsg ListenerName:NodeIKernelMsgListener/onMsgInfoListUpdate EventRet: {}';
export const videoBytes = Buffer.from('000000186674797069736f6d0000020069736f6d69736f32', 'hex');
function samplePng(width: number, height: number): Buffer {
  const chunk = (name: string, data: Buffer) => {
    const bytes = Buffer.concat([Buffer.from(name), data]); let crc = 0xffffffff;
    for (const b of bytes) { crc ^= b; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
    const size = Buffer.alloc(4), check = Buffer.alloc(4); size.writeUInt32BE(data.length); check.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([size, bytes, check]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const rows = Buffer.alloc((width * 3 + 1) * height, 160);
  for (let y = 0; y < height; y++) rows[y * (width * 3 + 1)] = 0;
  return Buffer.concat([png.subarray(0, 8), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
export const tallPng = samplePng(128, 2048), widePng = samplePng(2048, 128);
export class MockNapCat {
  server!: WebSocketServer;
  http!: Server;
  url = '';
  imageUrl = '';
  calls: any[] = [];
  strangerNames = new Map<string, string>();
  appName = 'MockNapCat';
  favoriteUrls?: string[];
  favoriteIgnoreCount = false;
  sent: any[] = [];
  sentMessages = new Map<number, any>();
  loginFailures = 0;
  memberFailures = 0;
  memberRoles = new Map<string, string>();
  groupMembers?: Record<string, unknown>[];
  members(groupId: string): Record<string, unknown>[] {
    return (this.groupMembers ?? [{ user_id: 10001, card: '群名片', nickname: '张三', role: 'admin', title: '调试员' }, { user_id: 123456, card: '我的名片', role: 'member' }])
      .map(member => ({ ...member, group_id: groupId, role: this.memberRoles.get(`${groupId}:${member.user_id}`) ?? this.memberRoles.get(String(member.user_id)) ?? member.role }));
  }
  historyExtra: any[] = [];
  sendDelay = 0;
  detailDelay = 0;
  emitSent = true;
  emitSentDelay = 0;
  listDelay = 0;
  listResponses = 0;
  historyDelay = 0;
  historyDelays = new Map<string, number>();
  historyFailures = new Set<string>();
  failSend = false;
  sendFailure?: { retcode: number; message?: string; wording?: string };
  rejectedActions = new Set<string>();
  actionDelays = new Map<string, number>();
  fileUploads: any[] = [];
  fileDelay = 0;
  failFileName = '';
  fileEchoThenReject = false;
  streamDelay = 0;
  streamChunks = new Map<string, Buffer[]>();
  uploadedBytes = new Map<string, Buffer>();
  sequence = 9000;
  rejectedForwardIds = new Set<string>();
  forwardDelay = 0;
  forwardResults = new Map<string, unknown>();
  masks = new Map<string, number | null>([['20001', 1], ['20002', 1]]);
  async start(): Promise<void> {
    this.http = createServer((req, res) => { res.writeHead(200, { 'Content-Type': req.url?.includes('video') ? 'video/mp4' : 'image/png' }); res.end(req.url?.includes('video') ? videoBytes : req.url?.includes('tall') ? tallPng : req.url?.includes('wide') ? widePng : png); });
    await new Promise<void>(resolve => this.http.listen(0, '127.0.0.1', resolve));
    const httpPort = (this.http.address() as any).port;
    this.imageUrl = `http://127.0.0.1:${httpPort}/image.png`;
    this.server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>(resolve => this.server.once('listening', resolve));
    this.url = `ws://127.0.0.1:${(this.server.address() as any).port}`;
    this.server.on('connection', socket => socket.on('message', async bytes => {
      const req = JSON.parse(bytes.toString()); this.calls.push(req);
      const actionDelay = this.actionDelays.get(req.action);
      if (actionDelay) await new Promise(resolve => setTimeout(resolve, actionDelay));
      const respond = (data: unknown, status = 'ok') => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ status, retcode: status === 'ok' ? 0 : 100, data, echo: req.echo })); };
      if (this.rejectedActions.has(req.action)) { respond(null, 'failed'); return; }
      switch (req.action) {
        case 'get_forward_msg':
          if (this.forwardDelay) await new Promise(resolve => setTimeout(resolve, this.forwardDelay));
          if (this.forwardResults.has(req.params.message_id)) { respond(this.forwardResults.get(req.params.message_id)); break; }
          if (this.rejectedForwardIds.has(req.params.message_id)) {
            socket.send(JSON.stringify({ status: 'failed', retcode: 1200, message: 'protocolFallbackLogic: 找不到相关的聊天记录', echo: req.echo }));
            break;
          }
          respond({ messages: req.params.message_id === 'nested-forward' ? [
            { sender: { user_id: 10001, nickname: '嵌套发送者' }, time: 1700000000, content: [{ type: 'text', data: { text: '嵌套转发正文' } }] }
          ] : [
            { sender: { user_id: 10001, nickname: '转发发送者' }, time: 1700000000, content: [{ type: 'text', data: { text: '合并转发正文' } }, { type: 'image', data: { file: 'forward-image', url: this.imageUrl } }, { type: 'forward', data: { id: 'nested-forward', content: [] } }] }
          ] }); break;
        case 'forward_group_single_msg': case 'forward_friend_single_msg': case 'send_group_forward_msg': case 'send_private_forward_msg': respond({ message_id: 99001 }); break;
        case 'get_status': respond({ online: true, good: true }); break;
        case 'get_version_info': respond({ app_name: this.appName, app_version: 'test', protocol_version: 'v11' }); break;
        case 'can_send_image': case 'can_send_record': respond({ yes: true }); break;
        case 'get_group_info': respond({ group_id: req.params.group_id, group_name: '原生界面验证群', member_count: 2 }); break;
        case 'get_group_root_files': respond({ files: [], folders: [{ folder_id: 'mock-folder', folder_name: '测试文件夹' }] }); break;
        case 'get_group_files_by_folder': respond({ files: [{ file_id: 'mock-file', file_name: '测试文件.txt', file_size: 100, busid: 102 }], folders: [] }); break;
        case 'get_csrf_token': respond({ token: 'mock-sensitive-value' }); break;
        case 'get_login_info': if (this.loginFailures-- > 0) { respond(null, 'failed'); break; } respond({ user_id: 123456, nickname: '测试账号' }); break;
        case 'get_stranger_info': respond({ user_id: req.params.user_id, nickname: this.strangerNames.get(String(req.params.user_id)) ?? String(req.params.user_id) }); break;
        case 'get_friend_list': if (this.listDelay) await new Promise(r => setTimeout(r, this.listDelay)); this.listResponses++; respond([{ user_id: 10001, nickname: '张三', remark: '测试好友' }]); break;
        case 'get_group_list': if (this.listDelay) await new Promise(r => setTimeout(r, this.listDelay)); this.listResponses++; respond([{ group_id: 20001, group_name: '原生界面验证群' }, { group_id: 20002, group_name: '另一个会话' }]); break;
        case 'get_group_detail_info': respond({ cmdUinMsgMask: this.masks.get(String(req.params.group_id)) }); break;
        case 'get_group_member_list': if (this.memberFailures-- > 0) { respond(null, 'failed'); break; } respond(this.members(String(req.params.group_id))); break;
        case 'get_group_member_info': respond(this.members(String(req.params.group_id)).find(member => String(member.user_id) === String(req.params.user_id)) ?? null); break;
        case 'get_group_msg_history': case 'get_friend_msg_history': {
          const chat = String(req.params.group_id ?? req.params.user_id);
          const delay = this.historyDelays.get(chat) ?? this.historyDelay;
          if (delay) await new Promise(resolve => setTimeout(resolve, delay));
          if (this.historyFailures.has(chat)) { respond(null, 'failed'); break; }
          respond({ messages: [...this.history(), ...this.historyExtra] }); break;
        }
        case 'get_image': respond({ url: this.imageUrl }); break;
        case 'fetch_custom_face': {
          const faces = this.favoriteUrls ?? [this.imageUrl, this.imageUrl + '?second'];
          respond(this.favoriteIgnoreCount ? faces : faces.slice(0, Number(req.params.count) || 48)); break;
        }
        case 'get_msg':
          if (this.detailDelay) await new Promise(resolve => setTimeout(resolve, this.detailDelay));
          respond(this.sentMessages.get(Number(req.params.message_id))); break;
        case 'upload_file_stream': {
          if (this.streamDelay) await new Promise(resolve => setTimeout(resolve, this.streamDelay));
          const p = req.params;
          if (p.is_complete) {
            const chunks = this.streamChunks.get(p.stream_id)!;
            if (!chunks) { respond(null, 'failed'); break; }
            const file_path = '/napcat/temp/' + p.stream_id;
            const bytes = Buffer.concat(chunks); this.uploadedBytes.set(file_path, bytes);
            this.streamChunks.delete(p.stream_id);
            respond({ type: 'response', status: 'file_complete', file_path, file_size: bytes.length });
          } else {
            const chunks = this.streamChunks.get(p.stream_id) ?? [];
            chunks[p.chunk_index] = Buffer.from(p.chunk_data, 'base64'); this.streamChunks.set(p.stream_id, chunks);
            respond({ type: 'stream', status: 'chunk_received', received_chunks: chunks.filter(Boolean).length, total_chunks: p.total_chunks });
          }
          break;
        }
        case 'upload_group_file': case 'upload_private_file': {
          this.fileUploads.push({ action: req.action, ...req.params });
          if (this.fileDelay) await new Promise(resolve => setTimeout(resolve, this.fileDelay));
          if (req.params.name === this.failFileName) respond(null, 'failed');
          else {
            const file_id = 'mock-file-' + this.fileUploads.length;
            const event = { ...this.message(++this.sequence), post_type: 'message_sent', message_type: req.action === 'upload_group_file' ? 'group' : 'private', group_id: req.params.group_id, target_id: req.params.user_id, user_id: 123456, sender: { user_id: 123456, nickname: '我' }, message: [{ type: 'file', data: { file_id, file: req.params.name, file_size: this.uploadedBytes.get(req.params.file)?.length } }] };
            this.emit(event); respond({ file_id }, this.fileEchoThenReject ? 'failed' : 'ok');
          }
          break;
        }
        case 'send_msg': {
          this.sent.push(req.params);
          if (this.sendDelay) await new Promise(resolve => setTimeout(resolve, this.sendDelay));
          if (this.failSend) { respond(null, 'failed'); break; }
          const message_id = ++this.sequence;
          const message = req.params.message.map((s: any) => {
            if (!['image', 'video'].includes(s.type)) return s;
            const source = s.data.file;
            const bytes = source.startsWith('base64://') ? Buffer.from(source.slice(9), 'base64') : this.uploadedBytes.get(source);
            const digest = bytes ? createHash('md5').update(bytes).digest('hex') : `sent-${message_id}`;
            return { type: s.type, data: { file: `${digest}.${s.type === 'image' ? 'png' : 'mp4'}`, url: this.imageUrl } };
          });
          const event = { ...this.message(message_id), post_type: 'message_sent', message_type: req.params.message_type, group_id: req.params.group_id, target_id: req.params.user_id, user_id: 123456, sender: { user_id: 123456, nickname: '我' }, message };
          this.sentMessages.set(message_id, event);
          if (this.emitSent) {
            if (this.emitSentDelay) setTimeout(() => this.emit(event), this.emitSentDelay);
            else this.emit(event);
          }
          if (this.sendFailure) {
            if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ status: 'failed', ...this.sendFailure, data: null, echo: req.echo }));
          } else respond({ message_id });
          break;
        }
        case 'timeout': break;
        case 'disconnect': socket.close(); break;
        default: respond(req.params);
      }
    }));
  }
  message(message_id = 501, text = '实时消息'): any {
    return { post_type: 'message', self_id: 123456, message_type: 'group', group_id: 20001, message_id, time: Math.floor(Date.now()/1000), user_id: 10001, sender: { user_id: 10001, nickname: '张三' }, message: [{ type: 'text', data: { text } }] };
  }
  history(): any[] {
    const base = Math.floor(Date.now()/1000) - 180;
    const messages = Array.from({ length: 60 }, (_, i) => ({ ...this.message(1000 + i, i === 0 ? '第一条历史记录' : `消息 ${i}：原生编辑器主题、行号和选择行为。`), time: base + i }));
    messages.push({ ...this.message(1200), time: base + 65, message: [{ type: 'reply', data: { id: '1000' } }, { type: 'text', data: { text: '结果如下：' } }, { type: 'image', data: { file: 'fixture.png', url: this.imageUrl } }, { type: 'text', data: { text: '\n第二行保持原文。' } }] });
    return messages;
  }
  emit(event: unknown): void { for (const socket of this.server.clients) if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event)); }
  async close(): Promise<void> {
    for (const socket of this.server.clients) socket.terminate();
    await Promise.all([
      new Promise<void>(resolve => this.server.close(() => resolve())),
      new Promise<void>(resolve => this.http.close(() => resolve()))
    ]);
  }
}
export async function until(check: () => boolean | Promise<boolean>, timeout = 8000): Promise<void> {
  const end = Date.now() + timeout;
  while (!await check()) { if (Date.now() > end) throw new Error('等待条件超时'); await new Promise(resolve => setTimeout(resolve, 30)); }
}
