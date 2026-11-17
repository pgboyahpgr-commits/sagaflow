import type { RunEvent, RunEventType } from '@sagaflow/shared';
import type { StorageAdapter } from '../storage/interface.js';

export type RunEventListener = (event: RunEvent) => void;

/**
 * Durable Offset-Indexed Event Bus:
 * - Every event is persisted to StorageAdapter with a monotonic per-run offset
 * - Parallel step emissions for the same runId are serialized to prevent offset collisions
 * - Subscribers can replay from any offset (`sinceOffset`) and seamlessly tail live events
 */
export class RunEventBus {
  private readonly storage: StorageAdapter;
  private readonly listeners = new Map<string, Set<RunEventListener>>();
  private readonly completionWaiters = new Map<string, Set<() => void>>();
  private readonly appendChains = new Map<string, Promise<unknown>>();

  constructor(storage: StorageAdapter) {
    this.storage = storage;
  }

  private key(tenantId: string, runId: string): string {
    return `${tenantId}::${runId}`;
  }

  async emit(
    tenantId: string,
    runId: string,
    type: RunEventType,
    payload: Record<string, unknown>,
    nodeId?: string
  ): Promise<RunEvent> {
    const k = this.key(tenantId, runId);
    const prev = this.appendChains.get(k) ?? Promise.resolve();

    const op = prev.then(async () => {
      const event = await this.storage.appendRunEvent(tenantId, runId, type, payload, nodeId);
      const subs = this.listeners.get(k);
      if (subs) {
        for (const fn of subs) {
          try {
            fn(event);
          } catch {
            // Never let a disconnected SSE client crash the orchestrator
          }
        }
      }
      if (type === 'run.completed') {
        const waiters = this.completionWaiters.get(k);
        if (waiters) {
          for (const resolve of waiters) resolve();
          this.completionWaiters.delete(k);
        }
      }
      return event;
    });

    this.appendChains.set(
      k,
      op.catch(() => undefined)
    );
    return op;
  }

  subscribe(tenantId: string, runId: string, listener: RunEventListener): () => void {
    const k = this.key(tenantId, runId);
    let set = this.listeners.get(k);
    if (!set) {
      set = new Set();
      this.listeners.set(k, set);
    }
    set.add(listener);
    return () => {
      const cur = this.listeners.get(k);
      if (!cur) return;
      cur.delete(listener);
      if (cur.size === 0) {
        this.listeners.delete(k);
      }
    };
  }

  waitForCompletion(tenantId: string, runId: string, timeoutMs = 60000): Promise<void> {
    const k = this.key(tenantId, runId);
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const set = this.completionWaiters.get(k);
        if (set) {
          set.delete(finish);
          if (set.size === 0) this.completionWaiters.delete(k);
        }
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      let set = this.completionWaiters.get(k);
      if (!set) {
        set = new Set();
        this.completionWaiters.set(k, set);
      }
      set.add(finish);
    });
  }
}
