import { chatSettings, languageLabels, validateChatSettings } from './settingsSchema';
import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { Configuration, validateUrl } from './configuration';
import { OneBotClient } from './onebot';
import { codeLanguages, isCodeLanguage } from './codeStyle';

export class ConnectionSettings implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private busy = false;
  private probe?: OneBotClient;
  constructor(private context: vscode.ExtensionContext, private config: Configuration, private connect: () => Promise<void>, private cacheInfo: () => Promise<{ bytes: number; count: number }>, private cleanCache: () => Promise<number>) {}
  async state() {
    return { ...this.config.chatOptions(), cache: await this.cacheInfo(), url: this.config.url, hasToken: !!await this.config.token(), autoConnect: vscode.workspace.getConfiguration('qq').get('autoConnect', true) };
  }
  open(): void {
    if (this.panel) { this.panel.reveal(); return; }
    const panel = vscode.window.createWebviewPanel('qq.connectionSettings', 'QQ · 连接设置', vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')] });
    this.panel = panel;
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'qq-chat.svg');
    const nonce = randomBytes(24).toString('hex');
    const asset = (name: string) => panel.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', name)).toString();
    panel.webview.html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${asset('settings.css')}"></head><body>
      <div class="settings-container">
        <header class="header">
          <div class="header-main">
            <h1>QQ 设置</h1>
            <p class="subtitle">基于 OneBot v11 协议 · 原生编辑器聊天客户端（支持 NapCat、Lagrange、LLOneBot 等）</p>
          </div>
          <div id="connBadge" class="conn-badge disconnected">
            <span class="dot"></span>
            <span id="connBadgeText">检查状态中...</span>
          </div>
        </header>

        <div id="statusAlert" class="status-alert hidden" role="status" aria-live="polite">
          <span id="statusIcon" class="status-icon"></span>
          <span id="statusMsg" class="status-msg"></span>
          <button type="button" id="statusClose" class="status-close" title="关闭提示">×</button>
        </div>

        <form id="settings">
          <fieldset id="fields">
            <!-- 卡片 1: 服务连接设置 -->
            <section class="card">
              <div class="card-header">
                <h2>服务连接</h2>
                <span class="card-subtitle">配置 OneBot v11 正向 WebSocket 服务地址与鉴权</span>
              </div>
              <div class="card-body">
                <div class="form-group">
                  <label for="url">WebSocket 地址 <span class="required">*</span></label>
                  <input id="url" type="text" placeholder="ws://127.0.0.1:3001" spellcheck="false" required aria-describedby="urlHelp">
                  <p class="help" id="urlHelp">本地服务一般为 <code>ws://127.0.0.1:3001</code>；远程服务器请填写对应 IP/域名与端口。</p>
                </div>

                <div class="form-group">
                  <label for="token">Access Token 访问令牌</label>
                  <input id="token" type="password" autocomplete="new-password" placeholder="未启用鉴权可直接留空" aria-describedby="tokenHelp">
                  <p class="help" id="tokenHelp">令牌加密保存在 VS Code 安全存储中，不写入任何本地明文文件。</p>
                </div>

                <div class="form-row-checkboxes">
                  <label class="check"><input id="clearToken" type="checkbox"><span>清除已保存的 Token</span></label>
                  <label class="check"><input id="autoConnect" type="checkbox"><span>打开 QQ 视图时自动连接</span></label>
                </div>
              </div>
              <div class="card-footer actions">
                <button type="submit" id="connect" class="primary">保存并连接</button>
                <button type="button" id="test" class="secondary">测试连接</button>
                <button type="button" id="save" class="secondary">仅保存</button>
              </div>
            </section>

            <!-- 卡片 2: 聊天与显示 -->
            <section class="card">
              <div class="card-header">
                <h2>聊天显示与外观</h2>
                <span class="card-subtitle">编辑器高亮语法风格、消息历史条数及提醒配色</span>
              </div>
              <div class="card-body">
                <div class="form-group">
                  <label for="codeLanguage">代码语言风格</label>
                  <select id="codeLanguage" aria-describedby="codeLanguageHelp">
                    ${codeLanguages.map(value => `<option value="${value}">${languageLabels[value]}${value === 'c' ? '（推荐 / 默认）' : ''}</option>`).join('')}
                  </select>
                  <p class="help" id="codeLanguageHelp">聊天记录在编辑器中的代码高亮方案；保存后立即生效，草稿和消息原文保持不变。</p>
                </div>

                <div class="grid-2col">
                  <div class="form-group">
                    <label for="historyCount">首次加载历史条数</label>
                    <input id="historyCount" type="number" min="${chatSettings.historyCount.minimum}" max="${chatSettings.historyCount.maximum}" required>
                    <p class="help">打开会话时拉取的初始消息数（${chatSettings.historyCount.minimum}～${chatSettings.historyCount.maximum}）</p>
                  </div>
                  <div class="form-group">
                    <label for="messageLimit">每个会话历史上限</label>
                    <input id="messageLimit" type="number" min="${chatSettings.messageLimit.minimum}" max="${chatSettings.messageLimit.maximum}" required>
                    <p class="help">单会话显示与缓存的消息最大条数（${chatSettings.messageLimit.minimum}～${chatSettings.messageLimit.maximum}）</p>
                  </div>
                </div>

                <div class="form-group">
                  <label for="notifications">新消息弹窗通知</label>
                  <select id="notifications">
                    <option value="all">所有新消息（默认）</option>
                    <option value="mentions">仅在 @我 和 回复我 时弹窗</option>
                    <option value="off">关闭系统弹窗（仍保留侧栏红点未读数与编辑区高亮）</option>
                  </select>
                </div>

                <div class="colors-section">
                  <div class="colors-heading">消息高亮提醒配色</div>
                  <div class="grid-2col">
                    <div class="color-control">
                      <label for="mentionColor">@我 消息高亮色</label>
                      <div class="color-input-wrap">
                        <input id="mentionColor" type="color">
                        <span id="mentionColorVal" class="color-hex">#E5A030</span>
                      </div>
                    </div>
                    <div class="color-control">
                      <label for="replyColor">回复我 消息高亮色</label>
                      <div class="color-input-wrap">
                        <input id="replyColor" type="color">
                        <span id="replyColorVal" class="color-hex">#409CFF</span>
                      </div>
                    </div>
                  </div>

                  <div class="preview-panel">
                    <div class="preview-title">高亮效果实时预览</div>
                    <div class="preview-lines">
                      <div class="preview-row preview-mention" id="prevMention">
                        <code>void recv_user(void) { /* @我 消息高亮色条与淡色背景 */ }</code>
                      </div>
                      <div class="preview-row preview-reply" id="prevReply">
                        <code>void recv_user(void) { /* 回复我 消息高亮色条与淡色背景 */ }</code>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </section>

            <!-- 卡片 3: 附件缓存管理 -->
            <section class="card">
              <div class="card-header">
                <h2>附件缓存管理</h2>
                <span class="card-subtitle">图片、视频与文件等本地临时资源的存储管理</span>
              </div>
              <div class="card-body">
                <div class="cache-status-bar">
                  <div class="cache-desc">
                    <span class="cache-label">当前账号附件缓存占用</span>
                    <span id="cacheInfo" class="cache-size">正在计算中…</span>
                  </div>
                  <button type="button" id="cleanCache" class="secondary">清理无用附件缓存</button>
                </div>

                <div class="form-group" style="margin-top: 14px;">
                  <label for="cacheRetentionDays">无引用附件自动保留天数</label>
                  <input id="cacheRetentionDays" type="number" min="${chatSettings.cacheRetentionDays.minimum}" max="${chatSettings.cacheRetentionDays.maximum}" required>
                  <p class="help">未被任何历史消息引用的临时文件保留时长（${chatSettings.cacheRetentionDays.minimum}～${chatSettings.cacheRetentionDays.maximum} 天）。草稿、发送队列、撤回记录及历史图片会受到安全保护，不会被误删。</p>
                </div>
              </div>
            </section>

            <!-- 卡片 4: 高级工具与导入 -->
            <section class="card">
              <div class="card-header">
                <h2>配置导入与迁移</h2>
                <span class="card-subtitle">从现有客户端快速导入配置</span>
              </div>
              <div class="card-body">
                <div class="import-section">
                  <button type="button" id="import" class="secondary">导入 tuiqq 配置文件</button>
                  <span class="help">选取现有的 <code>config.json</code>，一键读取 WebSocket 地址、Token 与拉取条数。</span>
                </div>
              </div>
            </section>
          </fieldset>
        </form>

        <footer class="footer">
          <p>测试连接使用临时连接探测状态，不会发送 QQ 消息，亦不切换当前聊天账号。</p>
        </footer>
      </div>
      <script nonce="${nonce}" src="${asset('settings.js')}"></script></body></html>`;
    const listener = panel.webview.onDidReceiveMessage(async data => {
      try { await panel.webview.postMessage(await this.handle(data)); }
      catch (error: any) { await panel.webview.postMessage({ error: error.message }); }
    });
    panel.onDidDispose(() => { listener.dispose(); this.probe?.dispose(); if (this.panel === panel) this.panel = undefined; });
  }
  async handle(data: any): Promise<any> {
    if (data?.action === 'ready') return { state: await this.state() };
    if (!['save', 'connect', 'test', 'import', 'cleanCache'].includes(data?.action)) throw new Error('未知设置操作');
    if (this.busy) throw new Error('请等待当前操作完成');
    this.busy = true;
    try {
      if (data.action === 'cleanCache') {
        const bytes = await this.cleanCache(); return { state: await this.state(), message: `已清理 ${(bytes / 1048576).toFixed(1)} MB 无用附件缓存。` };
      }
      if (data.action === 'import') {
        const imported = await this.config.import();
        return { state: await this.state(), message: imported ? '配置已成功导入，点击“保存并连接”即可应用。' : '已取消导入。' };
      }
      if (typeof data.url !== 'string' || typeof data.token !== 'string' || typeof data.autoConnect !== 'boolean' || typeof data.clearToken !== 'boolean') throw new Error('连接配置格式无效');
      if (data.codeLanguage !== undefined && !isCodeLanguage(data.codeLanguage)) throw new Error('代码语言风格无效');
      const url = data.url.trim(), invalid = validateUrl(url); if (invalid) throw new Error(invalid);
      const token = data.clearToken ? '' : data.token || undefined;
      if (data.action === 'test') {
        const probe = new OneBotClient(); this.probe = probe;
        try {
          await probe.connect(url, token ?? await this.config.token());
          const info = await probe.call('get_login_info', {}, 5000);
          if (!/^\d+$/.test(String(info?.user_id ?? ''))) throw new Error('服务端未返回有效的登录账号');
          return { message: `连接测试成功：${String(info.nickname || 'QQ')}（${info.user_id}）` };
        } finally { probe.dispose(); if (this.probe === probe) this.probe = undefined; }
      }
      const updates = validateChatSettings(data);
      const settings = vscode.workspace.getConfiguration('qq');
      const keys = ['wsUrl', 'autoConnect', ...updates.map(([key]) => key)];
      const missing = keys.filter(key => settings.inspect(key)?.defaultValue === undefined);
      if (missing.length) throw new Error(`插件配置尚未加载（${missing.map(key => 'qq.' + key).join('、')}）。请执行 Developer: Reload Window（开发人员: 重新加载窗口），重新打开 QQ 设置后保存。本次未写入设置。`);
      await this.config.saveConnection(url, token, data.autoConnect);
      for (const [key, value] of updates) await vscode.workspace.getConfiguration('qq').update(key, value, vscode.ConfigurationTarget.Global);
      if (data.action === 'connect') {
        try { await this.connect(); }
        catch (error: any) { return { state: await this.state(), error: `配置已保存，但连接失败：${error.message}` }; }
      }
      return { state: await this.state(), message: data.action === 'connect' ? '配置已保存，已成功连接到 OneBot 服务。' : '配置已保存；聊天显示设置已即时生效。' };
    } finally { this.busy = false; }
  }
  dispose(): void { this.probe?.dispose(); this.panel?.dispose(); }
}
