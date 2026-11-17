import { describe, expect, test } from "vitest";

import { Budgets, defaultBurst, resolveDefaultBudget, resolveEndpointBudget } from "../src/budget.js";

describe("defaultBurst", () => {
  test("is two seconds of traffic and never less than one request", () => {
    expect(defaultBurst(5)).toBe(10);
    expect(defaultBurst(1.2)).toBe(3);
    expect(defaultBurst(0.1)).toBe(1);
  });
});

describe("resolveDefaultBudget", () => {
  test("passes false and undefined through untouched", () => {
    expect(resolveDefaultBudget(false)).toBe(false);
    expect(resolveDefaultBudget(undefined)).toBeUndefined();
  });

  test("fills the default burst and keeps an explicit one", () => {
    expect(resolveDefaultBudget({ rps: 4 })).toEqual({ rps: 4, burst: 8 });
    expect(resolveDefaultBudget({ rps: 4, burst: 1 })).toEqual({ rps: 4, burst: 1 });
  });

  test("rejects a bad rps or burst and names the option", () => {
    expect(() => resolveDefaultBudget({ rps: 0 })).toThrow("smart-rpc budget.rps must be a finite number above 0.");
    expect(() => resolveDefaultBudget({ rps: Number.NaN })).toThrow("smart-rpc budget.rps");
    expect(() => resolveDefaultBudget({ rps: Number.POSITIVE_INFINITY }, "custom")).toThrow(
      "custom.rps must be a finite number above 0.",
    );
    expect(() => resolveDefaultBudget({ rps: 1, burst: 0.5 })).toThrow(
      "smart-rpc budget.burst must be a finite number of at least 1.",
    );
    expect(() => resolveDefaultBudget({ rps: 1, burst: Number.POSITIVE_INFINITY })).toThrow("smart-rpc budget.burst");
  });
});

describe("resolveEndpointBudget", () => {
  const fallback = { rps: 10, burst: 3 };

  test("a transport budget of false turns the endpoint's own budget off", () => {
    expect(resolveEndpointBudget({ rps: 5, burst: 5 }, false, "endpoint a")).toBeUndefined();
  });

  test("an endpoint without rps or burst inherits the fallback as is", () => {
    expect(resolveEndpointBudget({}, fallback, "endpoint a")).toBe(fallback);
    expect(resolveEndpointBudget({}, undefined, "endpoint a")).toBeUndefined();
  });

  test("an endpoint rps replaces the fallback and does not inherit its burst", () => {
    expect(resolveEndpointBudget({ rps: 2 }, fallback, "endpoint a")).toEqual({ rps: 2, burst: 4 });
    expect(resolveEndpointBudget({ rps: 2 }, undefined, "endpoint a")).toEqual({ rps: 2, burst: 4 });
    expect(resolveEndpointBudget({ rps: 2, burst: 7 }, fallback, "endpoint a")).toEqual({ rps: 2, burst: 7 });
  });

  test("an endpoint burst alone borrows the fallback rps", () => {
    expect(resolveEndpointBudget({ burst: 9 }, fallback, "endpoint a")).toEqual({ rps: 10, burst: 9 });
  });

  test("an endpoint burst with no rps anywhere is rejected", () => {
    expect(() => resolveEndpointBudget({ burst: 9 }, undefined, "endpoint a")).toThrow(
      "endpoint a.burst needs an rps, on the endpoint or in budget.",
    );
  });

  test("endpoint values are validated", () => {
    expect(() => resolveEndpointBudget({ rps: -1 }, fallback, "endpoint a")).toThrow("endpoint a.rps must be");
    expect(() => resolveEndpointBudget({ burst: 0 }, fallback, "endpoint a")).toThrow("endpoint a.burst must be");
  });
});

describe("Budgets", () => {
  test("an endpoint without a budget is unlimited and reports no remaining count", () => {
    const budgets = new Budgets(() => 0);
    budgets.configure("free", undefined);
    expect(budgets.has("free")).toBe(true);
    expect(budgets.take("free")).toBe(true);
    expect(budgets.remaining("free")).toBeNull();
    expect(budgets.refillMs(["free"])).toBe(0);
    expect(budgets.refillMs([])).toBe(0);
  });

  test("a bucket drains, refuses, and refills from the clock up to its burst", () => {
    let now = 0;
    const budgets = new Budgets(() => now);
    budgets.configure("a", { rps: 2, burst: 2 });
    expect(budgets.remaining("a")).toBe(2);
    expect(budgets.take("a")).toBe(true);
    expect(budgets.take("a")).toBe(true);
    expect(budgets.has("a")).toBe(false);
    expect(budgets.take("a")).toBe(false);
    expect(budgets.refillMs(["a"])).toBe(500);
    now = 250;
    expect(budgets.remaining("a")).toBe(0);
    expect(budgets.refillMs(["a"])).toBe(250);
    now = 500;
    expect(budgets.take("a")).toBe(true);
    now = 60_000;
    expect(budgets.remaining("a")).toBe(2);
  });

  test("refillMs reports the soonest endpoint", () => {
    const budgets = new Budgets(() => 0);
    budgets.configure("slow", { rps: 1, burst: 1 });
    budgets.configure("fast", { rps: 10, burst: 1 });
    expect(budgets.take("slow")).toBe(true);
    expect(budgets.take("fast")).toBe(true);
    expect(budgets.refillMs(["slow", "fast"])).toBe(100);
    expect(budgets.refillMs(["slow"])).toBe(1_000);
  });

  test("a non-finite or backwards clock sample does not move the bucket", () => {
    let now = 1_000;
    const budgets = new Budgets(() => now);
    budgets.configure("a", { rps: 1, burst: 1 });
    expect(budgets.take("a")).toBe(true);
    now = Number.NaN;
    expect(budgets.remaining("a")).toBe(0);
    expect(budgets.take("a")).toBe(false);
    now = Number.POSITIVE_INFINITY;
    expect(budgets.take("a")).toBe(false);
    now = 0;
    expect(budgets.take("a")).toBe(false);
    // The bucket still counts from the last good sample at 1000.
    now = 1_500;
    expect(budgets.take("a")).toBe(false);
    now = 2_000;
    expect(budgets.take("a")).toBe(true);
  });

  test("configuring the same endpoint again must repeat the same budget and never refills it", () => {
    const budgets = new Budgets(() => 0);
    budgets.configure("a", { rps: 1, burst: 2 });
    expect(budgets.take("a")).toBe(true);
    budgets.configure("a", { rps: 1, burst: 2 });
    expect(budgets.remaining("a")).toBe(1);
    expect(() => budgets.configure("a", { rps: 2, burst: 2 })).toThrow("Conflicting request budgets for endpoint a.");
    expect(() => budgets.configure("a", { rps: 1, burst: 3 })).toThrow("Conflicting request budgets for endpoint a.");
    expect(() => budgets.configure("a", undefined)).toThrow("Conflicting request budgets for endpoint a.");

    budgets.configure("free", undefined);
    budgets.configure("free", undefined);
    expect(() => budgets.configure("free", { rps: 1, burst: 1 })).toThrow("Conflicting request budgets for endpoint free.");
    expect(budgets.remaining("free")).toBeNull();
  });

  test("a provider budget is charged together with each endpoint in its group", () => {
    const budgets = new Budgets(() => 0);
    const provider = { rps: 1, burst: 2 };
    budgets.configure("a", { rps: 10, burst: 10 }, "acme", provider);
    budgets.configure("b", undefined, "acme", provider);
    expect(budgets.remaining("a")).toBe(2);
    expect(budgets.remaining("b")).toBe(2);
    expect(budgets.take("a")).toBe(true);
    expect(budgets.take("b")).toBe(true);
    expect(budgets.has("a")).toBe(false);
    expect(budgets.take("a")).toBe(false);
    // A refused take charges nothing: the endpoint's own bucket kept its tokens.
    expect(budgets.refillMs(["a"])).toBe(1_000);
    expect(budgets.refillMs(["b"])).toBe(1_000);
  });

  test("a provider budget needs a group and must agree across the group", () => {
    const budgets = new Budgets(() => 0);
    expect(() => budgets.configure("a", undefined, undefined, { rps: 1, burst: 1 })).toThrow(
      "providerBudget requires providerGroup.",
    );
    budgets.configure("b", undefined, "acme", { rps: 1, burst: 1 });
    expect(() => budgets.configure("c", undefined, "acme", { rps: 2, burst: 1 })).toThrow(
      "Conflicting request budgets for provider group acme.",
    );
    expect(() => budgets.configure("d", undefined, "acme", { rps: 1, burst: 2 })).toThrow(
      "Conflicting request budgets for provider group acme.",
    );
    // A group member registered without a provider budget still shares the group's bucket.
    budgets.configure("e", undefined, "acme");
    expect(budgets.take("e")).toBe(true);
    expect(budgets.take("b")).toBe(false);
  });
});
