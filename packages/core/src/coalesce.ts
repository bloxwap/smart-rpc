/**
 * In-flight coalescing: identical concurrent reads share one upstream request.
 *
 * An entry lives only while its request is in flight. Each caller waits under its own signal.
 * The shared request is cancelled only once every waiting caller has stopped waiting.
 * @module
 */

/**
 * Idempotent methods that still never coalesce. A subscription belongs to one caller, and a filter's
 * id and its polls are state on one node. Transports may pass more.
 */
export const DEFAULT_UNCOALESCED_METHODS: ReadonlySet<string> = new Set([
  "eth_subscribe",
  "eth_unsubscribe",
  "eth_newFilter",
  "eth_newBlockFilter",
  "eth_newPendingTransactionFilter",
  "eth_getFilterChanges",
  "eth_getFilterLogs",
  "eth_uninstallFilter",
]);

/** True when concurrent identical calls of `method` may share one request. */
export function isCoalescableMethod(
  method: string,
  idempotent: boolean,
  extra: ReadonlySet<string> = DEFAULT_UNCOALESCED_METHODS,
): boolean {
  return idempotent && !extra.has(method);
}

/**
 * `method` plus params serialized with sorted object keys. Undefined when the params cannot be serialized.
 */
export function coalesceKey(method: string, params: unknown): string | undefined {
  const parts: string[] = [];
  return writeValue(params, parts, new Set()) ? `${method}:${parts.join("")}` : undefined;
}

function writeValue(value: unknown, out: string[], path: Set<object>): boolean {
  if (value === undefined) {
    out.push("u");
    return true;
  }
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    out.push(JSON.stringify(value));
    return true;
  }
  if (typeof value === "number") {
    out.push(String(value));
    return true;
  }
  if (typeof value === "bigint") {
    out.push(`${value}n`);
    return true;
  }
  if (typeof value !== "object") {
    out.push(`<${typeof value}>`);
    return true;
  }
  if (path.has(value)) return false;
  path.add(value);
  let ok = true;
  const toJson: unknown = (value as { toJSON?: unknown }).toJSON;
  if (typeof toJson === "function") {
    ok = writeValue(toJson.call(value), out, path);
  } else if (Array.isArray(value)) {
    out.push("[");
    for (let index = 0; index < value.length && ok; index += 1) {
      if (index > 0) out.push(",");
      ok = writeValue(value[index], out, path);
    }
    out.push("]");
  } else {
    out.push("{");
    const keys = Object.keys(value).sort();
    for (let index = 0; index < keys.length && ok; index += 1) {
      const key = keys[index] as string;
      if (index > 0) out.push(",");
      out.push(JSON.stringify(key), ":");
      ok = writeValue((value as Record<string, unknown>)[key], out, path);
    }
    out.push("}");
  }
  path.delete(value);
  return ok;
}

interface Entry {
  promise: Promise<unknown>;
  cancel: Cancel | undefined;
  waiting: number;
  abandoned: boolean;
  deadline: number;
}

interface Cancel {
  controller: AbortController;
  live: Set<Entry>;
}

type Run = (signal: AbortSignal | undefined, progress: (waitMs?: number) => void) => Promise<unknown>;

/** One pool's table of shared in-flight reads. */
export class Coalescer {
  readonly #entries = new Map<string, Entry>();
  readonly #cancels = new WeakMap<AbortSignal, Cancel>();
  readonly #maxWaitMs: number;

  constructor(maxWaitMs: number) {
    this.#maxWaitMs = maxWaitMs;
  }

  get size(): number {
    return this.#entries.size;
  }

  /**
   * Join the in-flight request for `key`, or start one with `run`.
   * `onJoin` fires for a caller that joined an existing request.
   */
  request(key: string, signal: AbortSignal | undefined, run: Run, onJoin: () => void): Promise<unknown> {
    if (signal?.aborted) return run(signal, ignore);
    const existing = this.#entries.get(key);
    if (existing && Date.now() < existing.deadline) {
      onJoin();
      return this.#wait(key, existing, signal, () => this.request(key, signal, run, ignore));
    }
    return this.#wait(key, this.#start(key, signal, run), signal, undefined);
  }

  #start(key: string, signal: AbortSignal | undefined, run: Run): Entry {
    const cancel = signal === undefined ? undefined : this.#cancelFor(signal);
    const entry: Entry = {
      promise: Promise.resolve(),
      cancel,
      waiting: 0,
      abandoned: false,
      deadline: Date.now() + this.#maxWaitMs,
    };
    const progress = (waitMs = 0): void => {
      entry.deadline = Math.max(entry.deadline, Date.now() + waitMs + this.#maxWaitMs);
    };
    let started: Promise<unknown>;
    try {
      started = run(cancel?.controller.signal, progress);
    } catch (error) {
      started = Promise.reject(error);
    }
    cancel?.live.add(entry);
    entry.promise = started.finally(() => {
      if (this.#entries.get(key) === entry) this.#entries.delete(key);
      if (cancel) {
        cancel.live.delete(entry);
        this.#cancelIfAbandoned(cancel);
      }
    });
    entry.promise.catch(ignore);
    this.#entries.set(key, entry);
    return entry;
  }

  #wait(
    key: string,
    entry: Entry,
    signal: AbortSignal | undefined,
    retry: (() => Promise<unknown>) | undefined,
  ): Promise<unknown> {
    entry.waiting += 1;
    if (!signal && !retry) return entry.promise;
    return new Promise((resolve, reject) => {
      let done = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (then: () => void): void => {
        if (done) return;
        done = true;
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        then();
      };
      const onAbort = (): void =>
        settle(() => {
          this.#leave(key, entry);
          reject(abortReason(signal));
        });
      signal?.addEventListener("abort", onAbort, { once: true });
      const arm = (): void => {
        if (!retry) return;
        timer = setTimeout(
          () => {
            if (Date.now() < entry.deadline) {
              arm();
              return;
            }
            settle(() => {
              if (this.#entries.get(key) === entry) this.#entries.delete(key);
              this.#leave(key, entry);
              retry().then(resolve, reject);
            });
          },
          Math.max(0, entry.deadline - Date.now()),
        );
        unrefTimer(timer);
      };
      arm();
      entry.promise.then(
        (result) => settle(() => resolve(result)),
        (error: unknown) => settle(() => reject(error)),
      );
    });
  }

  #leave(key: string, entry: Entry): void {
    entry.waiting -= 1;
    if (entry.waiting > 0 || !entry.cancel) return;
    entry.abandoned = true;
    if (this.#entries.get(key) === entry) this.#entries.delete(key);
    this.#cancelIfAbandoned(entry.cancel);
  }

  #cancelFor(signal: AbortSignal): Cancel {
    const existing = this.#cancels.get(signal);
    if (existing && !existing.controller.signal.aborted) return existing;
    const cancel: Cancel = { controller: new AbortController(), live: new Set() };
    this.#cancels.set(signal, cancel);
    return cancel;
  }

  #cancelIfAbandoned(cancel: Cancel): void {
    if (cancel.live.size === 0) return;
    for (const entry of cancel.live) if (!entry.abandoned) return;
    cancel.controller.abort();
  }
}

const ignore = (): void => undefined;

function abortReason(signal: AbortSignal | undefined): Error {
  const reason: unknown = signal?.reason;
  if (reason instanceof Error) return reason;
  const error = new Error("This operation was aborted");
  error.name = "AbortError";
  return error;
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer === "object" && timer !== null && "unref" in timer && typeof timer.unref === "function") {
    timer.unref();
  }
}
