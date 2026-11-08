import { describe, expect, test } from "vitest";

import type { RpcEvent } from "@smart-rpc/core";

import { ethereum } from "../src/index.js";

type Answer = Response | unknown;

/** A fetch that answers per URL and method; non-Response answers become JSON-RPC results. */
function wire(answer: (url: string, method: string) => Answer) {
  const calls: { url: string; method: string }[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input)).href;
    const body = JSON.parse(String(init?.body)) as { id: number; method: string };
    calls.push({ url, method: body.method });
    const value = answer(url, body.method);
    if (value instanceof Response) return value;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: value }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetchFn, calls };
}

const quiet = { headLag: { probeInterval: false as const }, race: false, cache: false, routing: "best" as const };
const logs = { method: "eth_getLogs", params: [{ fromBlock: "0x1", toBlock: "0x900" }] };

describe("provider error bodies", () => {
  test.each(["application/json", "text/plain; charset=utf-8"])("Sentio's HTTP 429 log-range body (%s) is a restriction: it fails over without a cooldown or a strike", async (contentType) => {
    const events: RpcEvent[] = [];
    const { fetchFn, calls } = wire((url, method) => {
      if (method === "eth_chainId") return "0x1";
      if (url.startsWith("https://sentio.example")) {
        return new Response(JSON.stringify({ code: 8, message: "public eth_getLogs is limited to 1000 blocks" }), {
          status: 429, headers: { "content-type": contentType, "content-length": "77" },
        });
      }
      return [];
    });
    const pool = ethereum({
      ...quiet, fetchFn, onEvent: (event) => events.push(event),
      endpoints: ["https://sentio.example/rpc", "https://other.example/rpc"],
    });
    try {
      await expect(pool.request(logs)).resolves.toEqual([]);
      expect(calls.filter((call) => call.method === "eth_getLogs").map((call) => new URL(call.url).host))
        .toEqual(["sentio.example", "other.example"]);
      expect(events.some((event) => event.type === "throttle" || event.type === "eject")).toBe(false);
      const refused = events.find((event) => event.type === "error" && event.endpoint === "https://sentio.example/rpc");
      expect(refused?.type === "error" ? String(refused.error.message) : "").toContain("limited to 1000 blocks");
      const row = pool.snapshot().find((entry) => entry.url === "https://sentio.example/rpc");
      expect(row).toMatchObject({ ejected: false, throttledMs: 0 });
    } finally {
      pool.close();
    }
  });

  test("a plain HTTP 429 is a rate limit: the endpoint cools down for its Retry-After and is not ejected", async () => {
    const events: RpcEvent[] = [];
    const { fetchFn } = wire((url, method) => {
      if (method === "eth_chainId") return "0x1";
      if (url.startsWith("https://busy.example")) {
        return new Response(JSON.stringify({ message: "You reached Public endpoint rate limit" }), {
          status: 429, headers: { "content-type": "application/json", "retry-after": "7" },
        });
      }
      return "0x5";
    });
    const pool = ethereum({
      ...quiet, fetchFn, onEvent: (event) => events.push(event),
      endpoints: ["https://busy.example/rpc", "https://other.example/rpc"],
    });
    try {
      await expect(pool.request({ method: "eth_getBalance", params: ["0x0000000000000000000000000000000000000001", "latest"] }))
        .resolves.toBe("0x5");
      expect(events).toContainEqual(expect.objectContaining({ type: "throttle", endpoint: "https://busy.example/rpc", cooldownMs: 7_000 }));
      expect(pool.snapshot().find((entry) => entry.url === "https://busy.example/rpc")?.ejected).toBe(false);
    } finally {
      pool.close();
    }
  });
});

describe("blockTimeMs", () => {
  test("sets the lag tolerance to about one second of blocks", async () => {
    // Two endpoints whose heads differ by four blocks. At 250ms blocks that is one second: caught up.
    // With no block time the two-block default applies and the behind endpoint does not lead head reads.
    const leader = async (blockTimeMs: number | undefined): Promise<string | undefined> => {
      const reads: string[] = [];
      const { fetchFn } = wire((url, method) => {
        if (method === "eth_chainId") return "0x1";
        if (method === "eth_blockNumber") return url.startsWith("https://behind.example") ? "0x60" : "0x64";
        if (method === "eth_getBalance") reads.push(new URL(url).host);
        return "0x0";
      });
      const pool = ethereum({
        ...quiet, fetchFn, pinLatest: false, blockTimeMs,
        endpoints: [{ url: "https://behind.example/rpc", weight: 100 }, "https://ahead.example/rpc"],
      });
      try {
        await pool.probe();
        await pool.request({ method: "eth_getBalance", params: ["0x0000000000000000000000000000000000000002", "latest"] });
        return reads[0];
      } finally {
        pool.close();
      }
    };
    expect(await leader(250)).toBe("behind.example");
    expect(await leader(undefined)).toBe("ahead.example");
  });
});
