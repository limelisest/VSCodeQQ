import { OperationLocks } from './operationLocks';

// Every connection attempt invalidates work started by an earlier connection.
// Consumers retain a token across awaits; cancelled work cannot publish into a new session.
export class AccountSession {
  private operations = new OperationLocks();
  run<T>(key: string, action: () => T | PromiseLike<T>): Promise<T> {
    return this.operations.run(JSON.stringify([this.generation, key]), action);
  }
  private controller = new AbortController();
  generation = 0;
  readonly memberLoaded = new Map<string, number>();
  readonly memberLoading = new Map<string, Promise<void>>();
  readonly historyCounts = new Map<string, number>();
  readonly replyLookups = new Map<string, Promise<boolean>>();
  private binding: Promise<void> = Promise.resolve();
  bind(action: () => Promise<void>): Promise<void> {
    const task = this.binding.catch(() => {}).then(action); this.binding = task; return task;
  }
  clearAccount(): void {
    this.memberLoaded.clear(); this.memberLoading.clear(); this.historyCounts.clear(); this.replyLookups.clear();
  }
  advance(): number { this.controller.abort(); this.memberLoading.clear(); this.replyLookups.clear(); this.controller = new AbortController(); return ++this.generation; }
  capture() {
    const generation = this.generation, signal = this.controller.signal;
    return { generation, signal, current: () => !signal.aborted && generation === this.generation };
  }
}
