import type { EndpointCall } from "@smart-rpc/core";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

let nextId = 1;

/** JSON-RPC over HTTP. Solana does not use viem. */
export function jsonRpcCaller(url: string, fetchFn: FetchLike = fetch): EndpointCall {
  return async (request, options) => {
    const response = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: nextId++,
        method: request.method,
        params: request.params ?? [],
      }),
      signal: options?.signal,
    });
    const text = await response.text();
    let body: { result?: unknown; error?: { code?: number; message?: string } } | undefined;
    if (text !== "") {
      try {
        body = JSON.parse(text) as { result?: unknown; error?: { code?: number; message?: string } };
      } catch {
        body = undefined;
      }
    }
    if (!response.ok || body?.error) {
      const error = new Error(body?.error?.message ?? `Solana RPC HTTP ${response.status}`);
      if (typeof body?.error?.code === "number") {
        Object.defineProperty(error, "code", { value: body.error.code });
      }
      Object.defineProperty(error, "headers", { value: response.headers });
      throw error;
    }
    return body?.result;
  };
}
