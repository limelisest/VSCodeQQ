import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { isNapCatEventTimeout } from './requestFailure';

export class OneBotRequestError extends Error {
  constructor(readonly kind: 'rejected' | 'timeout' | 'disconnected' | 'transport', message: string) { super(message); }
}
interface Pending { action: string; resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout; }
export class OneBotClient extends EventEmitter {
  private socket?: WebSocket;
  private pending = new Map<string, Pending>();
  private sequence = 0;
  private retry?: NodeJS.Timeout;
  private watchdog?: NodeJS.Timeout;
  private stopped = true;
  private attempts = 0;
  private lastReceived = 0;
  private url = '';
  private token = '';
  constructor(private readonly retryBase = 1000) { super(); }
  get connected(): boolean { return this.socket?.readyState === WebSocket.OPEN; }
  async connect(url: string, token = ''): Promise<void> {
    const parsed = new URL(url);
    if (!['ws:', 'wss:'].includes(parsed.protocol)) throw new Error('地址必须以 ws:// 或 wss:// 开头');
    this.disconnect();
    this.url = url; this.token = token; this.stopped = false; this.attempts = 0;
    return this.open();
  }
  private open(): Promise<void> {
    return new Promise((resolve, reject) => {
      let opened = false;
      const ws = new WebSocket(this.url, { headers: this.token ? { Authorization: `Bearer ${this.token}` } : {}, handshakeTimeout: 10000, maxPayload: 0 });
      this.socket = ws;
      ws.on('open', () => {
        if (this.socket !== ws) { ws.terminate(); return; }
        opened = true; this.attempts = 0; this.lastReceived = Date.now();
        this.watchdog = setInterval(() => {
          if (Date.now() - this.lastReceived > 90000) ws.terminate();
          else if (ws.readyState === WebSocket.OPEN) ws.ping();
        }, 30000);
        this.emit('connected'); resolve();
      });
      ws.on('pong', () => { this.lastReceived = Date.now(); });
      ws.on('message', raw => {
        if (this.socket !== ws) return;
        this.lastReceived = Date.now();
        let data: any;
        try { data = JSON.parse(raw.toString()); } catch { return; }
        if (!data || typeof data !== 'object') return;
        if (data.echo != null) {
          const echo = String(data.echo); const pending = this.pending.get(echo);
          if (!pending) return;
          this.pending.delete(echo); clearTimeout(pending.timer);
          if (data.status === 'failed' || (data.retcode != null && Number(data.retcode) !== 0)) {
            let detail = [...new Set([data.message, data.wording].filter((v): v is string => typeof v === 'string' && !!v.trim()))].join('；');
            const kind = isNapCatEventTimeout(detail) ? 'timeout' : 'rejected';
            if (this.token) detail = detail.split(this.token).join('[已隐藏 Token]');
            detail = detail.replace(/[\r\n]+/g, ' ').slice(0, 1000);
            pending.reject(new OneBotRequestError(kind, `NapCat ${pending.action} 请求失败 (${Number(data.retcode) || 'failed'})${detail ? `：${detail}` : ''}`));
          }
          else pending.resolve(data.data);
        } else if (data.post_type) this.emit('event', data);
      });
      ws.on('error', () => { if (!opened) reject(new Error('无法连接 NapCat，请检查地址、Token 和 OneBot WebSocket 服务')); });
      ws.on('close', () => {
        if (!opened) reject(new Error('NapCat 连接已关闭'));
        if (this.socket !== ws) return;
        this.socket = undefined; clearInterval(this.watchdog); this.watchdog = undefined;
        this.failPending(); this.emit('disconnected');
        if (!this.stopped) {
          const delay = Math.min(30000, this.retryBase * 2 ** this.attempts++);
          this.retry = setTimeout(() => { this.retry = undefined; void this.open().catch(() => {}); }, delay);
        }
      });
    });
  }
  call<T = any>(action: string, params: Record<string, unknown> = {}, timeout = 15000): Promise<T> {
    const ws = this.socket;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new OneBotRequestError('disconnected', 'NapCat 未连接'));
    const echo = `qq-${++this.sequence}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(echo); reject(new OneBotRequestError('timeout', `NapCat 请求超时：${action}`)); }, timeout);
      this.pending.set(echo, { action, resolve, reject, timer });
      ws.send(JSON.stringify({ action, params, echo }), error => {
        if (error) { clearTimeout(timer); this.pending.delete(echo); reject(new OneBotRequestError('transport', 'NapCat 消息发送失败')); }
      });
    });
  }
  private failPending(): void {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new OneBotRequestError('disconnected', 'NapCat 连接中断')); }
    this.pending.clear();
  }
  disconnect(): void {
    this.stopped = true; clearTimeout(this.retry); clearInterval(this.watchdog);
    this.retry = undefined; this.watchdog = undefined;
    const ws = this.socket; this.socket = undefined;
    this.failPending();
    if (ws) { ws.terminate(); this.emit('disconnected'); }
  }
  dispose(): void { this.disconnect(); this.removeAllListeners(); }
}
