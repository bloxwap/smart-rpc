import { Budgets } from "./budget.js";
import { TransportClosedError } from "./errors.js";
import type { PoolShareScope, RpcPool, RpcRequest } from "./types.js";
import type { RpcEvent } from "./events.js";

interface Entry {
  pool: RpcPool;
  references: number;
  closed: boolean;
}

/** Create an isolated owner for shared pools and their token buckets. */
export function createPoolScope(): PoolShareScope {
  const entries = new Map<string, Entry>();
  let budgets: Budgets | undefined;
  let closed = false;

  return {
    acquire(key, budgetKey, now, build): RpcPool {
      if (closed) throw new TransportClosedError();
      if (key.trim() === "") throw new Error("smart-rpc sharing.key must not be empty.");
      if (budgetKey.trim() === "") throw new Error("smart-rpc sharing.budgetKey must not be empty.");
      let entry = entries.get(key);
      if (!entry) {
        budgets ??= new Budgets(now);
        entry = { pool: build(budgets), references: 0, closed: false };
        entries.set(key, entry);
      }
      entry.references += 1;
      return lease(entry, () => {
        if (entry.references > 0 || entries.get(key) !== entry) return;
        entries.delete(key);
        entry.closed = true;
        entry.pool.close();
      });
    },
    close(): void {
      if (closed) return;
      closed = true;
      const owned = [...entries.values()];
      entries.clear();
      for (const entry of owned) {
        if (entry.closed) continue;
        entry.closed = true;
        entry.pool.close();
      }
    },
  };
}

function lease(entry: Entry, release: () => void): RpcPool {
  const listeners = new Set<() => void>();
  let closed = false;
  const unavailable = (): boolean => closed || entry.closed;
  const stopListening = (): void => {
    for (const stop of listeners) stop();
    listeners.clear();
  };
  return {
    chainIds: entry.pool.chainIds,
    endpoints: entry.pool.endpoints,
    async request(request: RpcRequest): Promise<unknown> {
      if (unavailable()) throw new TransportClosedError();
      return entry.pool.request(request);
    },
    async requestBatch(requests: readonly RpcRequest[]): Promise<PromiseSettledResult<unknown>[]> {
      if (unavailable()) throw new TransportClosedError();
      return entry.pool.requestBatch(requests);
    },
    probe(): Promise<void> {
      return unavailable() ? Promise.resolve() : entry.pool.probe();
    },
    snapshot: (method?: string) => entry.pool.snapshot(method),
    scores: () => entry.pool.scores(),
    restoreScores: (snapshot: unknown) => entry.pool.restoreScores(snapshot),
    cacheStats: () => entry.pool.cacheStats(),
    onEvent(listener: (event: RpcEvent) => void): () => void {
      if (unavailable()) return () => undefined;
      let active = true;
      const stopPool = entry.pool.onEvent(listener);
      const stop = (): void => {
        if (!active) return;
        active = false;
        listeners.delete(stop);
        stopPool();
      };
      listeners.add(stop);
      return stop;
    },
    close(): void {
      if (closed) return;
      closed = true;
      stopListening();
      if (entry.closed) return;
      entry.references -= 1;
      release();
    },
  };
}
