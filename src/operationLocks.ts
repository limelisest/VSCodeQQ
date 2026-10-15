// Repeated triggers share the active operation, including dialogs and cleanup.
// Independent keys remain concurrent; failures never poison a later attempt.
export class OperationLocks {
  private pending = new Map<string, Promise<unknown>>();
  run<T>(key: string, action: () => T | PromiseLike<T>): Promise<T> {
    const active = this.pending.get(key);
    if (active) return active as Promise<T>;
    let resolve!: (value: T | PromiseLike<T>) => void, reject!: (reason: unknown) => void;
    const task = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    this.pending.set(key, task);
    const release = () => { if (this.pending.get(key) === task) this.pending.delete(key); };
    void task.then(release, release);
    try { resolve(action()); } catch (error) { reject(error); }
    return task;
  }
}
