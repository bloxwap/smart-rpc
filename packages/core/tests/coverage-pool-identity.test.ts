import { afterEach, describe, expect, test, vi } from "vitest";

import {
  AllEndpointsFailedError,
  ChainMismatchError,
  OperationBudgetExceededError,
} from "../src/errors.js";
import type { RpcEvent } from "../src/events.js";
import type { PoolEndpointConfig } from "../src/types.js";
import { pool } from "./helpers.js";

afterEach(() => {
  vi.useRealTimers();
});

const read = { method: "eth_getBalance", params: ["0x1", "latest"] };

interface Node {
  config: PoolEndpointConfig;
  calls: string[];
  count: (method: string) => number;
}

/** An endpoint whose answers come from `answer`. A thrown value fails the call. */
function node(id: string, answer: (method: string, nth: number) => unknown, extra: Partial<PoolEndpointConfig> = {}): Node {
  const calls: string[] = [];
  const count = (method: string): number => calls.filter((call) => call === method).length;
  return {
    calls,
    count,
    config: {
      id,
      url: id,
      call: async ({ method }) => {
        calls.push(method);
        return answer(method, count(method));
      },
      ...extra,
    },
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function recorder(): { events: RpcEvent[]; onEvent: (event: RpcEvent) => void; of: (type: RpcEvent["type"]) => RpcEvent[] } {
  const events: RpcEvent[] = [];
  return {
    events,
    onEvent: (event) => events.push(event),
    of: (type) => events.filter((event) => event.type === type),
  };
}

describe("chain identity", () => {
  test("a quarantined endpoint is never asked for its identity again", async () => {
    const wrong = node("wrong", (method) => (method === "eth_chainId" ? "0x2" : "0x10"));
    const log = recorder();
    const client = pool([wrong.config], { verifyIdentity: true, onEvent: log.onEvent });
    await client.probe();
    expect(log.of("quarantine")).toMatchObject([{ endpoint: "wrong", reported: 2, expected: 1 }]);
    expect(client.snapshot()[0]?.quarantined).toBe(true);
    await client.probe();
    await client.probe();
    expect(wrong.calls).toEqual(["eth_chainId"]);
    await expect(client.request(read)).rejects.toBeInstanceOf(ChainMismatchError);
    expect(wrong.calls).toEqual(["eth_chainId"]);
    client.close();
  });

  test("a call no healthy endpoint supports reports the quarantine, not the capability gap", async () => {
    const wrong = node("wrong", (method) => (method === "eth_chainId" ? "0x2" : "0x10"));
    const partial = node("partial", () => "0x1", { supports: (method) => method !== "eth_getBalance" });
    const client = pool([wrong.config, partial.config], { verifyIdentity: true, routing: "best" });
    const first = await client.request(read).catch((error: unknown) => error);
    expect(first).toBeInstanceOf(ChainMismatchError);
    // Now that `wrong` is quarantined nothing is picked at all, and the same reason is given.
    const second = await client.request(read).catch((error: unknown) => error);
    expect(second).toBeInstanceOf(ChainMismatchError);
    expect(second).toMatchObject({ endpoint: "wrong", reported: 2, expected: 1 });
    expect(wrong.calls).toEqual(["eth_chainId"]);
    expect(partial.calls).toEqual([]);
    client.close();
  });

  test("probes re-check a verified endpoint once the probe interval has passed", async () => {
    let clock = 0;
    const a = node("a", (method) => (method === "eth_chainId" ? "0x1" : "0x10"));
    const client = pool([a.config], { verifyIdentity: true, now: () => clock });
    await client.probe();
    expect(a.calls).toEqual(["eth_chainId", "eth_blockNumber"]);
    clock = 3_999;
    await client.probe();
    expect(a.count("eth_chainId")).toBe(1);
    clock = 4_000;
    await client.probe();
    expect(a.count("eth_chainId")).toBe(2);
    expect(a.count("eth_blockNumber")).toBe(3);
    // A user call never spends a request on a refresh.
    clock = 60_000;
    await client.request(read);
    expect(a.count("eth_chainId")).toBe(2);
    client.close();
  });

  test("an endpoint that reports no identity is not used", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const mute = node("mute", (method) => (method === "eth_chainId" ? "not-a-quantity" : "0x10"));
    const log = recorder();
    const client = pool([mute.config], {
      verifyIdentity: true,
      retryCount: 0,
      now: () => Date.now(),
      random: () => 0,
      onEvent: log.onEvent,
    });
    const pending = client.request(read).catch((error: unknown) => error);
    // The check is tried once more after the first backoff, then the call gives up.
    await vi.advanceTimersByTimeAsync(50);
    const error = await pending;
    expect(error).toBeInstanceOf(AllEndpointsFailedError);
    expect((error as AllEndpointsFailedError).errors.map((item) => item.message)).toEqual([
      "mute returned no chain identity.",
      "mute returned no chain identity.",
    ]);
    expect(mute.calls).toEqual(["eth_chainId", "eth_chainId"]);
    expect(log.of("quarantine")).toEqual([]);
    expect(log.of("error")).toEqual([]);
    expect(client.snapshot()[0]).toMatchObject({ quarantined: false, ejected: false });
    client.close();
  });

  test("a refresh that reports no identity, or fails, keeps the last match", async () => {
    let clock = 0;
    const a = node("a", (method, nth) => {
      if (method !== "eth_chainId") return "0x10";
      if (nth === 1) return "0x1";
      if (nth === 2) return null;
      throw new Error("identity unreachable");
    });
    const log = recorder();
    const client = pool([a.config], { verifyIdentity: true, now: () => clock, onEvent: log.onEvent });
    await client.probe();

    clock = 4_000;
    await client.probe();
    expect(a.count("eth_chainId")).toBe(2);
    expect(a.count("eth_blockNumber")).toBe(2);

    clock = 8_000;
    await client.probe();
    expect(a.count("eth_chainId")).toBe(3);
    expect(log.of("error")).toMatchObject([{ method: "eth_chainId", endpoint: "a", terminal: false }]);
    // The head probe still went out, and calls still route to the endpoint.
    expect(a.count("eth_blockNumber")).toBe(3);
    expect(log.of("quarantine")).toEqual([]);
    await expect(client.request(read)).resolves.toBe("0x10");
    client.close();
  });

  test("an identity error that describes the call does not count against the endpoint", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const a = node("a", (method) => {
      if (method === "eth_chainId") throw Object.assign(new Error("invalid params"), { code: -32602 });
      return "0x10";
    });
    const log = recorder();
    const client = pool([a.config], {
      verifyIdentity: true,
      retryCount: 0,
      breaker: { threshold: 1 },
      now: () => Date.now(),
      random: () => 0,
      onEvent: log.onEvent,
    });
    const pending = client.request(read).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(50);
    const error = await pending;
    expect(error).toBeInstanceOf(AllEndpointsFailedError);
    expect((error as AllEndpointsFailedError).cause).toMatchObject({ message: "invalid params", code: -32602 });
    expect(log.of("error")).toMatchObject([
      { method: "eth_chainId", terminal: true },
      { method: "eth_chainId", terminal: true },
    ]);
    expect(log.of("eject")).toEqual([]);
    expect(client.snapshot()[0]?.ejected).toBe(false);
    expect(a.calls).toEqual(["eth_chainId", "eth_chainId"]);
    client.close();
  });

  test("an identity check that would exceed the operation budget is not sent", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const a = node("a", (method) => {
      if (method === "eth_chainId") throw new Error("a identity down");
      return "0x10";
    });
    const b = node("b", (method) => (method === "eth_chainId" ? "0x1" : "0x10"));
    const client = pool([a.config, b.config], {
      verifyIdentity: true,
      routing: "best",
      operationBudget: { maxRequests: 1 },
      now: () => Date.now(),
      random: () => 0,
    });
    const pending = client.request(read).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(2_000);
    const error = await pending;
    expect(error).toBeInstanceOf(AllEndpointsFailedError);
    const errors = (error as AllEndpointsFailedError).errors;
    expect(errors[0]?.message).toBe("a identity down");
    expect(errors.slice(1).every((item) => item instanceof OperationBudgetExceededError)).toBe(true);
    expect(errors.length).toBeGreaterThan(1);
    expect(a.calls).toEqual(["eth_chainId"]);
    expect(b.calls).toEqual([]);
    client.close();
  });
});

describe("circuit breaker", () => {
  test("a probe that answers after the endpoint was ejected does not close the circuit", async () => {
    const probe = deferred<string>();
    const a = node("a", (method) => {
      if (method === "eth_blockNumber") return probe.promise;
      throw new Error("read down");
    });
    const log = recorder();
    const client = pool([a.config], { retryCount: 0, breaker: { threshold: 1 }, now: () => 0, onEvent: log.onEvent });
    const probing = client.probe();
    await expect(client.request(read)).rejects.toThrow("read down");
    expect(log.of("eject")).toHaveLength(1);
    probe.resolve("0x10");
    await probing;
    expect(log.of("success")).toMatchObject([{ method: "eth_blockNumber" }]);
    expect(log.of("restore")).toEqual([]);
    expect(client.snapshot()[0]).toMatchObject({ ejected: true, head: 16 });
    client.close();
  });

  test("an ejected endpoint is the last resort, and its answer restores it", async () => {
    const a = node("a", (_method, nth) => {
      if (nth === 1) throw new Error("down");
      return "0x10";
    });
    const log = recorder();
    const client = pool([a.config], { retryCount: 0, breaker: { threshold: 1 }, now: () => 0, onEvent: log.onEvent });
    await expect(client.request(read)).rejects.toThrow("down");
    expect(client.snapshot()[0]?.ejected).toBe(true);
    await expect(client.request(read)).resolves.toBe("0x10");
    expect(log.of("restore")).toEqual([{ type: "restore", endpoint: "a" }]);
    expect(client.snapshot()[0]?.ejected).toBe(false);
    client.close();
  });
});

describe("background probes and request budgets", () => {
  async function afterOneProbeTick(burst: number): Promise<Node> {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const a = node("a", (method) => (method === "eth_chainId" ? "0x1" : "0x10"), { budget: { rps: 0.001, burst } });
    const client = pool([a.config], { verifyIdentity: true, headLag: true, now: () => Date.now() });
    await client.request(read);
    expect(a.calls).toEqual(["eth_chainId", "eth_getBalance"]);
    await vi.advanceTimersByTimeAsync(4_000);
    await vi.advanceTimersByTimeAsync(4_000);
    client.close();
    return a;
  }

  test("the timer probes with the default interval and leaves one token for a caller", async () => {
    // Two tokens are left after the request: one head probe fits, an identity refresh does not.
    const a = await afterOneProbeTick(4);
    expect(a.calls).toEqual(["eth_chainId", "eth_getBalance", "eth_blockNumber"]);
  });

  test("the timer refreshes identity only when a head probe and a caller token remain after it", async () => {
    const a = await afterOneProbeTick(5);
    expect(a.calls).toEqual(["eth_chainId", "eth_getBalance", "eth_chainId", "eth_blockNumber"]);
  });
});
