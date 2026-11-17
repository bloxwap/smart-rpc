import { describe, expect, test } from "vitest";

import { Breaker, resolveBreaker, retryAfterMs } from "../src/breaker.js";

function breaker(options: Parameters<typeof resolveBreaker>[0], start = 1_000) {
  const clock = { now: start };
  return { clock, breaker: new Breaker(resolveBreaker(options), () => clock.now) };
}

describe("breaker edges", () => {
  test("a disabled breaker records nothing and never ejects", () => {
    const { breaker: off } = breaker(false);
    for (let failure = 0; failure < 10; failure += 1) {
      expect(off.failure("a", 30_000)).toBeUndefined();
    }
    expect(off.remaining("a")).toBe(0);
    expect(off.isOpen("a")).toBe(false);
    expect(off.success("a")).toBe(false);
  });

  test("a failure while ejected extends the window only when Retry-After asks for longer", () => {
    const { clock, breaker: on } = breaker({ threshold: 1 });
    expect(on.failure("a")).toEqual({ failures: 1, cooldownMs: 5_000 });
    clock.now += 1_000;
    expect(on.failure("a", 1_000)).toBeUndefined();
    expect(on.remaining("a")).toBe(4_000);
    expect(on.failure("a", 20_000)).toBeUndefined();
    expect(on.remaining("a")).toBe(20_000);
    // Retry-After is capped at maxCooldown.
    expect(on.failure("a", 600_000)).toBeUndefined();
    expect(on.remaining("a")).toBe(60_000);
    expect(on.success("a")).toBe(true);
    expect(on.remaining("a")).toBe(0);
  });

  test("a clock that stops returning finite numbers keeps an ejected endpoint ejected", () => {
    const { clock, breaker: on } = breaker({ threshold: 2 });
    on.failure("ejected");
    expect(on.failure("ejected")).toEqual({ failures: 2, cooldownMs: 5_000 });
    expect(on.failure("counting")).toBeUndefined();
    clock.now = Number.NaN;
    expect(on.remaining("ejected")).toBe(6_000);
    expect(on.isOpen("ejected")).toBe(true);
    expect(on.remaining("counting")).toBe(0);
    expect(on.isOpen("counting")).toBe(false);
    clock.now = Number.POSITIVE_INFINITY;
    expect(on.isOpen("ejected")).toBe(true);
  });
});

describe("retryAfterMs edges", () => {
  const withHeader = (value: unknown): object => ({ headers: { get: (): unknown => value } });

  test("headers whose get is not a function are skipped, and the cause is read instead", () => {
    expect(retryAfterMs({ headers: { get: "retry-after" } })).toBe(0);
    expect(retryAfterMs({ headers: { get: 5 }, cause: withHeader("3") })).toBe(3_000);
  });

  test("a value that is neither seconds nor a date asks for nothing", () => {
    expect(retryAfterMs(withHeader("soon"), 0)).toBe(0);
    expect(retryAfterMs(withHeader(""), 0)).toBe(0);
  });

  test("an HTTP date is relative to now and never negative", () => {
    const at = Date.parse("Wed, 21 Oct 2026 07:28:00 GMT");
    expect(retryAfterMs(withHeader("Wed, 21 Oct 2026 07:28:00 GMT"), at - 7_000)).toBe(7_000);
    expect(retryAfterMs(withHeader("Wed, 21 Oct 2026 07:28:00 GMT"), at + 7_000)).toBe(0);
    expect(retryAfterMs(withHeader(" 1.5 "), 0)).toBe(1_500);
  });
});
