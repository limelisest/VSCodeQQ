import { chatSettings, validateChatSettings } from './settingsSchema';
import { CacheInfo } from './cacheManagement';
import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { Configuration, validateUrl } from './configuration';
import { OneBotClient } from './onebot';
import { isCodeLanguage } from './codeStyle';
import { settingsHtml } from './settingsHtml';
import { isSettingsPage, settingsPages, SettingsPage } from './settingsSchema';

export class ConnectionSettings implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private busy = false;
  private probe?: OneBotClient;
  constructor(private context: vscode.ExtensionContext, private config: Configuration, private connect: () => Promise<void>, private cacheInfo: () => Promise<CacheInfo>, private cleanCache: () => Promise<number>, private connection: () => { connected: boolean; status: string; account?: string } = () => ({ connected: false, status: '未连接' }), private disconnect: () => void = () => {}, private openCache: () => Promise<void> = async () => {}) {}
  async state(includeCache = true) {
    return { ...this.config.chatOptions(), ...(includeCache ? { cache: await this.cacheInfo() } : {}), connection: this.connection(), url: this.config.url, hasToken: !!await this.config.token(), autoConnect: vscode.workspace.getConfiguration('qq').get('autoConnect', true) };
  }
  updateConnection(): void {
    void this.panel?.webview.postMessage({ connection: this.connection() });
  }
  open(): void {
    if (this.panel) { this.panel.reveal(); return; }
    const panel = vscode.window.createWebviewPanel('qq.connectionSettings', 'QQ · 设置', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')] });
    this.panel = panel;
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'qq-chat.svg');
    const nonce = randomBytes(24).toString('hex');
    const asset = (name: string) => panel.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', name)).toString();
    panel.webview.html = settingsHtml(asset, panel.webview.cspSource, nonce);
    const listener = panel.webview.onDidReceiveMessage(async data => {
      try { await panel.webview.postMessage({ ...await this.handle(data), requestId: data?.requestId }); }
      catch (error: any) { await panel.webview.postMessage({ error: error.message, requestId: data?.requestId }); }
    });
    panel.onDidDispose(() => { listener.dispose(); this.probe?.dispose(); if (this.panel === panel) this.panel = undefined; });
  }
  async handle(data: any): Promise<any> {
    if (data?.action === 'ready') return { state: await this.state(false), page: this.context.globalState.get('settingsPage', 'connection'), groups: settingsPages, defaults: Object.fromEntries(Object.entries(chatSettings).map(([key, value]) => [key, value.default])) };
    if (data?.action === 'openCache') { await this.openCache(); return {}; }
    if (data?.action === 'page' && isSettingsPage(data.page)) { await this.context.globalState.update('settingsPage', data.page); return {}; }
    if (data?.action === 'disconnect') { this.disconnect(); return { connection: this.connection(), message: '已断开连接。' }; }
    if (data?.action === 'cacheInfo') return { cache: await this.cacheInfo() };
    if (!['save', 'connect', 'test', 'import', 'export', 'cleanCache'].includes(data?.action)) throw new Error('未知设置操作');
    if (data.page !== undefined && !isSettingsPage(data.page)) throw new Error('设置分类无效');
    if (this.busy) throw new Error('请等待当前操作完成');
    this.busy = true;
    try {
      if (data.action === 'export') {
        const file = await vscode.window.showSaveDialog({ title: '导出 QQ 配置（不包含 Token）', defaultUri: vscode.Uri.joinPath(vscode.workspace.workspaceFolders?.[0]?.uri ?? this.context.globalStorageUri, 'qq-settings.json'), filters: { JSON: ['json'] } });
        if (file) await vscode.workspace.fs.writeFile(file, Buffer.from(this.config.exportData(), 'utf8'));
        return { message: file ? '配置已导出，不包含 Token。' : '已取消导出。' };
      }
      if (data.action === 'cleanCache') {
        const bytes = await this.cleanCache(); return { cache: await this.cacheInfo(), message: `已清理 ${(bytes / 1048576).toFixed(1)} MB 无用附件缓存。` };
      }
      if (data.action === 'import') {
        const imported = await this.config.import();
        return { state: await this.state(false), message: imported ? '配置已导入，连接页可连接到导入的服务。' : '已取消导入。' };
      }
      const page: SettingsPage | undefined = data.page;
      if (page && page !== 'connection') {
        if (data.action !== 'save') throw new Error('连接操作只能在连接页执行');
        const input = Object.fromEntries(settingsPages[page].filter(key => data[key] !== undefined).map(key => [key, data[key]]));
        const updates = validateChatSettings(input);
        await this.saveOptions(updates);
        return { state: await this.state(false), savedPage: page, message: '本页设置已保存。' };
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
          return { connection: this.connection(), message: `连接测试成功：${String(info.nickname || 'QQ')}（${info.user_id}）。当前连接状态未改变。` };
        } finally { probe.dispose(); if (this.probe === probe) this.probe = undefined; }
      }
      const updates = validateChatSettings(page === 'connection' ? {} : data);
      const settings = vscode.workspace.getConfiguration('qq');
      const keys = ['wsUrl', 'autoConnect', ...updates.map(([key]) => key)];
      const missing = keys.filter(key => settings.inspect(key)?.defaultValue === undefined);
      if (missing.length) throw new Error(`插件配置尚未加载（${missing.map(key => 'qq.' + key).join('、')}）。请执行 Developer: Reload Window（开发人员: 重新加载窗口），重新打开 QQ 设置后保存。本次未写入设置。`);
      await this.config.saveConnection(url, token, data.autoConnect);
      for (const [key, value] of updates) await vscode.workspace.getConfiguration('qq').update(key, value, vscode.ConfigurationTarget.Global);
      if (data.action === 'connect') {
        try { await this.connect(); }
        catch (error: any) { return { state: await this.state(false), savedPage: page, error: `配置已保存，但连接失败：${error.message}` }; }
      }
      return { state: await this.state(false), savedPage: page, message: data.action === 'connect' ? '配置已保存，已成功连接到 OneBot 服务。' : '本页设置已保存。' };
    } finally { this.busy = false; }
  }
  private async saveOptions(updates: ReturnType<typeof validateChatSettings>): Promise<void> {
    const settings = vscode.workspace.getConfiguration('qq');
    if (updates.some(([key]) => settings.inspect(key)?.defaultValue === undefined)) throw new Error('插件配置尚未加载，请重新加载窗口后保存。');
    for (const [key, value] of updates) await settings.update(key, value, vscode.ConfigurationTarget.Global);
  }
  dispose(): void { this.probe?.dispose(); this.panel?.dispose(); }
}
