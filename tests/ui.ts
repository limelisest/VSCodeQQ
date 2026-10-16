import { WebSocket } from 'ws';

// Only the isolated extension-test window exposes this local DevTools port.
export class TestUI {
  private serial = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private constructor(private socket: WebSocket) {
    socket.on('message', bytes => {
      const data = JSON.parse(bytes.toString()), pending = this.pending.get(data.id);
      if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(data.id);
      if (data.error) pending.reject(new Error(data.error.message)); else pending.resolve(data.result);
    });
  }
  static async connect(): Promise<TestUI> {
    const pages = await (await fetch('http://127.0.0.1:19222/json/list')).json() as any[];
    const page = pages.find(p => p.type === 'page' && p.url.includes('workbench'));
    if (!page) throw new Error('未找到独立测试窗口');
    const socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    return new TestUI(socket);
  }
  call(method: string, params: unknown = {}, sessionId?: string): Promise<any> {
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`UI 验证超时：${method}`)); }, 10000);
      this.pending.set(id, { resolve, reject, timer }); this.socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
  async evaluate(expression: string): Promise<any> {
    const result = await this.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error('测试窗口 DOM 检查失败');
    return result.result.value;
  }
  async webview(selector = '#favoriteFaces'): Promise<{ evaluate: (expression: string) => Promise<any>; hover: (selector: string) => Promise<void>; key: (key: string, code: number) => Promise<void> }> {
    const sessions = new Map<string, string>();
    for (let attempt = 0; attempt < 40; attempt++) {
      const { targetInfos } = await this.call('Target.getTargets');
      for (const target of targetInfos.filter((t: any) => t.type === 'iframe')) {
        try {
          let session = sessions.get(target.targetId);
          if (!session) { session = (await this.call('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId; sessions.set(target.targetId, session!); }
          const tree = await this.call('Page.getFrameTree', {}, session);
          const frames = (node: any): any[] => [node.frame, ...(node.childFrames ?? []).flatMap(frames)];
          for (const frame of frames(tree.frameTree)) {
            const world = await this.call('Page.createIsolatedWorld', { frameId: frame.id, worldName: 'qq-test' }, session);
            const evaluate = async (expression: string) => {
              const result = await this.call('Runtime.evaluate', { expression, contextId: world.executionContextId, returnByValue: true, awaitPromise: true }, session);
              if (result.exceptionDetails) throw new Error('表情 Webview DOM 检查失败');
              return result.result.value;
            };
            if (await evaluate(`!!document.querySelector(${JSON.stringify(selector)})`)) return { evaluate, hover: async selector => {
              const point = await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect(); return r?.width ? { x:r.left+r.width/2, y:r.top+r.height/2 } : null; })()`);
              if (!point) throw new Error('未找到要悬停的列表元素');
              await this.call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point }, session);
            }, key: async (key, code) => {
              await this.call('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code: key, windowsVirtualKeyCode: code }, session);
              await this.call('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: code }, session);
            } };
          }
        } catch { /* The inner frame can still be loading. */ }
      }
      await new Promise(r => setTimeout(r, 150));
    }
    throw new Error('未找到表情 Webview 的 DOM');
  }
  private async textPoint(text: string): Promise<{ x: number; y: number }> {
    const point = await this.waitFor(`(() => {
      const root = document.querySelector('.editor-group-container.active .monaco-editor');
      const line = [...(root?.querySelectorAll('.view-line') ?? [])].find(e => e.textContent.replace(/\u00a0/g, ' ').includes(${JSON.stringify(text)}));
      if (!line) return null;
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT), nodes = []; while (walker.nextNode()) nodes.push(walker.currentNode);
      const full = nodes.map(n => n.textContent).join('').replace(/\u00a0/g, ' '), index = full.indexOf(${JSON.stringify(text)}); let offset = 0;
      for (const node of nodes) { if (offset + node.textContent.length > index) { const range = document.createRange(); range.setStart(node, index-offset); range.setEnd(node, index-offset+1); const r = range.getBoundingClientRect(); return r.width ? { x: r.left+r.width/2, y: r.top+r.height/2 } : null; } offset += node.textContent.length; }
    })()`);
    return point;
  }
  async dragText(text: string): Promise<void> {
    const point = await this.textPoint(text), end = { x: point.x + 70, y: point.y };
    await this.call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    await this.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await new Promise(r => setTimeout(r, 50));
    await this.call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...end, button: 'left', buttons: 1 });
    await this.call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...end, button: 'left', clickCount: 1 });
  }
  async clickText(text: string): Promise<void> {
    const point = await this.textPoint(text);
    await this.call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    await this.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await this.call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
  }
  async enter(modifiers = 0): Promise<void> {
    await this.call('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers });
    await this.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers });
  }
  async waitFor(expression: string): Promise<any> {
    for (let i = 0; i < 60; i++) {
      const value = await this.evaluate(expression); if (value) return value;
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error('等待 UI 状态超时');
  }
  close(): void { this.socket.close(); for (const p of this.pending.values()) clearTimeout(p.timer); }
}
