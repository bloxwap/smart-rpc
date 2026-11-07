/**
 * Child connections for EVM endpoints.
 * HTTP uses viem `http()`. WebSocket uses viem `webSocket()`. The pool does not open its own sockets.
 * @module
 */

import { http, webSocket, type WebSocketTransport, type WebSocketTransportConfig } from "viem";

import { abortError, isIdempotentMethod, parseQuantity, retryAfterMs, type EndpointCall } from "@smart-rpc/core";

type SocketValue = NonNullable<ReturnType<WebSocketTransport>["value"]>;
export type EthereumSubscriptionOptions = Parameters<SocketValue["subscribe"]>[0];
export type EthereumSubscription = Awaited<ReturnType<SocketValue["subscribe"]>>;

export interface ViemConnectionOptions {
  timeout: number;
  batch?: boolean | { batchSize?: number; wait?: number } | undefined;
  fetchFn?: ((input: string | URL | Request, init?: RequestInit) => Promise<Response>) | undefined;
  headers?: Readonly<Record<string, string>> | undefined;
  /** Required for a dedicated subscription session, verified on its own connection. */
  expectedChainId?: number | undefined;
  reconnect?: WebSocketTransportConfig["reconnect"] | undefined;
}

export interface ViemConnection {
  url: string;
  kind: "http" | "websocket";
  call: EndpointCall;
  /** Milliseconds left of a recorded `Retry-After`. Reading it clears it. */
  retryAfter: () => number;
  /** Dedicated WS session: viem owns reconnect/resubscribe on this same endpoint. */
  subscribe: (options: EthereumSubscriptionOptions) => Promise<EthereumSubscription>;
  /** Stop owned subscriptions; never close viem's URL-shared socket for other clients. */
  close: () => void;
}

/** Build the viem child transport for one URL and adapt it to a pool call. */
export function connectViem(url: string, options: ViemConnectionOptions): ViemConnection {
  const parsed = new URL(url);
  const websocket = parsed.protocol === "wss:" || parsed.protocol === "ws:";
  const httpProtocol = parsed.protocol === "https:" || parsed.protocol === "http:";
  if (!websocket && !httpProtocol) {
    throw new Error(`RPC URL must be http(s) or ws(s): ${parsed.protocol}`);
  }
  const hint = retryHint();
  if (websocket && options.headers && Object.keys(options.headers).length > 0) {
    throw new Error("WebSocket headers are not supported by viem's browser-compatible transport. Use a provider's documented authenticated WS URL.");
  }
  const transport = websocket
    ? webSocket(url, { retryCount: 0, timeout: options.timeout, reconnect: options.reconnect ?? true })
    : http(url, {
        batch: options.batch,
        fetchFn: options.fetchFn,
        fetchOptions: { headers: options.headers },
        onFetchResponse: hint.record,
        retryCount: 0,
        timeout: options.timeout,
      });
  const instance = transport({ retryCount: 0, timeout: options.timeout });
  const request = instance.request.bind(instance);
  const batches = new BatchCancellation();
  const subscriptions = new Set<EthereumSubscription>();
  let closed = false;
  return {
    url,
    kind: websocket ? "websocket" : "http",
    retryAfter: hint.take,
    close(): void {
      if (closed) return;
      closed = true;
      batches.close();
      for (const subscription of subscriptions) void subscription.unsubscribe().catch(() => undefined);
      subscriptions.clear();
    },
    async subscribe(args): Promise<EthereumSubscription> {
      if (closed) throw new Error("Connection is closed.");
      const value = instance.value;
      if (!websocket || !value || !("subscribe" in value)) throw new Error("Subscriptions require a documented WebSocket endpoint.");
      if (options.expectedChainId === undefined) throw new Error("Subscriptions require expectedChainId for connection identity verification.");
      const identity = await request({ method: "eth_chainId" });
      if (parseQuantity(identity) !== options.expectedChainId) throw new Error("Subscription endpoint returned a different chain identity.");
      if (closed) throw new Error("Connection is closed.");
      const upstream = await value.subscribe(args);
      let released = false;
      const owned: EthereumSubscription = {
        get subscriptionId() { return upstream.subscriptionId; },
        unsubscribe() {
          released = true;
          subscriptions.delete(owned);
          return upstream.unsubscribe();
        },
      };
      if (closed) {
        await owned.unsubscribe();
        throw new Error("Connection closed while subscribing.");
      }
      if (!released) subscriptions.add(owned);
      return owned;
    },
    call: async (args, callOptions) => {
      if (closed) throw new Error("Connection is closed.");
      try {
        const body = { method: args.method, params: args.params ?? [] } as Parameters<typeof request>[0];
        if (!websocket && options.batch && isIdempotentMethod(args.method)) {
          // viem groups by URL and signal. A connection-local shared signal permits a
          // real wire batch without one cancelled caller aborting its live neighbors.
          return await batches.run(callOptions?.signal, (signal) => request(body, { signal }));
        }
        return await request(
          body,
          // Stateful calls and writes never join another caller's cancellation group.
          // A unique signal also prevents viem mixing credentials across connections.
          { signal: callOptions?.signal ?? new AbortController().signal },
        );
      } catch (error) {
        const waited = hint.take();
        if (waited > 0) attachRetryAfter(error, waited);
        throw error;
      }
    },
  };
}

interface BatchGroup {
  controller: AbortController;
  members: number;
}

/** Cancellation ownership around viem's scheduler, without implementing another batcher. */
class BatchCancellation {
  #current: BatchGroup | undefined;

  close(): void {
    this.#current?.controller.abort(new Error("Connection is closed."));
    this.#current = undefined;
  }

  run<T>(signal: AbortSignal | undefined, send: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (signal?.aborted) return Promise.reject(abortError(signal));
    const group = this.#current ?? { controller: new AbortController(), members: 0 };
    this.#current = group;
    group.members += 1;
    return new Promise<T>((resolve, reject) => {
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        signal?.removeEventListener("abort", onAbort);
        group.members -= 1;
        if (group.members === 0) {
          if (this.#current === group) this.#current = undefined;
          // Completed participants no longer need the request either. Only the last
          // participant can abort the wire request shared by this group's batches.
          group.controller.abort();
        }
      };
      const onAbort = (): void => {
        reject(signal ? abortError(signal) : new Error("This operation was aborted"));
        release();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      Promise.resolve().then(() => send(group.controller.signal)).then(
        (value) => { resolve(value); release(); },
        (error: unknown) => { reject(error); release(); },
      );
    });
  }
}

function retryHint(): { record: (response: Response) => void; take: () => number } {
  let until = 0;
  return {
    record(response: Response): void {
      if (response.status !== 429 && response.status !== 503) return;
      const asked = retryAfterMs({ headers: response.headers }, Date.now());
      if (asked > 0) until = Math.max(until, Date.now() + asked);
    },
    take(): number {
      const left = Math.max(0, until - Date.now());
      until = 0;
      return left;
    },
  };
}

function attachRetryAfter(error: unknown, ms: number): void {
  if (typeof error !== "object" || error === null) return;
  if (retryAfterMs(error) > 0) return;
  const seconds = Math.max(1, Math.ceil(ms / 1_000));
  Object.defineProperty(error, "headers", {
    configurable: true,
    value: new Headers({ "retry-after": String(seconds) }),
  });
}
