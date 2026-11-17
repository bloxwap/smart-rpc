import { afterEach, describe, expect, test, vi } from "vitest";

import { AllEndpointsFailedError, BudgetExhaustedError } from "../src/errors.js";
import type { RpcEvent } from "../src/events.js";
import type { PoolEndpointConfig } from "../src/types.js";
import { evmPolicy, pool } from "./helpers.js";

afterEach(() => {
  vi.useRealTimers();
});

const read = { method: "eth_getBalance", params: ["0x1", "latest"] };

interface Call {
  method: string;
  at: number;
  signal: AbortSignal | undefined;
  abortedAtCall: boolean;
}

interface Node {
  config: PoolEndpointConfig;
  calls: Call[];
  methods: () => string[];
}

/** An endpoint whose answers come from `answer`. A thrown value fails the call. */
function node(
  id: string,
  answer: (method: string, nth: number) => unknown,
  extra: Partial<PoolEndpointConfig> = {},
): Node {
  const calls: Call[] = [];
  return {
    calls,
    methods: () => calls.map((call) => call.method),
    config: {
      id,
      url: id,
      call: async ({ method }, options) => {
        calls.push({ method, at: Date.now(), signal: options?.signal, abortedAtCall: options?.signal?.aborted === true });
        return answer(method, calls.filter((call) => call.method === method).length);
      },
      ...extra,
    },
  };
}

const down = (id: string): Node =>
  node(id, () => {
    throw new Error(`${id} down`);
  });

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

async function hops(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) await null;
}

function fakeClock(): void {
  vi.useFakeTimers();
  vi.setSystemTime(0);
}

describe("failover", () => {
  test("waits retryDelay before trying the next endpoint", async () => {
    fakeClock();
    const a = down("a");
    const b = node("b", () => "0xb");
    const log = recorder();
    const client = pool([a.config, b.config], {
      routing: "best",
      retryDelay: 50,
      now: () => Date.now(),
      onEvent: log.onEvent,
    });
    const pending = client.request(read);
    await vi.advanceTimersByTimeAsync(49);
    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBe("0xb");
    expect(b.calls.map((call) => call.at)).toEqual([50]);
    expect(log.of("failover")).toEqual([{ type: "failover", from: "a", to: "b", method: "eth_getBalance" }]);
    client.close();
  });

  test("a block the endpoint does not hold yet fails over without marking the endpoint sick", async () => {
    const a = node("a", () => {
      throw new Error("header not found");
    });
    const b = node("b", () => "0x5");
    const log = recorder();
    const client = pool([a.config, b.config], {
      routing: "best",
      breaker: { threshold: 1 },
      now: () => 0,
      onEvent: log.onEvent,
    });
    await expect(client.request({ method: "eth_getBalance", params: ["0x1", "0x99"] })).resolves.toBe("0x5");
    expect(log.of("error")).toMatchObject([{ endpoint: "a", method: "eth_getBalance", terminal: false }]);
    expect(log.of("eject")).toEqual([]);
    const snapshot = client.snapshot("eth_getBalance")[0];
    expect(snapshot).toMatchObject({ id: "a", ejected: false });
    expect(snapshot?.methods["*"]).toMatchObject({ n: 0, error: 0 });
    client.close();
  });

  test("waits out a short ejection when the only endpoint was just ejected", async () => {
    fakeClock();
    const only = node("only", (_method, nth) => {
      if (nth === 1) throw new Error("down");
      return "0x7";
    });
    const log = recorder();
    const client = pool([only.config], {
      retryCount: 1,
      breaker: { threshold: 1, cooldown: 500 },
      now: () => Date.now(),
      random: () => 0,
      onEvent: log.onEvent,
    });
    const pending = client.request(read);
    await vi.advanceTimersByTimeAsync(499);
    expect(only.calls.map((call) => call.at)).toEqual([0]);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBe("0x7");
    expect(only.calls.map((call) => call.at)).toEqual([0, 500]);
    expect(log.of("eject")).toMatchObject([{ cooldownMs: 500 }]);
    expect(log.of("restore")).toHaveLength(1);
    client.close();
  });

  test("a rebroadcast answered already-known is an error when the policy cannot name the hash", async () => {
    const a = down("a");
    const b = node("b", () => {
      throw new Error("already known");
    });
    const request = { method: "eth_sendRawTransaction", params: ["0xsigned"] };
    const client = pool([a.config, b.config], { routing: "best" });
    await expect(client.request(request)).rejects.toThrow("already known");
    expect(a.methods()).toEqual(["eth_sendRawTransaction"]);
    expect(b.methods()).toEqual(["eth_sendRawTransaction"]);
    client.close();

    const policy = evmPolicy();
    policy.rebroadcastResult = (_method, params) => `hash-of-${String((params as string[])[0])}`;
    const named = pool([down("c").config, b.config], { routing: "best" }, policy);
    await expect(named.request(request)).resolves.toBe("hash-of-0xsigned");
    named.close();
  });
});

describe("request budgets in the retry loop", () => {
  test("stops with the budget error once a new round finds only a spent endpoint, and keeps barred endpoints out", async () => {
    fakeClock();
    const x = node("x", () => {
      throw new Error("x identity down");
    });
    const y = node("y", (method) => (method === "eth_chainId" ? "0x1" : "0xy"), { budget: { rps: 0.0001, burst: 2 } });
    const z = node("z", () => "0xz", { supportsRequest: () => false });
    const client = pool([x.config, y.config, z.config], {
      verifyIdentity: true,
      routing: "best",
      breaker: false,
      retryCount: 0,
      now: () => Date.now(),
      random: () => 0,
    });
    // `y` spends its two tokens on its identity check and this call.
    await expect(client.request(read)).resolves.toBe("0xy");
    expect(y.methods()).toEqual(["eth_chainId", "eth_getBalance"]);
    expect(x.methods()).toEqual(["eth_chainId"]);

    const pending = client.request(read).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(49);
    expect(x.methods()).toEqual(["eth_chainId", "eth_chainId"]);
    await vi.advanceTimersByTimeAsync(1);
    const error = await pending;
    expect(error).toBeInstanceOf(AllEndpointsFailedError);
    const errors = (error as AllEndpointsFailedError).errors;
    expect(errors.map((item) => item.message)).toEqual([
      "x identity down",
      "x identity down",
      "RPC request budget exhausted. Next token in 9999950ms.",
    ]);
    expect(errors[2]).toBeInstanceOf(BudgetExhaustedError);
    expect(errors[2]).toMatchObject({ endpoints: ["y"], refillMs: 9_999_950 });
    // One more identity attempt after the 50ms backoff, nothing past `y`'s budget, and `z` never asked.
    expect(x.methods()).toEqual(["eth_chainId", "eth_chainId", "eth_chainId"]);
    expect(y.methods()).toEqual(["eth_chainId", "eth_getBalance"]);
    expect(z.calls).toEqual([]);
    client.close();
  });
  test("a token taken by a request made from a failover listener is not spent twice", async () => {
    fakeClock();
    const a = node("a", () => {
      throw new Error("a down");
    }, { supports: (method) => method !== "eth_getCode" });
    const b = node("b", (method) => `0xb:${method}`, { budget: { rps: 0.0001, burst: 1 } });
    let nested: Promise<unknown> | undefined;
    const client = pool([a.config, b.config], {
      routing: "best",
      breaker: false,
      retryCount: 1,
      now: () => Date.now(),
      random: () => 0,
      onEvent: (event) => {
        if (event.type !== "failover" || nested) return;
        nested = client.request({ method: "eth_getCode", params: ["0x1", "latest"] });
      },
    });
    const pending = client.request(read).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    await expect(nested).resolves.toBe("0xb:eth_getCode");
    const error = await pending;
    expect(error).toBeInstanceOf(AllEndpointsFailedError);
    const errors = (error as AllEndpointsFailedError).errors;
    expect(errors.map((item) => item.name)).toEqual(["Error", "BudgetExhaustedError"]);
    expect(errors[1]).toMatchObject({ endpoints: ["b"] });
    // `b` held one token. The listener's request got it, and the outer call sent nothing past the budget.
    expect(b.methods()).toEqual(["eth_getCode"]);
    client.close();
  });
});

describe("race", () => {
  test("a racer that fails waits for the other, and the answer still wins", async () => {
    const b = deferred<string>();
    const nodes = [down("a"), node("b", () => b.promise), node("c", () => "0xc")];
    const log = recorder();
    const client = pool(nodes.map((item) => item.config), { race: true, routing: "best", now: () => 0, onEvent: log.onEvent });
    const pending = client.request(read);
    await hops(20);
    expect(log.of("error")).toMatchObject([{ endpoint: "a" }]);
    b.resolve("0xb");
    await expect(pending).resolves.toBe("0xb");
    expect(log.of("race")).toEqual([{ type: "race", endpoints: ["a", "b"], method: "eth_getBalance" }]);
    expect(log.of("failover")).toEqual([]);
    expect(nodes[2]?.calls).toEqual([]);
    client.close();
  });

  test("when every racer fails the call fails over, and every error is reported", async () => {
    const nodes = [down("a"), down("b"), down("c")];
    const client = pool(nodes.map((item) => item.config), { race: true, routing: "best", retryCount: 1, now: () => 0 });
    const error = await client.request(read).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AllEndpointsFailedError);
    expect((error as AllEndpointsFailedError).errors.map((item) => item.message)).toEqual(["a down", "b down", "c down"]);
    expect(nodes.map((item) => item.calls.length)).toEqual([1, 1, 1]);
    client.close();
  });

  test("an error every endpoint would repeat ends the race at once", async () => {
    const a = node("a", () => {
      throw Object.assign(new Error("execution reverted"), { code: 3 });
    });
    const b = node("b", () => new Promise(() => undefined));
    const client = pool([a.config, b.config], { race: true, routing: "best", now: () => 0 });
    await expect(client.request(read)).rejects.toThrow("execution reverted");
    expect(b.calls).toHaveLength(1);
    expect(b.calls[0]?.signal?.aborted).toBe(true);
    client.close();
  });

  test("shouldThrow ends the race on an error that would otherwise wait for the other racer", async () => {
    const a = node("a", () => {
      throw new Error("fatal: wallet locked");
    });
    const b = node("b", () => new Promise(() => undefined));
    const client = pool([a.config, b.config], {
      race: true,
      routing: "best",
      now: () => 0,
      shouldThrow: (error) => error.message.startsWith("fatal"),
    });
    await expect(client.request(read)).rejects.toThrow("fatal: wallet locked");
    expect(b.calls[0]?.signal?.aborted).toBe(true);
    client.close();
  });

  test("does not verify a cold rival when that would spend the operation's last request", async () => {
    const identity = (method: string): string => (method === "eth_chainId" ? "0x1" : "0xa");
    const build = (maxRequests: number): { a: Node; b: Node; client: ReturnType<typeof pool> } => {
      const a = node("a", identity);
      const b = node("b", identity);
      const client = pool([a.config, b.config], {
        verifyIdentity: true,
        race: true,
        routing: "best",
        operationBudget: { maxRequests },
        now: () => 0,
      });
      return { a, b, client };
    };
    const tight = build(3);
    await expect(tight.client.request(read)).resolves.toBe("0xa");
    await hops(20);
    expect(tight.a.methods()).toEqual(["eth_chainId", "eth_getBalance"]);
    expect(tight.b.calls).toEqual([]);
    tight.client.close();

    const roomy = build(4);
    await expect(roomy.client.request(read)).resolves.toBe("0xa");
    await hops(20);
    expect(roomy.b.methods()).toEqual(["eth_chainId"]);
    roomy.client.close();
  });

  test("starts only as many racers as the operation budget allows", async () => {
    const nodes = ["a", "b", "c"].map((id) => node(id, () => `0x${id}`));
    const log = recorder();
    const client = pool(nodes.map((item) => item.config), {
      race: { width: 3 },
      routing: "best",
      operationBudget: { maxRequests: 2 },
      now: () => 0,
      onEvent: log.onEvent,
    });
    await expect(client.request(read)).resolves.toBe("0xa");
    expect(log.of("race")).toEqual([{ type: "race", endpoints: ["a", "b"], method: "eth_getBalance" }]);
    expect(nodes.map((item) => item.calls.length)).toEqual([1, 1, 0]);
    client.close();
  });
});

describe("hedge", () => {
  test("with the defaults a lone endpoint is never hedged", async () => {
    fakeClock();
    const answer = deferred<string>();
    const only = node("only", () => answer.promise);
    const log = recorder();
    const client = pool([only.config], { hedge: true, now: () => Date.now(), onEvent: log.onEvent });
    const pending = client.request(read);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(only.calls).toHaveLength(1);
    expect(log.of("hedge")).toEqual([]);
    answer.resolve("0x1");
    await expect(pending).resolves.toBe("0x1");
    client.close();
  });

  test("sends a verified backup after the default 250ms and cancels the slow primary", async () => {
    fakeClock();
    const primary = node("primary", () => new Promise(() => undefined));
    const backup = node("backup", () => "0xbackup");
    const log = recorder();
    const client = pool([primary.config, backup.config], {
      hedge: { multiplier: 0 },
      routing: "best",
      now: () => Date.now(),
      onEvent: log.onEvent,
    });
    const pending = client.request(read);
    await vi.advanceTimersByTimeAsync(249);
    expect(backup.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBe("0xbackup");
    expect(backup.calls.map((call) => call.at)).toEqual([250]);
    expect(log.of("hedge")).toEqual([{ type: "hedge", endpoint: "backup", method: "eth_getBalance" }]);
    expect(log.of("success")).toMatchObject([{ endpoint: "backup", hedged: true }]);
    expect(primary.calls[0]?.signal?.aborted).toBe(true);
    client.close();
  });

  test("a failed backup leaves the primary running, and the primary's error is the one reported", async () => {
    fakeClock();
    const first = deferred<string>();
    const second = deferred<string>();
    const primary = node("primary", (_method, nth) => (nth === 1 ? first.promise : second.promise));
    const backup = down("backup");
    const client = pool([primary.config, backup.config], {
      hedge: { minDelay: 10, multiplier: 0 },
      routing: "best",
      retryCount: 0,
      breaker: false,
      now: () => Date.now(),
    });
    const answered = client.request(read);
    await vi.advanceTimersByTimeAsync(10);
    expect(backup.calls).toHaveLength(1);
    expect(primary.calls[0]?.signal?.aborted).toBe(false);
    first.resolve("0xprimary");
    await expect(answered).resolves.toBe("0xprimary");

    const failed = client.request(read).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10);
    expect(backup.calls).toHaveLength(2);
    second.reject(new Error("primary down"));
    await expect(failed).resolves.toMatchObject({ message: "primary down" });
    client.close();
  });

  test("a backup whose identity check finishes after the primary answered is not sent the call", async () => {
    fakeClock();
    const slow = deferred<string>();
    const identity = deferred<string>();
    const primary = node("primary", (method, nth) => {
      if (method === "eth_chainId") return "0x1";
      return nth === 1 ? "0xfirst" : slow.promise;
    });
    const backup = node("backup", (method) => (method === "eth_chainId" ? identity.promise : "0xbackup"));
    const client = pool([primary.config, backup.config], {
      verifyIdentity: true,
      hedge: { minDelay: 10, multiplier: 0 },
      routing: "best",
      now: () => Date.now(),
    });
    await expect(client.request(read)).resolves.toBe("0xfirst");
    const pending = client.request(read);
    await vi.advanceTimersByTimeAsync(10);
    expect(backup.methods()).toEqual(["eth_chainId"]);
    slow.resolve("0xsecond");
    await expect(pending).resolves.toBe("0xsecond");
    identity.resolve("0x1");
    await vi.advanceTimersByTimeAsync(0);
    expect(backup.methods()).toEqual(["eth_chainId"]);
    client.close();
  });

  test("a caller that aborts when told of the hedge gets its abort, and the backup is never called", async () => {
    fakeClock();
    const controller = new AbortController();
    const primary = node("primary", () => new Promise(() => undefined));
    const backup = node("backup", () => "0xbackup");
    const client = pool([primary.config, backup.config], {
      hedge: { minDelay: 10, multiplier: 0 },
      routing: "best",
      now: () => Date.now(),
      onEvent: (event) => {
        if (event.type === "hedge") controller.abort();
      },
    });
    const pending = client.request({ ...read, signal: controller.signal }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10);
    await expect(pending).resolves.toMatchObject({ name: "AbortError" });
    expect(backup.calls).toEqual([]);
    expect(primary.calls[0]?.signal?.aborted).toBe(true);
    client.close();
  });

  test("a backup that answers around the moment it is cancelled never changes the answer, and is scored only if it beat the cancel", async () => {
    fakeClock();
    const backupScored: number[] = [];
    for (const late of [0, 1, 2, 3, 4, 5, 6, 7, 8, 12, 16]) {
      const gate = deferred<void>();
      const primary = node("primary", async () => {
        await gate.promise;
        return "0xprimary";
      });
      const backup = node("backup", async () => {
        await gate.promise;
        await hops(late);
        return "0xbackup";
      });
      const log = recorder();
      const client = pool([primary.config, backup.config], {
        hedge: { minDelay: 10, multiplier: 0 },
        routing: "best",
        now: () => Date.now(),
        onEvent: log.onEvent,
      });
      const pending = client.request(read);
      await vi.advanceTimersByTimeAsync(10);
      expect(backup.calls).toHaveLength(1);
      gate.resolve();
      await expect(pending).resolves.toBe("0xprimary");
      await vi.advanceTimersByTimeAsync(0);
      const scored = log.of("success").map((event) => (event.type === "success" ? event.endpoint : ""));
      expect(scored.filter((endpoint) => endpoint === "primary")).toHaveLength(1);
      backupScored.push(scored.filter((endpoint) => endpoint === "backup").length);
      expect(log.of("error")).toEqual([]);
      client.close();
    }
    // The later the backup answers, the less it can count: once cancelled first, it never counts again.
    expect(backupScored.every((count) => count === 0 || count === 1)).toBe(true);
    expect([...backupScored].sort((left, right) => right - left)).toEqual(backupScored);
    expect(backupScored.at(-1)).toBe(0);
  });

  test("a hedge delay too long for a timer does not fire early", async () => {
    fakeClock();
    const hang = deferred<string>();
    const primary = node("primary", (_method, nth) =>
      nth <= 3 ? new Promise((resolve) => setTimeout(() => resolve("0xquick"), 5)) : hang.promise);
    const backup = node("backup", () => "0xbackup", { weight: 0.001 });
    const client = pool([primary.config, backup.config], {
      hedge: { minDelay: 10, multiplier: 1e12 },
      routing: "best",
      timeout: 7_200_000,
      now: () => Date.now(),
    });
    for (let index = 0; index < 3; index += 1) {
      const quick = client.request(read);
      await vi.advanceTimersByTimeAsync(5);
      await expect(quick).resolves.toBe("0xquick");
    }
    // Three samples of 5ms times 1e12 is far past the largest delay a timer accepts.
    const pending = client.request(read);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(primary.calls).toHaveLength(4);
    expect(backup.calls).toEqual([]);
    hang.resolve("0xslow");
    await expect(pending).resolves.toBe("0xslow");
    client.close();
  });
});

describe("cancellation at awkward moments", () => {
  test("a batch item aborted while it fails over rejects with the abort and leaves its siblings alone", async () => {
    const controller = new AbortController();
    const a = down("a");
    const b = node("b", () => "0xb");
    const log = recorder();
    const client = pool([a.config, b.config], {
      routing: "best",
      now: () => 0,
      onEvent: (event) => {
        log.onEvent(event);
        if (event.type === "failover" && event.method === "eth_getBalance") controller.abort();
      },
    });
    const results = await client.requestBatch([
      { ...read, signal: controller.signal },
      { method: "eth_getCode", params: ["0x1", "latest"] },
    ]);
    expect(results[0]).toMatchObject({ status: "rejected", reason: { name: "AbortError" } });
    expect(results[1]).toEqual({ status: "fulfilled", value: "0xb" });
    // The upstream request for the aborted item was handed an already-aborted signal and is not scored.
    expect(b.calls.find((call) => call.method === "eth_getBalance")?.abortedAtCall).toBe(true);
    expect(b.calls.find((call) => call.method === "eth_getCode")?.abortedAtCall).toBe(false);
    expect(log.of("success")).toMatchObject([{ endpoint: "b", method: "eth_getCode" }]);
    expect(log.of("error").filter((event) => event.type === "error" && event.endpoint === "b")).toEqual([]);
    client.close();
  });

  test.each(["verified-then-delayed", "second-identity-check"] as const)(
    "an abort at any microtask around an identity check rejects with the abort and sends no call (%s)",
    async (scenario) => {
      for (let late = 0; late <= 16; late += 1) {
        const controller = new AbortController();
        const trigger = (): void => {
          void hops(late).then(() => controller.abort());
        };
        const nodes = scenario === "verified-then-delayed"
          ? [
              // `a` fails the call. `b` is verified next, then the retry delay starts.
              node("a", (method) => {
                if (method === "eth_chainId") return "0x1";
                throw new Error("a down");
              }),
              node("b", (method) => {
                if (method !== "eth_chainId") return "0xb";
                trigger();
                return "0x1";
              }),
            ]
          : [
              // `a` fails its identity check, so `b` is checked next.
              node("a", () => {
                trigger();
                throw new Error("a identity down");
              }),
              node("b", (method) => (method === "eth_chainId" ? "0x1" : "0xb")),
            ];
        const client = pool(nodes.map((item) => item.config), {
          verifyIdentity: true,
          routing: "best",
          retryDelay: 60_000,
          now: () => 0,
        });
        const outcome = await client.request({ ...read, signal: controller.signal }).catch((error: unknown) => error);
        expect(outcome).toMatchObject({ name: "AbortError" });
        expect(nodes[1]?.methods().filter((method) => method !== "eth_chainId")).toEqual([]);
        client.close();
      }
    },
  );
});
