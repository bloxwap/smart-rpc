import { describe, expect, test } from "vitest";

import { classifyRpcError, isProviderRestriction, isRateLimitError, shouldFailover, type RpcEvent } from "../src/index.js";
import { pool } from "./helpers.js";

/** A JSON-RPC error as a plain transport reports it. */
const rpcError = (code: number, message: string, data?: unknown): Error =>
  Object.assign(new Error(message), { code }, data === undefined ? {} : { data });

/** The shape viem throws: a wrapper with a short message, the server message in `details`, `data` on the cause. */
function viemError(code: number, message: string, data?: unknown, status?: number): Error {
  const cause = Object.assign(new Error(`RPC Request failed.\n\nURL: https://rpc.example\nRequest body: {"method":"eth_getLogs"}\n\nDetails: ${message}`), {
    shortMessage: "RPC Request failed.", details: message, code, data, status,
  });
  return Object.assign(new Error(`Invalid parameters were provided to the RPC method.\n\nDetails: ${message}`, { cause }), {
    shortMessage: "Invalid parameters were provided to the RPC method.", details: message, code,
  });
}

describe("provider restrictions fail over without counting against the endpoint", () => {
  test.each([
    ["PublicNode archive token", rpcError(-32602, "Archive requests require a personal token")],
    ["PublicNode indexed token (Solana)", rpcError(-32602, "Indexed requests require a personal token")],
    ["PublicNode request blocked", rpcError(-32602, "Request blocked")],
    ["PublicNode address-less logs", rpcError(-32701, "Please specify an address in your request or, to remove restrictions, order a dedicated full node here: https://www.allnodes.com/")],
    ["Pocket address-less logs", rpcError(-32602, "invalid argument 0: missing required field 'address' for log filter")],
    ["Pocket deliverable ceiling in data", viemError(-32602, "request declined: this endpoint will not serve this request", "response 7340032 bytes exceeds the deliverable ceiling; narrow the query or reduce the block range")],
    ["Pocket/Tenderly/dRPC result cap", rpcError(-32602, "query exceeds max results 20000, retry with the range 24000000-24000099")],
    ["Pocket Solana method", rpcError(-32602, "getProgramAccounts is not served by this endpoint")],
    ["Pocket Solana mint filter", rpcError(-32602, "getProgramAccounts for the token program requires a mint filter on this endpoint")],
    ["Sentio 429 log range", Object.assign(rpcError(-32000, "public eth_getLogs is limited to 1000 blocks", { code: 8 }), { status: 429 })],
    ["thirdweb -32005 log size", rpcError(-32005, "Log response size exceeded. Maximum allowed number of requested blocks is 112")],
    ["dRPC free-plan range", rpcError(35, "ranges over 10000 blocks are not supported on free plan")],
    ["block range limit", rpcError(-32000, "block range is too wide, maximum is 1000")],
  ])("%s", (_name, error) => {
    expect(classifyRpcError(error)).toBe("restriction");
    expect(isProviderRestriction(error)).toBe(true);
    expect(shouldFailover(error)).toBe(true);
  });
});

describe("caller mistakes stay terminal, so a bad request is never fanned out", () => {
  test.each([
    ["malformed address", rpcError(-32602, "invalid argument 0: hex string has length 39, want 40 for common.Address")],
    ["bare invalid params", rpcError(-32602, "invalid params")],
    ["viem-wrapped invalid params", viemError(-32602, "invalid argument 1: hex number with leading zero digits")],
    ["parse error", rpcError(-32700, "parse error")],
    ["revert mentioning a rate limit", rpcError(3, "execution reverted: RateLimiter: too many requests")],
    ["revert mentioning a token", rpcError(-32000, "execution reverted: requires a personal token")],
    ["transaction verdict", rpcError(-32000, "nonce too low")],
  ])("%s", (_name, error) => {
    expect(classifyRpcError(error)).toBe("terminal");
    expect(shouldFailover(error)).toBe(false);
  });
});

describe("rate limits", () => {
  test.each([
    ["HTTP 429 without a message", Object.assign(new Error("HTTP request failed."), { status: 429 })],
    ["HTTP 429 on a cause", new Error("wrapped", { cause: Object.assign(new Error("HTTP request failed."), { status: 429 }) })],
    ["dRPC wording", rpcError(-32000, "You reached Public endpoint rate limit")],
    ["EIP-1474 limit exceeded", rpcError(-32005, "limit exceeded")],
    ["HyperEVM official", rpcError(-32000, "Request exceeds defined limit")],
    ["QuickNode", rpcError(-32007, "15/second request limit reached - reduce calls per second or upgrade your account")],
    ["requests per second", rpcError(-32000, "you are limited to 10 requests per second")],
  ])("%s", (_name, error) => {
    expect(classifyRpcError(error)).toBe("rate-limit");
    expect(isRateLimitError(error)).toBe(true);
    expect(shouldFailover(error)).toBe(true);
  });

  test("an outage is a failure, and a block the node lacks is a miss", () => {
    expect(classifyRpcError(new Error("fetch failed"))).toBe("failure");
    expect(classifyRpcError(Object.assign(new Error("HTTP request failed."), { status: 503 }))).toBe("failure");
    // Naming the endpoint is not a policy: an outage reported this way must still count against it.
    expect(classifyRpcError(rpcError(-32000, "service temporarily unavailable on this endpoint"))).toBe("failure");
    expect(classifyRpcError(rpcError(-32000, "header not found"))).toBe("not-held");
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(classifyRpcError(abort)).toBe("abort");
  });
});

describe("pool handling of provider restrictions", () => {
  const read = { method: "eth_getLogs", params: [{ fromBlock: "0x10", toBlock: "0x20" }] };
  const filtered = { method: "eth_getLogs", params: [{ address: "0xabc", fromBlock: "0x10", toBlock: "0x20" }] };

  let clock = 0;

  /** PublicNode's rule: address-less log filters are refused. Weighted so it leads whenever it is not avoided. */
  function restrictive(onRestricted: () => void) {
    return {
      id: "publicnode",
      url: "publicnode",
      weight: 10,
      call: async ({ params }: { method: string; params?: unknown }) => {
        clock += 10;
        const filter = (params as [{ address?: string }])[0];
        if (filter.address === undefined) {
          onRestricted();
          throw rpcError(-32701, "Please specify an address in your request");
        }
        return ["publicnode-log"];
      },
    };
  }

  test("a restriction fails over, is never ejected, leaves the score alone, and is not led with again", async () => {
    let refusals = 0;
    const events: RpcEvent[] = [];
    const client = pool([
      restrictive(() => { refusals += 1; }),
      { id: "other", url: "other", call: async () => { clock += 100; return ["other-log"]; } },
    ], { routing: "best", onEvent: (event) => events.push(event), now: () => clock });

    await expect(client.request(read)).resolves.toEqual(["other-log"]);
    expect(refusals).toBe(1);
    const row = client.snapshot("eth_getLogs").find((entry) => entry.id === "publicnode");
    expect(row?.ejected).toBe(false);
    expect(row?.methods["*"]?.error ?? 0).toBe(0);
    expect(events).toContainEqual(expect.objectContaining({ type: "error", endpoint: "publicnode", terminal: false }));

    // Many more address-less queries: the refusing endpoint is not asked again, and never ejected.
    for (let index = 0; index < 5; index += 1) await expect(client.request(read)).resolves.toEqual(["other-log"]);
    expect(refusals).toBe(1);
    expect(events.some((event) => event.type === "eject")).toBe(false);

    // The same endpoint still leads a query of another shape (with an address).
    await expect(client.request(filtered)).resolves.toEqual(["publicnode-log"]);
    client.close();
  });

  test("an endpoint that refuses even the head probe is failing, not restricted, and is ejected", async () => {
    const events: RpcEvent[] = [];
    const client = pool([
      { id: "blocked", url: "blocked", call: async () => { throw rpcError(-32602, "Request blocked"); } },
      { id: "ok", url: "ok", call: async () => "0x10" },
    ], { onEvent: (event) => events.push(event), now: () => 0 });
    for (let index = 0; index < 5; index += 1) await client.probe();
    expect(client.snapshot().find((row) => row.id === "blocked")?.ejected).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({ type: "eject", endpoint: "blocked" }));
    client.close();
  });

  test("a refused oversized range does not stop the endpoint leading a small range of the same filter", async () => {
    let refusals = 0;
    const span = (filter: { fromBlock: string; toBlock: string }): number =>
      Number.parseInt(filter.toBlock, 16) - Number.parseInt(filter.fromBlock, 16) + 1;
    const client = pool([
      {
        id: "capped", url: "capped", weight: 10,
        call: async ({ params }: { method: string; params?: unknown }) => {
          clock += 10;
          if (span((params as [{ fromBlock: string; toBlock: string }])[0]) > 1_000) {
            refusals += 1;
            throw rpcError(-32000, "block range is too wide, maximum is 1000");
          }
          return ["capped-log"];
        },
      },
      { id: "other", url: "other", call: async () => { clock += 100; return ["other-log"]; } },
    ], { routing: "best", now: () => clock });

    const large = { method: "eth_getLogs", params: [{ address: "0xabc", fromBlock: "0x1000", toBlock: "0x2387" }] };
    const small = { method: "eth_getLogs", params: [{ address: "0xabc", fromBlock: "0x1000", toBlock: "0x1031" }] };
    await expect(client.request(large)).resolves.toEqual(["other-log"]);
    await expect(client.request(large)).resolves.toEqual(["other-log"]);
    expect(refusals).toBe(1);
    await expect(client.request(small)).resolves.toEqual(["capped-log"]);
    client.close();
  });

  test("when the only endpoints refuse, the call fails after one try each instead of retrying them", async () => {
    let refusals = 0;
    const client = pool([restrictive(() => { refusals += 1; })], { retryCount: 3, now: () => 0 });
    await expect(client.request(read)).rejects.toThrow("Please specify an address");
    expect(refusals).toBe(1);
    client.close();
  });

  test("a genuinely invalid request is answered once and not fanned out to every endpoint", async () => {
    const seen: string[] = [];
    const client = pool(["a", "b", "c"].map((id) => ({
      id, url: id,
      call: async () => {
        seen.push(id);
        throw rpcError(-32602, "invalid argument 0: hex string has length 39, want 40 for common.Address");
      },
    })), { routing: "best", retryCount: 2, now: () => 0 });
    await expect(client.request({ method: "eth_getBalance", params: ["0xabc", "latest"] })).rejects.toThrow("hex string");
    expect(seen).toEqual(["a"]);
    expect(client.snapshot().find((row) => row.id === "a")?.ejected).toBe(false);
    client.close();
  });
});
