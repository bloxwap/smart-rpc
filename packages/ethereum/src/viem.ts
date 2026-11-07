/**
 * Child connections for EVM endpoints.
 * HTTP uses viem `http()`. WebSocket uses viem `webSocket()`. The pool does not open its own sockets.
 * @module
 */

import { http, webSocket, type WebSocketTransport } from "viem";

import { parseQuantity, retryAfterMs, type EndpointCall } from "@smart-rpc/core";

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
  reconnect?: Parameters<typeof webSocket>[1] extends infer C ? C extends { reconnect?: infer R } ? R : never : never;
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
  const subscriptions = new Set<EthereumSubscription>();
  let closed = false;
  return {
    url,
    kind: websocket ? "websocket" : "http",
    retryAfter: hint.take,
    close(): void {
      if (closed) return;
      closed = true;
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
        return await request(
          { method: args.method, params: args.params ?? [] } as Parameters<typeof request>[0],
          callOptions?.signal ? { signal: callOptions.signal } : undefined,
        );
      } catch (error) {
        const waited = hint.take();
        if (waited > 0) attachRetryAfter(error, waited);
        throw error;
      }
    },
  };
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
