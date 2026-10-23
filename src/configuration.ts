import { chatSettings, ChatSetting, draftActions } from './settingsSchema';
import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import { CodeLanguage, isCodeLanguage } from './codeStyle';
import { reminderColors, validateChatSettings } from './settingsSchema';
let colorSync = Promise.resolve();
export function syncReminderColors(): Promise<void> {
  const task = colorSync.catch(() => {}).then(async () => {
    const workbench = vscode.workspace.getConfiguration('workbench'), config = vscode.workspace.getConfiguration('qq');
    const previous = workbench.get<Record<string, unknown>>('colorCustomizations', {}), next = { ...previous };
    for (const [name, key] of [['unread', 'unreadColor'], ['mention', 'mentionColor'], ['reply', 'replyColor']] as const) {
      const raw = config.get(key, reminderColors[key].default);
      const value = /^#[0-9a-f]{6}$/i.test(raw) ? raw : reminderColors[key].default;
      if (value.toLowerCase() !== reminderColors[key].default.toLowerCase() || `qq.${name}Badge` in previous) next[`qq.${name}Badge`] = value;
    }
    if (JSON.stringify(next) !== JSON.stringify(previous)) await workbench.update('colorCustomizations', next, vscode.ConfigurationTarget.Global);
  });
  colorSync = task; return task;
}
export function configuredCodeLanguage(): CodeLanguage {
  const value = vscode.workspace.getConfiguration('qq').get('codeLanguage');
  return isCodeLanguage(value) ? value : 'c';
}
export function validateUrl(value: string): string | undefined {
  try { const url = new URL(value); if (!['ws:', 'wss:'].includes(url.protocol) || !url.hostname) return '请输入 ws:// 或 wss:// 地址'; if (url.username || url.password) return '请在 Token 输入框填写鉴权信息'; } catch { return '请输入有效的 WebSocket 地址'; }
  return undefined;
}
export class Configuration {
  constructor(private context: vscode.ExtensionContext) {}
  get codeLanguage(): CodeLanguage { return configuredCodeLanguage(); }
  get url(): string { return vscode.workspace.getConfiguration('qq').get('wsUrl', 'ws://127.0.0.1:3001'); }
  get historyCount(): number { return Math.max(10, Math.min(500, vscode.workspace.getConfiguration('qq').get('historyCount', chatSettings.historyCount.default))); }
  get messageLimit(): number { return Math.max(50, Math.min(2000, vscode.workspace.getConfiguration('qq').get('messageLimit', chatSettings.messageLimit.default))); }
  chatOptions(): Record<ChatSetting, unknown> {
    const settings = vscode.workspace.getConfiguration('qq');
    const options = Object.fromEntries(Object.entries(chatSettings).map(([key, definition]) => [key, settings.get(key, definition.default)])) as Record<ChatSetting, unknown>;
    const buttons = options.statusBarButtons;
    options.statusBarButtons = Array.isArray(buttons) ? buttons.filter(key => typeof key === 'string' && Object.hasOwn(draftActions, key)) : chatSettings.statusBarButtons.default;
    return options;
  }
  async token(): Promise<string> { return await this.context.secrets.get('qq.wsToken') ?? ''; }
  async saveConnection(url: string, token: string | undefined, autoConnect: boolean): Promise<void> {
    const invalid = validateUrl(url); if (invalid) throw new Error(invalid);
    if (token === '') await this.context.secrets.delete('qq.wsToken');
    else if (token !== undefined) await this.context.secrets.store('qq.wsToken', token);
    const settings = vscode.workspace.getConfiguration('qq');
    await settings.update('wsUrl', url, vscode.ConfigurationTarget.Global);
    await settings.update('autoConnect', autoConnect, vscode.ConfigurationTarget.Global);
  }
  async configure(): Promise<boolean> {
    const url = await vscode.window.showInputBox({ title: 'OneBot v11 WebSocket 地址', prompt: '例如 ws://127.0.0.1:3001（支持 NapCat、Lagrange 等服务）', value: this.url, validateInput: validateUrl, ignoreFocusOut: true });
    if (url === undefined) return false;
    const token = await vscode.window.showInputBox({ title: 'OneBot Access Token', prompt: '服务端未启用鉴权可直接留空', password: true, value: await this.token(), ignoreFocusOut: true });
    if (token === undefined) return false;
    await this.save(url, token); return true;
  }
  async import(): Promise<boolean> {
    const paths = await vscode.window.showOpenDialog({ title: '选择 tuiqq 的 config.json', canSelectMany: false, filters: { 'JSON 配置': ['json'] } });
    if (!paths?.length) return false;
    await this.importFile(paths[0].fsPath); return true;
  }
  async importFile(file: string): Promise<void> {
    const config = JSON.parse(await fs.readFile(file, 'utf8'));
    if (config.format === 'vscode-qq' && config.version === 1 && config.settings && typeof config.settings === 'object') {
      const input = config.settings;
      if (typeof input.wsUrl !== 'string' || typeof input.autoConnect !== 'boolean') throw new Error('导入的连接配置无效');
      const invalid = validateUrl(input.wsUrl); if (invalid) throw new Error(invalid);
      const updates = validateChatSettings(input);
      await this.saveConnection(input.wsUrl, undefined, input.autoConnect);
      for (const [key, value] of updates) await vscode.workspace.getConfiguration('qq').update(key, value, vscode.ConfigurationTarget.Global);
      return;
    }
    if (typeof config.ws_url !== 'string') throw new Error('配置缺少 ws_url');
    const invalid = validateUrl(config.ws_url); if (invalid) throw new Error(invalid);
    await this.save(config.ws_url, typeof config.ws_token === 'string' ? config.ws_token : '');
    const settings = vscode.workspace.getConfiguration('qq');
    if (Number.isFinite(config.history_message_count)) await settings.update('historyCount', Math.max(10, Math.min(500, config.history_message_count)), vscode.ConfigurationTarget.Global);
  }
  exportData(): string {
    return JSON.stringify({ format: 'vscode-qq', version: 1, settings: { wsUrl: this.url, autoConnect: vscode.workspace.getConfiguration('qq').get('autoConnect', true), ...this.chatOptions() } }, null, 2);
  }
  private async save(url: string, token: string): Promise<void> {
    if (token === '') await this.context.secrets.delete('qq.wsToken');
    else await this.context.secrets.store('qq.wsToken', token);
    await vscode.workspace.getConfiguration('qq').update('wsUrl', url, vscode.ConfigurationTarget.Global);
  }
}
