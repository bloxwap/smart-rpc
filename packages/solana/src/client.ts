import type { EndpointCall } from "@smart-rpc/core";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

let nextId = 1;

/** JSON-RPC over HTTP. Solana does not use viem. */
export function jsonRpcCaller(url: string, fetchFn: FetchLike = fetch): EndpointCall {
  return async (request, options) => {
    const id = nextId++;
    const response = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: request.method,
        params: request.params ?? [],
      }),
      signal: options?.signal,
    });
    const text = await response.text();
    let body: unknown;
    if (text !== "") {
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
    }
    const envelope = isRecord(body) ? body : undefined;
    const jsonRpc = envelope !== undefined && (
      Object.hasOwn(envelope, "result") || Object.hasOwn(envelope, "error") || envelope.jsonrpc !== undefined || envelope.id !== undefined
    );
    if (jsonRpc && (envelope?.jsonrpc !== "2.0" || !sameRpcId(envelope?.id, id))) {
      throw responseError("Solana RPC returned an invalid JSON-RPC response: mismatched id.", response);
    }
    if (!response.ok || (envelope && Object.hasOwn(envelope, "error"))) {
      const rpcError = isRecord(envelope?.error) ? envelope.error : undefined;
      const message = typeof rpcError?.message === "string"
        ? rpcError.message
        : !response.ok
          ? `Solana RPC HTTP ${response.status}`
          : "Solana RPC returned an invalid JSON-RPC error.";
      const error = responseError(message, response);
      if (typeof rpcError?.code === "number") {
        Object.defineProperty(error, "code", { value: rpcError.code });
      }
      if (rpcError && Object.hasOwn(rpcError, "data")) {
        Object.defineProperty(error, "data", { value: rpcError.data });
      }
      throw error;
    }
    // A proxy's HTTP 200 page must fail over, not become a cached undefined result.
    // Null, false, zero, and empty strings are valid JSON-RPC results.
    if (!envelope || !Object.hasOwn(envelope, "result")) {
      throw responseError("Solana RPC returned an invalid JSON-RPC response: missing result.", response);
    }
    return envelope.result;
  };
}

function sameRpcId(received: unknown, sent: number): boolean {
  return received === sent;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function responseError(message: string, response: Response): Error {
  const error = new Error(message);
  Object.defineProperty(error, "headers", { value: response.headers });
  Object.defineProperty(error, "status", { value: response.status });
  return error;
}
