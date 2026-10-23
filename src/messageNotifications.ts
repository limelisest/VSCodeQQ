import * as vscode from 'vscode';

// Completing notification progress closes that specific notification, including
// while VS Code is unfocused or the pointer is over it. It does not clear other sources.
export class MessageNotifications implements vscode.Disposable {
  private pending = new Set<() => void>();
  private stopped = false;
  constructor(private log: (error: unknown) => void) {}
  show(account: string, key: string, preview: string): void {
    if (this.stopped) return;
    const args = encodeURIComponent(JSON.stringify([{ account, key }]));
    void vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `[查看](command:qq.openChat?${args}) ${preview}`,
      cancellable: false
    }, progress => new Promise<void>(resolve => {
      // A zero-width determinate bar keeps the preview still while it is visible.
      progress.report({ increment: 0 });
      const close = () => { clearTimeout(timer); this.pending.delete(close); resolve(); };
      const timer = setTimeout(close, 10000);
      this.pending.add(close);
    })).then(undefined, error => this.log(error));
  }
  clear(): void { for (const close of this.pending) close(); }
  dispose(): void { this.stopped = true; this.clear(); }
}
