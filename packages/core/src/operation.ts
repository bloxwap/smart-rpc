import { abortError } from "./error-util.js";
import { OperationBudgetExceededError, TimeoutError } from "./errors.js";
import type { OperationBudgetOptions } from "./types.js";

/** One operation owns its deadline and upstream counter, including all batch items. */
export class Operation {
  readonly controller = new AbortController();
  readonly signal: AbortSignal = this.controller.signal;
  readonly maxRequests: number;
  readonly #timer: ReturnType<typeof setTimeout>;
  readonly #unlink: () => void;
  #requests = 0;

  constructor(options: OperationBudgetOptions | undefined, attemptTimeout: number, parent?: AbortSignal) {
    this.maxRequests = options?.maxRequests ?? 64;
    const timeout = options?.timeout ?? attemptTimeout * 4;
    if (!Number.isSafeInteger(this.maxRequests) || this.maxRequests < 1) {
      throw new Error("operationBudget.maxRequests must be a positive safe integer.");
    }
    if (!Number.isFinite(timeout) || timeout <= 0) {
      throw new Error("operationBudget.timeout must be a positive finite number.");
    }
    const abort = (): void => this.controller.abort(parent?.reason);
    if (parent?.aborted) abort();
    else parent?.addEventListener("abort", abort, { once: true });
    this.#unlink = () => parent?.removeEventListener("abort", abort);
    this.#timer = setTimeout(() => this.controller.abort(new TimeoutError(timeout)), timeout);
    this.#timer.unref?.();
  }

  get remaining(): number {
    return this.maxRequests - this.#requests;
  }

  check(): void {
    if (this.signal.aborted) throw abortError(this.signal);
    if (this.remaining === 0) throw new OperationBudgetExceededError(this.maxRequests);
  }

  take(): void {
    this.check();
    this.#requests += 1;
  }

  close(): void {
    clearTimeout(this.#timer);
    this.#unlink();
  }
}
