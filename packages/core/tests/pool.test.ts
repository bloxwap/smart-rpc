import { afterEach, describe, expect, test, vi } from "vitest";

import { AllEndpointsFailedError, TimeoutError } from "../src/errors.js";
import { backoffMs } from "../src/retry.js";
import { DEFAULT_RETRY_BACKOFF_MS, DEFAULT_TIMEOUT_MS, MAX_RETRY_BACKOFF_MS } from "../src/constants.js";
import { evmPolicy, pool } from "./helpers.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("backoff", () => {
  test("is half to all of a 100ms exponential, capped at 2s", () => {
    expect(DEFAULT_RETRY_BACKOFF_MS).toBe(100);
    expect(MAX_RETRY_BACKOFF_MS).toBe(2_000);
    expect(DEFAULT_TIMEOUT_MS).toBe(10_000);
    expect(backoffMs(0, 100, () => 0)).toBe(50);
    expect(backoffMs(0, 100, () => 1)).toBe(100);
    expect(backoffMs(1, 100, () => 0)).toBe(100);
    expect(backoffMs(1, 100, () => 1)).toBe(200);
    expect(backoffMs(10, 100, () => 1)).toBe(2_000);
  });
});

describe("retries", () => {
  test("fails over immediately when another endpoint is up", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const seen: string[] = [];
    const client = pool(
      [
        {
          id: "down",
          url: "down",
          call: async () => {
            seen.push("down");
            throw new Error("down");
          },
        },
        {
          id: "up",
          url: "up",
          call: async () => {
            seen.push("up");
            return "ok";
          },
        },
      ],
      { now: () => Date.now(), routing: "best", retryCount: 2, retryDelay: 0 },
    );
    const pending = client.request({ method: "eth_call", params: [{ to: "0x1" }] });
    await vi.advanceTimersByTimeAsync(0);
    await expect(pending).resolves.toBe("ok");
    expect(seen).toEqual(["down", "up"]);
    client.close();
  });

  test("retries a single endpoint twice more after jittered 100ms-2s backoff", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const at: number[] = [];
    const client = pool(
      [
        {
          id: "only",
          url: "only",
          call: async () => {
            at.push(Date.now());
            throw new Error("down");
          },
        },
      ],
      { now: () => Date.now(), random: () => 0, routing: "best", retryCount: 2, retryDelay: 0 },
    );
    const pending = client.request({ method: "eth_call", params: [] }).then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(at).toEqual([0]);
    await vi.advanceTimersByTimeAsync(49);
    expect(at).toEqual([0]);
    await vi.advanceTimersByTimeAsync(1);
    expect(at).toEqual([0, 50]);
    await vi.advanceTimersByTimeAsync(99);
    expect(at).toEqual([0, 50]);
    await vi.advanceTimersByTimeAsync(1);
    expect(at).toEqual([0, 50, 150]);
    await expect(pending).resolves.toBeInstanceOf(AllEndpointsFailedError);
    client.close();
  });

  test("times out an attempt at 10s", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const client = pool(
      [{ id: "hang", url: "hang", call: () => new Promise(() => undefined) }],
      { now: () => Date.now(), retryCount: 0, timeout: 10_000 },
    );
    const pending = client.request({ method: "eth_call", params: [] }).then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(9_999);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const error = await pending;
    expect(error).toBeInstanceOf(TimeoutError);
    expect(error).toMatchObject({ timeoutMs: 10_000 });
    client.close();
  });
});

describe("race", () => {
  test("sends a safe read to the top 2 endpoints and a send to one", async () => {
    const seen: string[] = [];
    const endpoints = ["a", "b", "c"].map((id) => ({
      id,
      url: id,
      call: async (request: { method: string }) => {
        seen.push(`${id}:${request.method}`);
        return "0x1";
      },
    }));
    const client = pool(endpoints, { race: true, routing: "best" });
    await client.request({ method: "eth_call", params: [{ to: "0xabc" }, "latest"] });
    expect(seen.filter((call) => call.endsWith(":eth_call")).sort()).toEqual(["a:eth_call", "b:eth_call"]);
    seen.length = 0;
    await client.request({ method: "eth_sendTransaction", params: [{}] });
    expect(seen).toEqual(["a:eth_sendTransaction"]);
    client.close();
  });
});

describe("Retry-After", () => {
  test("ejects the endpoint that asked for it and uses another", async () => {
    const seen: string[] = [];
    const limited = new Error("rate limited");
    Object.defineProperty(limited, "headers", { value: new Headers({ "retry-after": "3" }) });
    const client = pool(
      [
        {
          id: "limited",
          url: "limited",
          call: async () => {
            seen.push("limited");
            throw limited;
          },
        },
        {
          id: "open",
          url: "open",
          call: async () => {
            seen.push("open");
            return "ok";
          },
        },
      ],
      { routing: "best" },
    );
    await expect(client.request({ method: "eth_call", params: [{ to: "0x1" }] })).resolves.toBe("ok");
    expect(client.snapshot("eth_call").find((row) => row.id === "limited")?.ejected).toBe(true);
    seen.length = 0;
    await client.request({ method: "eth_call", params: [{ to: "0x2" }] });
    expect(seen).toEqual(["open"]);
    client.close();
  });
});

describe("health probes", () => {
  test("runs eth_blockNumber every 4s and stops 60s after the last request", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let probes = 0;
    const client = pool(
      [
        {
          id: "a",
          url: "https://a.example",
          call: async (request) => {
            if (request.method === "eth_blockNumber") probes += 1;
            return "0x10";
          },
        },
      ],
      {
        now: () => Date.now(),
        headLag: { probeInterval: 4_000, probeIdleTimeout: 60_000 },
        policy: evmPolicy(),
      },
    );
    await client.request({ method: "eth_call", params: [{ to: "0x1" }] });
    expect(probes).toBe(0);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(probes).toBe(1);
    await vi.advanceTimersByTimeAsync(56_000);
    expect(probes).toBe(14);
    const stopped = probes;
    await vi.advanceTimersByTimeAsync(12_000);
    expect(probes).toBe(stopped);
    client.close();
  });
});

describe("quarantine", () => {
  test("drops an endpoint that reports the wrong eth_chainId", async () => {
    const seen: string[] = [];
    const client = pool(
      [
        {
          id: "wrong",
          url: "wrong",
          call: async (request) => (request.method === "eth_chainId" ? "0x2" : "0x1"),
        },
        {
          id: "right",
          url: "right",
          call: async (request) => {
            if (request.method !== "eth_chainId") seen.push("right");
            return request.method === "eth_chainId" ? "0x1" : "0x11";
          },
        },
      ],
      { verifyIdentity: true, routing: "best", race: false },
    );
    await expect(client.request({ method: "eth_getBalance", params: ["0x0", "latest"] })).resolves.toBe("0x11");
    expect(seen).toEqual(["right"]);
    expect(client.snapshot().find((row) => row.id === "wrong")?.quarantined).toBe(true);
    seen.length = 0;
    await client.request({ method: "eth_getBalance", params: ["0x0", "latest"] });
    expect(seen).toEqual(["right"]);
    client.close();
  });
});

describe("pin", () => {
  test("pins latest to a block the lagging endpoint is not known to hold", async () => {
    const seen: { id: string; params: unknown }[] = [];
    const client = pool(
      [
        {
          id: "behind",
          url: "behind",
          call: async (request) => {
            if (request.method === "eth_blockNumber") return "0x8";
            seen.push({ id: "behind", params: request.params });
            return "0x1";
          },
        },
        {
          id: "tip",
          url: "tip",
          call: async (request) => {
            if (request.method === "eth_blockNumber") return "0xc";
            seen.push({ id: "tip", params: request.params });
            return "0x1";
          },
        },
      ],
      { verifyIdentity: false, routing: "best", race: true, cache: false },
      evmPolicy(1, { freshMs: 1_000 }),
    );
    await client.probe();
    await client.request({ method: "eth_call", params: [{ to: "0xabc" }, "latest"] });
    expect(seen).toEqual([{ id: "tip", params: [{ to: "0xabc" }, "0xc"] }]);
    client.close();
  });
});

describe("coalesce", () => {
  test("identical in-flight reads share one upstream call", async () => {
    let calls = 0;
    let release: (value: string) => void = () => undefined;
    const gate = new Promise<string>((resolve) => {
      release = resolve;
    });
    const client = pool(
      [
        {
          id: "a",
          url: "a",
          call: () => {
            calls += 1;
            return gate;
          },
        },
      ],
      { coalesce: true },
    );
    const first = client.request({ method: "eth_chainId", params: [] });
    const second = client.request({ method: "eth_chainId", params: [] });
    await Promise.resolve();
    expect(calls).toBe(1);
    release("0x1");
    await expect(first).resolves.toBe("0x1");
    await expect(second).resolves.toBe("0x1");
    client.close();
  });
});
