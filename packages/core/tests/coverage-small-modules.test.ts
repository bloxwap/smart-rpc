import { afterEach, describe, expect, test, vi } from "vitest";

import { Activity, defaultIsActive } from "../src/activity.js";
import { MAX_TIMER_MS } from "../src/constants.js";
import { abortError, toError } from "../src/error-util.js";
import { AllEndpointsFailedError, OperationBudgetExceededError, UnknownChainError } from "../src/errors.js";
import { shouldFailover } from "../src/evm-methods.js";
import { Operation } from "../src/operation.js";
import { blockNumberFromResult, toHexQuantity } from "../src/quantity.js";
import { createSmartRpc } from "../src/router.js";
import {
  defaultScoreConfig,
  emptyStat,
  endpointScore,
  inflation,
  observe,
  observeLiveness,
  type MethodStat,
} from "../src/score.js";
import type { RpcRequest, SmartRpcTransport } from "../src/types.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("activity", () => {
  test("a document without a string visibilityState is not treated as a browser page", () => {
    const addEventListener = vi.fn();
    vi.stubGlobal("document", { visibilityState: 0, addEventListener, removeEventListener: vi.fn() });
    expect(defaultIsActive()).toBe(true);
    const activity = new Activity(undefined);
    activity.watch(() => undefined);
    expect(addEventListener).not.toHaveBeenCalled();
  });

  test("a hidden document that cannot be listened to is ignored, so probes stay on", () => {
    vi.stubGlobal("document", { visibilityState: "hidden" });
    expect(defaultIsActive()).toBe(true);
    vi.stubGlobal("document", { visibilityState: "hidden", addEventListener: vi.fn() });
    expect(defaultIsActive()).toBe(true);
    vi.stubGlobal("document", { visibilityState: "hidden", addEventListener: vi.fn(), removeEventListener: vi.fn() });
    expect(defaultIsActive()).toBe(false);
  });

  test("an isActive hook that throws counts as active", () => {
    const activity = new Activity(() => {
      throw new Error("hook broke");
    });
    expect(activity.active()).toBe(true);
    expect(new Activity(() => false).active()).toBe(false);
  });

  test("a second watch does not register a second listener, and unwatch removes the first", () => {
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    vi.stubGlobal("document", { visibilityState: "visible", addEventListener, removeEventListener });
    const activity = new Activity(undefined);
    const first = (): void => undefined;
    activity.watch(first);
    activity.watch(() => undefined);
    expect(addEventListener).toHaveBeenCalledTimes(1);
    expect(addEventListener).toHaveBeenCalledWith("visibilitychange", first);
    activity.unwatch();
    activity.unwatch();
    expect(removeEventListener).toHaveBeenCalledTimes(1);
    expect(removeEventListener).toHaveBeenCalledWith("visibilitychange", first);
  });
});

describe("error-util and errors", () => {
  test("toError wraps a thrown string and replaces anything else", () => {
    const original = new Error("kept");
    expect(toError(original)).toBe(original);
    expect(toError("node said no").message).toBe("node said no");
    expect(toError({ code: 7 }).message).toBe("Unknown endpoint error");
  });

  test("abortError returns an Error reason as is and builds an AbortError for any other reason", () => {
    const withError = new AbortController();
    const reason = new Error("caller gave up");
    withError.abort(reason);
    expect(abortError(withError.signal)).toBe(reason);

    const withString = new AbortController();
    withString.abort("stop");
    const built = abortError(withString.signal);
    expect(built.name).toBe("AbortError");
    expect(built.message).toBe("This operation was aborted");
  });

  test("AllEndpointsFailedError has no cause when no endpoint was attempted", () => {
    const empty = new AllEndpointsFailedError([]);
    expect(empty.cause).toBeUndefined();
    expect(empty.errors).toEqual([]);
    const last = new Error("last");
    expect(new AllEndpointsFailedError([new Error("first"), last]).cause).toBe(last);
  });
});

describe("evm shouldFailover", () => {
  function rpcError(message: string, code?: number): Error {
    return Object.assign(new Error(message), code === undefined ? {} : { code });
  }

  test("an abort never fails over", () => {
    const abort = new Error("header not found");
    abort.name = "AbortError";
    expect(shouldFailover(abort)).toBe(false);
  });

  test("a block the node does not hold fails over even with a terminal code", () => {
    expect(shouldFailover(rpcError("header not found", -32602))).toBe(true);
  });

  test("invalid params fails over only when the message is a provider limit", () => {
    expect(shouldFailover(rpcError("query exceeds max block range 10000", -32602))).toBe(true);
    expect(shouldFailover(rpcError("missing value for required argument 0", -32602))).toBe(false);
  });
});

describe("quantity", () => {
  test("blockNumberFromResult reads an eth_blockNumber result", () => {
    expect(blockNumberFromResult("eth_blockNumber", "0x10")).toBe(16);
    expect(blockNumberFromResult("eth_blockNumber", "sixteen")).toBeNull();
  });

  test("toHexQuantity rejects what is not a block number", () => {
    expect(toHexQuantity(255)).toBe("0xff");
    expect(() => toHexQuantity(-1)).toThrow("Block number must be a non-negative safe integer, got -1.");
    expect(() => toHexQuantity(1.5)).toThrow("got 1.5.");
  });
});

describe("operation", () => {
  test("rejects a request ceiling that is not a positive safe integer", () => {
    expect(() => new Operation({ maxRequests: 0 }, 1_000)).toThrow(
      "operationBudget.maxRequests must be a positive safe integer.",
    );
    expect(() => new Operation({ maxRequests: 1.5 }, 1_000)).toThrow("positive safe integer");
  });

  test("rejects a timeout a timer cannot hold", () => {
    expect(() => new Operation({ timeout: 0 }, 1_000)).toThrow(
      `operationBudget.timeout must be from 1 to ${MAX_TIMER_MS} milliseconds, got 0.`,
    );
    expect(() => new Operation(undefined, MAX_TIMER_MS)).toThrow(`got ${String(MAX_TIMER_MS * 4)}.`);
  });

  test("a parent that is already aborted aborts the operation at once, and check throws its reason", () => {
    const parent = new AbortController();
    const reason = new Error("caller left");
    parent.abort(reason);
    const operation = new Operation(undefined, 1_000, parent.signal);
    try {
      expect(operation.signal.aborted).toBe(true);
      expect(() => operation.check()).toThrow(reason);
      expect(() => operation.take()).toThrow(reason);
      expect(operation.remaining).toBe(64);
    } finally {
      operation.close();
    }
  });

  test("a parent aborting later aborts the operation, and the budget is counted until then", () => {
    const parent = new AbortController();
    const operation = new Operation({ maxRequests: 1 }, 1_000, parent.signal);
    try {
      operation.take();
      expect(() => operation.take()).toThrow(OperationBudgetExceededError);
      parent.abort("stop");
      let thrown: unknown;
      try {
        operation.check();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).name).toBe("AbortError");
    } finally {
      operation.close();
    }
  });
});

describe("createSmartRpc", () => {
  type Routed = RpcRequest & { chainId: string };

  function call(chainId: string, method: string): Routed {
    return { chainId, method };
  }

  test("refuses a chain id registered by two transports", () => {
    const one: SmartRpcTransport = { chainIds: ["eip155:1"], request: async () => 1 };
    const two: SmartRpcTransport = { chainIds: ["eip155:10", "eip155:1"], request: async () => 2 };
    expect(() => createSmartRpc({ transports: [one, two] })).toThrow(
      "createSmartRpc() chain id eip155:1 is registered more than once.",
    );
  });

  test("a transport without requestBatch gets one request per item, and a synchronous throw rejects only that item", async () => {
    const seen: string[] = [];
    const transport: SmartRpcTransport = {
      chainIds: ["eip155:1"],
      request: (request) => {
        seen.push(request.method);
        if (request.method === "boom") throw new Error("sync throw");
        return Promise.resolve(`${request.method}:ok`);
      },
    };
    const rpc = createSmartRpc({ transports: [transport] });
    const results = await rpc.requestBatch([call("eip155:1", "a"), call("eip155:5", "x"), call("eip155:1", "boom"), call("eip155:1", "b")]);
    expect(seen).toEqual(["a", "boom", "b"]);
    expect(results[0]).toEqual({ status: "fulfilled", value: "a:ok" });
    expect(results[1]?.status).toBe("rejected");
    expect((results[1] as PromiseRejectedResult).reason).toBeInstanceOf(UnknownChainError);
    expect(results[2]?.status).toBe("rejected");
    expect(((results[2] as PromiseRejectedResult).reason as Error).message).toBe("sync throw");
    expect(results[3]).toEqual({ status: "fulfilled", value: "b:ok" });
  });

  test("an item the transport's batch left out is rejected, and the others keep their order", async () => {
    const batches: (readonly RpcRequest[])[] = [];
    const short: SmartRpcTransport = {
      chainIds: ["eip155:1"],
      request: async () => "unused",
      requestBatch: async (requests) => {
        batches.push(requests);
        return [{ status: "fulfilled", value: "only" }];
      },
    };
    const rpc = createSmartRpc({ transports: [short] });
    const results = await rpc.requestBatch([call("eip155:1", "a"), call("eip155:1", "b")]);
    expect(batches).toHaveLength(1);
    expect(batches[0]?.map((request) => request.method)).toEqual(["a", "b"]);
    expect(results[0]).toEqual({ status: "fulfilled", value: "only" });
    expect(results[1]?.status).toBe("rejected");
    expect(((results[1] as PromiseRejectedResult).reason as Error).message).toBe("Transport omitted a batch result.");
  });

  test("a transport whose batch throws rejects its own items and leaves another transport's alone", async () => {
    const failure = new Error("batch down");
    const broken: SmartRpcTransport = {
      chainIds: ["eip155:1"],
      request: async () => "unused",
      requestBatch: async () => {
        throw failure;
      },
    };
    const healthy: SmartRpcTransport = {
      chainIds: ["eip155:10"],
      request: async () => "unused",
      requestBatch: async (requests) => requests.map((request) => ({ status: "fulfilled", value: request.method })),
    };
    const rpc = createSmartRpc({ transports: [broken, healthy] });
    const results = await rpc.requestBatch([call("eip155:1", "a"), call("eip155:10", "b"), call("eip155:1", "c")]);
    expect(results).toEqual([
      { status: "rejected", reason: failure },
      { status: "fulfilled", value: "b" },
      { status: "rejected", reason: failure },
    ]);
  });
});

describe("score edges", () => {
  const stat = (overrides: Partial<MethodStat>): MethodStat => ({ ...emptyStat(), ...overrides });

  test("the error rate never leaves 0..1, whatever the configured step", () => {
    const failing = stat({ ewma: 10, tail: 10, error: 0.9, n: 3 });
    observe(failing, 10, false, { ...defaultScoreConfig, errorAlpha: 3 });
    expect(failing.error).toBe(1);
    const recovering = stat({ ewma: 10, tail: 10, error: 0.9, n: 3 });
    observe(recovering, 10, true, { ...defaultScoreConfig, errorAlpha: 3 });
    expect(recovering.error).toBe(0);
  });

  test("a negative latency is recorded as zero", () => {
    const first = emptyStat();
    observe(first, -5, true);
    expect(first).toEqual({ ewma: 0, tail: 0, error: 0, n: 1 });
  });

  test("a negative probe penalty is recorded as zero", () => {
    const first = emptyStat();
    observeLiveness(first, false, -10);
    expect(first).toEqual({ ewma: 0, tail: 0, error: 1, n: 1 });
  });

  test("a probe failure with a penalty under the tail pulls the tail down slowly", () => {
    const measured = stat({ ewma: 500, tail: 1_000, error: 0, n: 4 });
    observeLiveness(measured, false, 100);
    const alpha = defaultScoreConfig.tailAlphaDown;
    expect(measured.tail).toBeCloseTo(alpha * 100 + (1 - alpha) * 1_000, 9);
    expect(measured.tail).toBeGreaterThan(100);
    expect(measured.tail).toBeLessThan(1_000);
    expect(measured.error).toBeCloseTo(defaultScoreConfig.errorAlpha, 9);
    expect(measured.n).toBe(4);
    expect(measured.ewma).toBe(500);
  });

  test("a negative in-flight count inflates nothing", () => {
    expect(inflation(-3)).toBe(1);
    expect(inflation(2)).toBe(1 + 2 + defaultScoreConfig.queueWeight * 4);
  });

  test("a lag penalty under 1 and a weight of 0 or less fall back to 1", () => {
    const global = stat({ ewma: 100, tail: 100, error: 0, n: 10 });
    const base = { global, method: undefined, perMethod: false, inflight: 0 };
    const neutral = endpointScore({ ...base, lagPenalty: 1, weight: 1 });
    expect(neutral).toBeCloseTo(100, 9);
    expect(endpointScore({ ...base, lagPenalty: 0.2, weight: 1 })).toBe(neutral);
    expect(endpointScore({ ...base, lagPenalty: 1, weight: 0 })).toBe(neutral);
    expect(endpointScore({ ...base, lagPenalty: 1, weight: -4 })).toBe(neutral);
    expect(endpointScore({ ...base, lagPenalty: 3, weight: 2 })).toBeCloseTo(150, 9);
  });
});
