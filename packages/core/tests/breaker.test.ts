import { describe, expect, test } from "vitest";

import {
  Breaker,
  DEFAULT_BREAKER_COOLDOWN_MS,
  DEFAULT_BREAKER_MAX_COOLDOWN_MS,
  DEFAULT_BREAKER_THRESHOLD,
  resolveBreaker,
  retryAfterMs,
} from "../src/breaker.js";

describe("breaker", () => {
  test("ejects after 3 failures and doubles 5s cooldowns up to 60s", () => {
    expect(DEFAULT_BREAKER_THRESHOLD).toBe(3);
    expect(DEFAULT_BREAKER_COOLDOWN_MS).toBe(5_000);
    expect(DEFAULT_BREAKER_MAX_COOLDOWN_MS).toBe(60_000);
    let now = 0;
    const breaker = new Breaker(resolveBreaker(undefined), () => now);
    expect(breaker.failure("a")).toBeUndefined();
    expect(breaker.failure("a")).toBeUndefined();
    expect(breaker.failure("a")).toEqual({ failures: 3, cooldownMs: 5_000 });
    expect(breaker.isOpen("a")).toBe(true);
    expect(breaker.remaining("a")).toBe(5_000);

    now = 5_000;
    expect(breaker.isOpen("a")).toBe(false);
    expect(breaker.failure("a")).toEqual({ failures: 4, cooldownMs: 10_000 });

    now = 15_000;
    expect(breaker.failure("a")).toEqual({ failures: 5, cooldownMs: 20_000 });

    now = 35_000;
    expect(breaker.failure("a")).toEqual({ failures: 6, cooldownMs: 40_000 });

    now = 75_000;
    expect(breaker.failure("a")).toEqual({ failures: 7, cooldownMs: 60_000 });

    now = 135_000;
    expect(breaker.failure("a")).toEqual({ failures: 8, cooldownMs: 60_000 });
  });

  test("a probe success does not clear a streak that holds a failed call", () => {
    const breaker = new Breaker(resolveBreaker(undefined), () => 0);
    breaker.failure("b");
    expect(breaker.success("b", true)).toBe(false);
    breaker.failure("b", 0, true);
    expect(breaker.success("b", true)).toBe(false);
    expect(breaker.failure("b")).toEqual({ failures: 3, cooldownMs: 5_000 });
    expect(breaker.success("b", true)).toBe(false);
    expect(breaker.isOpen("b")).toBe(true);
    expect(breaker.success("b")).toBe(true);
    expect(breaker.isOpen("b")).toBe(false);
  });

  test("a probe success clears a streak of probe-only failures", () => {
    const breaker = new Breaker(resolveBreaker(undefined), () => 0);
    breaker.failure("a", 0, true);
    breaker.failure("a", 0, true);
    expect(breaker.success("a", true)).toBe(false);
    expect(breaker.failure("a", 0, true)).toBeUndefined();
    expect(breaker.isOpen("a")).toBe(false);
  });

  test("Retry-After ejects at once and is capped at 60s", () => {
    const breaker = new Breaker(resolveBreaker(undefined), () => 0);
    expect(breaker.failure("a", 2_500)).toEqual({ failures: 1, cooldownMs: 2_500 });
    expect(breaker.isOpen("a")).toBe(true);
    expect(breaker.failure("b", 90_000)).toEqual({ failures: 1, cooldownMs: 60_000 });
  });
});

describe("retryAfterMs", () => {
  test("reads delta-seconds and HTTP dates, including a wrapped cause", () => {
    const seconds = { headers: new Headers({ "retry-after": "7" }) };
    expect(retryAfterMs(seconds)).toBe(7_000);
    const now = Date.parse("2026-01-01T00:00:00Z");
    const dated = { headers: new Headers({ "Retry-After": "Thu, 01 Jan 2026 00:00:12 GMT" }) };
    expect(retryAfterMs(dated, now)).toBe(12_000);
    expect(retryAfterMs(new Error("outer", { cause: seconds }))).toBe(7_000);
    expect(retryAfterMs(new Error("plain"))).toBe(0);
  });
});
