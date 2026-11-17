import { describe, expect, test, vi } from "vitest";

import { DEFAULT_RACE_WIDTH, pickRacers, raceCalls, resolveRace, type RaceCall, type RacePool } from "../src/race.js";

interface Racer {
  call: RaceCall;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  cancel: ReturnType<typeof vi.fn<() => void>>;
}

function racer(): Racer {
  let resolve: (value: unknown) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  let cancelled = false;
  const cancel = vi.fn<() => void>(() => {
    cancelled = true;
  });
  return { call: { promise, cancel, cancelled: () => cancelled }, resolve, reject, cancel };
}

const never = (): boolean => false;

describe("resolveRace", () => {
  test("false turns racing off", () => {
    expect(resolveRace(false)).toBe(0);
  });

  test("true, undefined, and an empty object race the default width", () => {
    expect(resolveRace(true)).toBe(DEFAULT_RACE_WIDTH - 1);
    expect(resolveRace(undefined)).toBe(DEFAULT_RACE_WIDTH - 1);
    expect(resolveRace({})).toBe(DEFAULT_RACE_WIDTH - 1);
    expect(resolveRace({ width: undefined })).toBe(DEFAULT_RACE_WIDTH - 1);
  });

  test("an explicit width races that many endpoints, the lead included", () => {
    expect(resolveRace({ width: 2 })).toBe(1);
    expect(resolveRace({ width: 4 })).toBe(3);
  });

  test("a width below 2 or a fraction is rejected", () => {
    expect(() => resolveRace({ width: 1 })).toThrow("smart-rpc race.width must be an integer of at least 2, got 1.");
    expect(() => resolveRace({ width: 2.5 })).toThrow("got 2.5.");
    expect(() => resolveRace({ width: Number.NaN })).toThrow("got NaN.");
  });
});

describe("pickRacers", () => {
  type Endpoint = { readonly id: string };
  type State = ReturnType<RacePool<Endpoint>["state"]>;

  function racePool(states: Record<string, State>): RacePool<Endpoint> & { verified: string[] } {
    const order = Object.keys(states);
    const verified: string[] = [];
    return {
      verified,
      next: (skip) => {
        const id = order.find((candidate) => !skip.has(candidate));
        return id === undefined ? undefined : { id };
      },
      state: (endpoint) => states[endpoint.id] ?? "unavailable",
      verify: (endpoint) => {
        verified.push(endpoint.id);
      },
    };
  }

  test("takes ready endpoints best first and stops at the count", () => {
    const source = racePool({ a: "ready", b: "ready", c: "ready" });
    expect(pickRacers(2, new Set(), source).map((endpoint) => endpoint.id)).toEqual(["a", "b"]);
    expect(source.verified).toEqual([]);
  });

  test("leaves out excluded endpoints without mutating the exclude set", () => {
    const exclude = new Set(["a"]);
    const source = racePool({ a: "ready", b: "ready" });
    expect(pickRacers(2, exclude, source).map((endpoint) => endpoint.id)).toEqual(["b"]);
    expect([...exclude]).toEqual(["a"]);
  });

  test("skips unavailable and unverified endpoints, checking at most count unverified ones", () => {
    const source = racePool({ u1: "unverified", down: "unavailable", u2: "unverified", u3: "unverified", ok: "ready" });
    expect(pickRacers(2, new Set(), source).map((endpoint) => endpoint.id)).toEqual(["ok"]);
    expect(source.verified).toEqual(["u1", "u2"]);
  });

  test("a count of zero asks the pool for nothing", () => {
    const next = vi.fn(() => ({ id: "a" }));
    expect(pickRacers(0, new Set(), { next, state: () => "ready", verify: () => undefined })).toEqual([]);
    expect(next).not.toHaveBeenCalled();
  });
});

describe("raceCalls", () => {
  test("a race with no calls rejects", async () => {
    const failed = vi.fn();
    const race = raceCalls([], never, failed);
    await expect(race.promise).rejects.toThrow("smart-rpc race has no calls.");
    expect(failed).not.toHaveBeenCalled();
  });

  test("the first success wins and cancels only the losers", async () => {
    const [a, b, c] = [racer(), racer(), racer()];
    const failed = vi.fn();
    const race = raceCalls([a.call, b.call, c.call], never, failed);
    b.resolve("winner");
    await expect(race.promise).resolves.toBe("winner");
    expect(a.cancel).toHaveBeenCalledTimes(1);
    expect(b.cancel).not.toHaveBeenCalled();
    expect(c.cancel).toHaveBeenCalledTimes(1);

    // Late settlements of the losers change nothing.
    a.resolve("late");
    c.reject(new Error("cancelled"));
    await Promise.allSettled([a.call.promise, c.call.promise]);
    await expect(race.promise).resolves.toBe("winner");
    expect(a.cancel).toHaveBeenCalledTimes(1);
    expect(failed).not.toHaveBeenCalled();
    expect(race.cancelled()).toBe(false);
  });

  test("an indecisive failure waits for the others, and a later success still wins", async () => {
    const [a, b] = [racer(), racer()];
    const decisive = vi.fn(never);
    const failed = vi.fn();
    const race = raceCalls([a.call, b.call], decisive, failed);
    const boom = new Error("a failed");
    a.reject(boom);
    await a.call.promise.catch(() => undefined);
    expect(decisive).toHaveBeenCalledWith(boom);
    expect(b.cancel).not.toHaveBeenCalled();
    b.resolve("b wins");
    await expect(race.promise).resolves.toBe("b wins");
    expect(a.cancel).toHaveBeenCalledTimes(1);
    expect(failed).not.toHaveBeenCalled();
  });

  test("when every call fails it rejects with the last error and reports the earlier ones", async () => {
    const [a, b, c] = [racer(), racer(), racer()];
    const decisive = vi.fn(never);
    const failed = vi.fn<(errors: readonly Error[]) => void>();
    const race = raceCalls([a.call, b.call, c.call], decisive, failed);
    const first = new Error("first");
    const last = new Error("last");
    a.reject(first);
    c.reject("second as a string");
    b.reject(last);
    await expect(race.promise).rejects.toBe(last);
    expect(failed).toHaveBeenCalledTimes(1);
    const earlier = failed.mock.calls[0]?.[0] ?? [];
    expect(earlier).toHaveLength(2);
    expect(earlier[0]).toBe(first);
    expect(earlier[1]).toBeInstanceOf(Error);
    expect(earlier[1]?.message).toBe("second as a string");
    // The last failure is never asked about: there is nobody left to wait for.
    expect(decisive).toHaveBeenCalledTimes(2);
  });

  test("a decisive failure ends the race at once and cancels the pending calls", async () => {
    const [a, b] = [racer(), racer()];
    const failed = vi.fn<(errors: readonly Error[]) => void>();
    const race = raceCalls([a.call, b.call], (error) => error.message === "fatal", failed);
    a.reject({ code: 1 });
    await a.call.promise.catch(() => undefined);
    expect(b.cancel).not.toHaveBeenCalled();
    b.reject(new Error("unused"));
    await expect(race.promise).rejects.toThrow("unused");
    expect(failed.mock.calls[0]?.[0].map((error) => error.message)).toEqual(["Unknown endpoint error"]);

    const [c, d] = [racer(), racer()];
    const failedFatal = vi.fn();
    const fatal = raceCalls([c.call, d.call], (error) => error.message === "fatal", failedFatal);
    c.reject(new Error("fatal"));
    await expect(fatal.promise).rejects.toThrow("fatal");
    expect(d.cancel).toHaveBeenCalledTimes(1);
    expect(c.cancel).not.toHaveBeenCalled();
    expect(failedFatal).toHaveBeenCalledWith([]);

    // The cancelled loser rejecting afterwards is ignored.
    d.reject(new Error("aborted"));
    await d.call.promise.catch(() => undefined);
    expect(failedFatal).toHaveBeenCalledTimes(1);
  });

  test("cancelling the race cancels every call and marks it cancelled", async () => {
    const [a, b] = [racer(), racer()];
    const race = raceCalls([a.call, b.call], never, () => undefined);
    expect(race.cancelled()).toBe(false);
    race.cancel();
    expect(race.cancelled()).toBe(true);
    expect(a.cancel).toHaveBeenCalledTimes(1);
    expect(b.cancel).toHaveBeenCalledTimes(1);
    expect(a.call.cancelled()).toBe(true);
    a.reject(new Error("aborted a"));
    b.reject(new Error("aborted b"));
    await expect(race.promise).rejects.toThrow("aborted b");
  });
});
