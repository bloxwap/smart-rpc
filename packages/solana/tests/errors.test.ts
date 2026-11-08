import { describe, expect, test } from "vitest";

import { isProviderRestriction, isRateLimitError, type RpcEvent } from "@smart-rpc/core";

import { jsonRpcCaller, solana } from "../src/index.js";
import { isHeadSensitiveSolanaMethod, isSolanaRateLimit } from "../src/methods.js";

const result = (value: unknown): Response => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: value }));
async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof Error) return error;
  }
  throw new Error("Expected the call to reject with an Error.");
}

const failure = (code: number, message: string, status = 200): Response =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code, message } }), { status });

describe("Solana error bodies", () => {
  test("a gateway body without the JSON-RPC envelope keeps its reason in details", async () => {
    const call = jsonRpcCaller("https://rpc.example", async () =>
      new Response(JSON.stringify({ code: 8, message: "getProgramAccounts is not served by this endpoint" }), { status: 400 }));
    const error = await rejection(call({ method: "getProgramAccounts" }));
    expect(error).toMatchObject({ message: "Solana RPC HTTP 400", status: 400, details: "getProgramAccounts is not served by this endpoint" });
    expect(isProviderRestriction(error)).toBe(true);
  });

  test("a plain-text 429 is a rate limit; a -32005 unhealthy node is a failure, not a rate limit", async () => {
    const limited = await rejection(
      jsonRpcCaller("https://rpc.example", async () => new Response("Too many requests", { status: 429 }))({ method: "getSlot" }),
    );
    expect(isSolanaRateLimit(limited)).toBe(true);
    const unhealthy = await rejection(
      jsonRpcCaller("https://rpc.example", async () => failure(-32005, "Node is unhealthy"))({ method: "getSlot" }),
    );
    expect(isRateLimitError(unhealthy)).toBe(true);
    expect(isSolanaRateLimit(unhealthy)).toBe(false);
  });

  test("head-sensitive reads are the ones that follow the newest slot", () => {
    expect(isHeadSensitiveSolanaMethod("getBalance", ["key"])).toBe(true);
    expect(isHeadSensitiveSolanaMethod("getLatestBlockhash", [{ commitment: "confirmed" }])).toBe(true);
    expect(isHeadSensitiveSolanaMethod("getSlot", [])).toBe(true);
    expect(isHeadSensitiveSolanaMethod("getBalance", ["key", { commitment: "finalized" }])).toBe(false);
    expect(isHeadSensitiveSolanaMethod("getTransaction", ["sig"])).toBe(false);
    expect(isHeadSensitiveSolanaMethod("getBlock", [100])).toBe(false);
  });
});

describe("Solana pool", () => {
  const deterministic = { verifyIdentity: false, routing: "best" as const, race: false, cache: false, headLag: { probeInterval: false as const } };

  test("PublicNode's token-gated -32602 fails over instead of reaching the caller, and is not counted as a failure", async () => {
    const events: RpcEvent[] = [];
    const seen: string[] = [];
    const client = solana({
      ...deterministic,
      onEvent: (event) => events.push(event),
      endpoints: ["https://publicnode.example", "https://other.example"],
      fetchFn: async (input) => {
        const host = new URL(String(input)).host;
        seen.push(host);
        return host === "publicnode.example" ? failure(-32602, "Indexed requests require a personal token") : result({ value: [] });
      },
    });
    try {
      await expect(client.request({ method: "getTokenLargestAccounts", params: ["mint"] })).resolves.toEqual({ value: [] });
      expect(seen).toEqual(["publicnode.example", "other.example"]);
      expect(client.snapshot().find((row) => row.url === "https://publicnode.example")?.methods["*"]?.error ?? 0).toBe(0);
      expect(events.some((event) => event.type === "eject" || event.type === "throttle")).toBe(false);
    } finally {
      client.close();
    }
  });

  test("a genuinely invalid request stays terminal and is sent once", async () => {
    const seen: string[] = [];
    const client = solana({
      ...deterministic,
      endpoints: ["https://a.example", "https://b.example"],
      fetchFn: async (input) => {
        seen.push(new URL(String(input)).host);
        return failure(-32602, "Invalid param: WrongSize");
      },
    });
    try {
      await expect(client.request({ method: "getBalance", params: ["short"] })).rejects.toThrow("WrongSize");
      expect(seen).toEqual(["a.example"]);
    } finally {
      client.close();
    }
  });

  test("a slot-lagging endpoint does not lead head reads: about one second of 220ms slots is tolerated", async () => {
    const leader = async (behind: number): Promise<string | undefined> => {
      const reads: string[] = [];
      const client = solana({
        ...deterministic,
        endpoints: [{ url: "https://behind.example", weight: 100 }, { url: "https://ahead.example" }],
        fetchFn: async (input, init) => {
          const host = new URL(String(input)).host;
          const method = (JSON.parse(String(init?.body)) as { method: string }).method;
          if (method === "getSlot") return result(host === "behind.example" ? 1_000 - behind : 1_000);
          reads.push(host);
          return result({ value: 1 });
        },
      });
      try {
        await client.probe();
        await client.request({ method: "getBalance", params: ["key"] });
        return reads[0];
      } finally {
        client.close();
      }
    };
    expect(await leader(5)).toBe("behind.example");
    expect(await leader(6)).toBe("ahead.example");
  });
});
