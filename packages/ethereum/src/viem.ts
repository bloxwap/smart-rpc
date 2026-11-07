/**
 * Child connections for EVM endpoints.
 * HTTP uses viem `http()`. WebSocket uses viem `webSocket()`. The pool does not open its own sockets.
 * @module
 */

import { http, webSocket, type Transport } from "viem";

import { retryAfterMs, type EndpointCall } from "@smart-rpc/core";

export interface ViemConnectionOptions {
  timeout: number;
  batch?: boolean | { batchSize?: number; wait?: number } | undefined;
  fetchFn?: ((input: string | URL | Request, init?: RequestInit) => Promise<Response>) | undefined;
}

export interface ViemConnection {
  url: string;
  kind: "http" | "websocket";
  call: EndpointCall;
  /** Milliseconds left of a recorded `Retry-After`. Reading it clears it. */
  retryAfter: () => number;
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
  const transport: Transport = websocket
    ? webSocket(url, { retryCount: 0, timeout: options.timeout })
    : http(url, {
        batch: options.batch,
        fetchFn: options.fetchFn,
        onFetchResponse: hint.record,
        retryCount: 0,
        timeout: options.timeout,
      });
  const instance = transport({ retryCount: 0, timeout: options.timeout });
  const request = instance.request.bind(instance);
  return {
    url,
    kind: websocket ? "websocket" : "http",
    retryAfter: hint.take,
    call: async (args, callOptions) => {
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
