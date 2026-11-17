import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { Coalescer, coalesceKey, DEFAULT_UNCOALESCED_METHODS, isCoalescableMethod } from "../src/coalesce.js";

type Progress = (waitMs?: number) => void;

interface Upstream {
  run: ReturnType<typeof vi.fn<(signal: AbortSignal | undefined, progress: Progress) => Promise<unknown>>>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  /** The cancellation signal the coalescer handed to the shared request. */
  signal: () => AbortSignal;
  progress: Progress;
}

function upstream(): Upstream {
  let resolve: (value: unknown) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  let signal: AbortSignal | undefined;
  let progress: Progress = () => undefined;
  const run = vi.fn((given: AbortSignal | undefined, report: Progress) => {
    signal = given;
    progress = report;
    return promise;
  });
  return {
    run,
    resolve,
    reject,
    signal: () => {
      if (!signal) throw new Error("run has not started");
      return signal;
    },
    progress: (waitMs) => progress(waitMs),
  };
}

const noJoin = (): void => {
  throw new Error("unexpected join");
};

describe("isCoalescableMethod", () => {
  test("only idempotent methods outside the uncoalesced set share a request", () => {
    expect(isCoalescableMethod("eth_call", true)).toBe(true);
    expect(isCoalescableMethod("eth_call", false)).toBe(false);
    for (const method of DEFAULT_UNCOALESCED_METHODS) expect(isCoalescableMethod(method, true)).toBe(false);
  });

  test("a transport's own set replaces the default", () => {
    const extra = new Set(["eth_call"]);
    expect(isCoalescableMethod("eth_call", true, extra)).toBe(false);
    expect(isCoalescableMethod("eth_getFilterChanges", true, extra)).toBe(true);
  });
});

describe("coalesceKey", () => {
  test("serializes primitives, each kind distinctly", () => {
    expect(coalesceKey("m", undefined)).toBe("m:u");
    expect(coalesceKey("m", null)).toBe("m:null");
    expect(coalesceKey("m", true)).toBe("m:true");
    expect(coalesceKey("m", "a\"b")).toBe('m:"a\\"b"');
    expect(coalesceKey("m", 5)).toBe("m:5");
    expect(coalesceKey("m", 5n)).toBe("m:5n");
    expect(coalesceKey("m", "5")).not.toBe(coalesceKey("m", 5));
    expect(coalesceKey("m", [5n])).not.toBe(coalesceKey("m", [5]));
    expect(coalesceKey("m", [undefined])).not.toBe(coalesceKey("m", [null]));
  });

  test("functions and symbols become their type name", () => {
    expect(coalesceKey("m", [() => 1])).toBe("m:[<function>]");
    expect(coalesceKey("m", [Symbol("s")])).toBe("m:[<symbol>]");
  });

  test("object keys are sorted, so key order does not split a request", () => {
    expect(coalesceKey("eth_call", [{ to: "0x1", data: "0x2" }, "latest"])).toBe(
      'eth_call:[{"data":"0x2","to":"0x1"},"latest"]',
    );
    expect(coalesceKey("eth_call", [{ data: "0x2", to: "0x1" }, "latest"])).toBe(
      coalesceKey("eth_call", [{ to: "0x1", data: "0x2" }, "latest"]),
    );
    expect(coalesceKey("m", [])).toBe("m:[]");
    expect(coalesceKey("m", {})).toBe("m:{}");
  });

  test("toJSON is honoured", () => {
    expect(coalesceKey("m", [new Date(0)])).toBe('m:["1970-01-01T00:00:00.000Z"]');
    expect(coalesceKey("m", { toJSON: () => ({ b: 1, a: [2] }) })).toBe('m:{"a":[2],"b":1}');
  });

  test("a value repeated side by side is fine, but a cycle has no key", () => {
    const shared = { a: 1 };
    expect(coalesceKey("m", [shared, shared])).toBe('m:[{"a":1},{"a":1}]');

    const array: unknown[] = [1];
    array.push(array);
    expect(coalesceKey("m", array)).toBeUndefined();

    const object: Record<string, unknown> = { a: 1 };
    object.self = { inner: object };
    expect(coalesceKey("m", [object, "after"])).toBeUndefined();

    const viaToJson: { toJSON: () => unknown } = { toJSON: () => viaToJson };
    expect(coalesceKey("m", viaToJson)).toBeUndefined();
  });
});

describe("Coalescer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  test("concurrent callers share one upstream request and the entry leaves when it settles", async () => {
    const coalescer = new Coalescer(100);
    const first = upstream();
    const second = upstream();
    const joined = vi.fn();
    const a = coalescer.request("k", undefined, first.run, noJoin);
    const b = coalescer.request("k", undefined, second.run, joined);
    expect(coalescer.size).toBe(1);
    expect(joined).toHaveBeenCalledTimes(1);
    first.resolve("shared");
    await expect(Promise.all([a, b])).resolves.toEqual(["shared", "shared"]);
    expect(first.run).toHaveBeenCalledTimes(1);
    expect(second.run).not.toHaveBeenCalled();
    expect(coalescer.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);

    // Nothing is cached: the next call starts a new request.
    const c = coalescer.request("k", undefined, second.run, noJoin);
    second.resolve("again");
    await expect(c).resolves.toBe("again");
  });

  test("different keys do not share", async () => {
    const coalescer = new Coalescer(100);
    const first = upstream();
    const second = upstream();
    const a = coalescer.request("a", undefined, first.run, noJoin);
    const b = coalescer.request("b", undefined, second.run, noJoin);
    expect(coalescer.size).toBe(2);
    first.resolve(1);
    second.resolve(2);
    await expect(Promise.all([a, b])).resolves.toEqual([1, 2]);
  });

  test("a shared failure reaches every waiter, with or without a signal", async () => {
    const coalescer = new Coalescer(100);
    const first = upstream();
    const controller = new AbortController();
    const a = coalescer.request("k", controller.signal, first.run, noJoin);
    const b = coalescer.request("k", undefined, upstream().run, () => undefined);
    const boom = new Error("upstream down");
    first.reject(boom);
    await expect(a).rejects.toBe(boom);
    await expect(b).rejects.toBe(boom);
    expect(coalescer.size).toBe(0);
    expect(first.signal().aborted).toBe(false);
  });

  test("a run that throws synchronously rejects the caller and leaves no entry", async () => {
    const coalescer = new Coalescer(100);
    const boom = new Error("bad params");
    const run = vi.fn((): Promise<unknown> => {
      throw boom;
    });
    await expect(coalescer.request("k", undefined, run, noJoin)).rejects.toBe(boom);
    expect(coalescer.size).toBe(0);
  });

  test("an already aborted caller is rejected without starting or joining anything", async () => {
    const coalescer = new Coalescer(100);
    const first = upstream();
    const reason = new Error("gave up");
    const controller = new AbortController();
    controller.abort(reason);
    await expect(coalescer.request("k", controller.signal, first.run, noJoin)).rejects.toBe(reason);
    expect(first.run).not.toHaveBeenCalled();
    expect(coalescer.size).toBe(0);
  });

  test("the only waiter aborting cancels the shared request", async () => {
    const coalescer = new Coalescer(100);
    const first = upstream();
    const controller = new AbortController();
    const a = coalescer.request("k", controller.signal, first.run, noJoin);
    expect(first.signal().aborted).toBe(false);
    controller.abort("stop");
    const error = await a.then(
      () => undefined,
      (caught: unknown) => caught,
    );
    // A reason that is not an Error is replaced by a standard AbortError.
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("AbortError");
    expect((error as Error).message).toBe("This operation was aborted");
    expect(first.signal().aborted).toBe(true);
    expect(coalescer.size).toBe(0);

    // A late upstream answer is ignored.
    first.resolve("late");
    await expect(a).rejects.toBe(error);
  });

  test("the shared request is cancelled only once every waiter has aborted", async () => {
    const coalescer = new Coalescer(100);
    const first = upstream();
    const one = new AbortController();
    const two = new AbortController();
    const a = coalescer.request("k", one.signal, first.run, noJoin);
    const b = coalescer.request("k", two.signal, upstream().run, () => undefined);
    const reasonOne = new Error("one left");
    one.abort(reasonOne);
    await expect(a).rejects.toBe(reasonOne);
    expect(first.signal().aborted).toBe(false);
    expect(coalescer.size).toBe(1);

    const reasonTwo = new Error("two left");
    two.abort(reasonTwo);
    await expect(b).rejects.toBe(reasonTwo);
    expect(first.signal().aborted).toBe(true);
    expect(coalescer.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("a caller that aborts inside its join notification is not counted as a waiter", async () => {
    const coalescer = new Coalescer(100);
    const first = upstream();
    const starter = new AbortController();
    const a = coalescer.request("k", starter.signal, first.run, noJoin);
    const joiner = new AbortController();
    const reason = new Error("left during join");
    const b = coalescer.request("k", joiner.signal, upstream().run, () => joiner.abort(reason));
    await expect(b).rejects.toBe(reason);
    expect(first.signal().aborted).toBe(false);

    // The starter is the only waiter, so its abort still cancels the shared request.
    starter.abort(new Error("starter left"));
    await expect(a).rejects.toThrow("starter left");
    expect(first.signal().aborted).toBe(true);
  });

  test("a joiner that outwaits the deadline retries with its own request and leaves the old one running", async () => {
    const coalescer = new Coalescer(100);
    const first = upstream();
    const second = upstream();
    const a = coalescer.request("k", undefined, first.run, noJoin);
    vi.advanceTimersByTime(50);
    const joined = vi.fn();
    const b = coalescer.request("k", undefined, second.run, joined);
    expect(joined).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(49);
    expect(second.run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(second.run).toHaveBeenCalledTimes(1);
    // The retry is a fresh request, not a second join.
    expect(joined).toHaveBeenCalledTimes(1);
    expect(coalescer.size).toBe(1);
    // The starter still waits, so the stalled request is not cancelled.
    expect(first.signal().aborted).toBe(false);

    second.resolve("fresh");
    await expect(b).resolves.toBe("fresh");
    first.resolve("slow");
    await expect(a).resolves.toBe("slow");
    expect(coalescer.size).toBe(0);
  });

  test("a call that arrives after the deadline starts its own request instead of joining", async () => {
    const coalescer = new Coalescer(100);
    const first = upstream();
    const second = upstream();
    const controller = new AbortController();
    const a = coalescer.request("k", controller.signal, first.run, noJoin);
    vi.advanceTimersByTime(100);
    const b = coalescer.request("k", undefined, second.run, noJoin);
    expect(second.run).toHaveBeenCalledTimes(1);
    expect(coalescer.size).toBe(1);

    // The stale request's last waiter leaving cancels it without evicting its replacement.
    const reason = new Error("stale waiter left");
    controller.abort(reason);
    await expect(a).rejects.toBe(reason);
    expect(first.signal().aborted).toBe(true);
    expect(second.signal().aborted).toBe(false);
    expect(coalescer.size).toBe(1);

    const joined = vi.fn();
    const c = coalescer.request("k", undefined, upstream().run, joined);
    expect(joined).toHaveBeenCalledTimes(1);
    second.resolve("replacement");
    await expect(Promise.all([b, c])).resolves.toEqual(["replacement", "replacement"]);
  });

  test("progress from the shared request extends the deadline, so joiners keep waiting", async () => {
    const coalescer = new Coalescer(100);
    const first = upstream();
    const second = upstream();
    const a = coalescer.request("k", undefined, first.run, noJoin);
    vi.advanceTimersByTime(50);
    const b = coalescer.request("k", undefined, second.run, () => undefined);

    // At 90ms the request reports a 20ms backoff: the deadline moves to 90 + 20 + 100.
    vi.advanceTimersByTime(40);
    first.progress(20);
    vi.advanceTimersByTime(119);
    expect(second.run).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);

    // Bare progress at 209ms moves it to 309ms. An earlier deadline never shortens it.
    first.progress();
    vi.advanceTimersByTime(99);
    expect(second.run).not.toHaveBeenCalled();

    first.resolve("patient");
    await expect(Promise.all([a, b])).resolves.toEqual(["patient", "patient"]);
    expect(second.run).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  test("joiners that time out together share one retry", async () => {
    const coalescer = new Coalescer(100);
    const first = upstream();
    const second = upstream();
    const third = upstream();
    const controller = new AbortController();
    const a = coalescer.request("k", controller.signal, first.run, noJoin);
    vi.advanceTimersByTime(50);
    const b = coalescer.request("k", undefined, second.run, () => undefined);
    const c = coalescer.request("k", undefined, third.run, () => undefined);

    vi.advanceTimersByTime(50);
    expect(second.run).toHaveBeenCalledTimes(1);
    expect(third.run).not.toHaveBeenCalled();
    expect(coalescer.size).toBe(1);
    expect(first.signal().aborted).toBe(false);

    // Once the starter leaves too, nobody waits on the stalled request and it is cancelled.
    controller.abort(new Error("starter left"));
    await expect(a).rejects.toThrow("starter left");
    expect(first.signal().aborted).toBe(true);
    expect(coalescer.size).toBe(1);

    second.resolve("retried");
    await expect(Promise.all([b, c])).resolves.toEqual(["retried", "retried"]);
    expect(third.run).not.toHaveBeenCalled();
  });

  test("a joiner that aborts while waiting clears its deadline timer", async () => {
    const coalescer = new Coalescer(100);
    const first = upstream();
    const second = upstream();
    const a = coalescer.request("k", undefined, first.run, noJoin);
    const controller = new AbortController();
    const b = coalescer.request("k", controller.signal, second.run, () => undefined);
    expect(vi.getTimerCount()).toBe(1);
    const reason = new Error("joiner left");
    controller.abort(reason);
    await expect(b).rejects.toBe(reason);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(1_000);
    expect(second.run).not.toHaveBeenCalled();
    expect(first.signal().aborted).toBe(false);
    first.resolve("done");
    await expect(a).resolves.toBe("done");
  });

  test("works where timers are plain numbers without unref", async () => {
    const scheduled: { callback: () => void; delay: number }[] = [];
    const cleared: unknown[] = [];
    vi.stubGlobal("setTimeout", (callback: () => void, delay: number): number => {
      scheduled.push({ callback, delay });
      return scheduled.length;
    });
    vi.stubGlobal("clearTimeout", (id: unknown): void => {
      cleared.push(id);
    });
    const coalescer = new Coalescer(100);
    const first = upstream();
    const a = coalescer.request("k", undefined, first.run, noJoin);
    const b = coalescer.request("k", undefined, upstream().run, () => undefined);
    expect(scheduled.map((timer) => timer.delay)).toEqual([100]);
    first.resolve("browser");
    await expect(Promise.all([a, b])).resolves.toEqual(["browser", "browser"]);
    expect(cleared).toEqual([1]);
  });
});
