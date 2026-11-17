import { describe, expect, test } from "vitest";

import { shouldFailover } from "../src/evm-methods.js";

/** An invalid-params error, the code some providers use to report their own limits. */
function invalidParams(message: string): Error {
  return Object.assign(new Error(message), { code: -32602 });
}

describe("provider limits reported as invalid params", () => {
  test.each([
    "exceed maximum block range: 5000",
    "Exceeded max block range",
    "eth_getLogs is limited to a 10,000 block range",
    "query returned too many blocks in the requested block range",
    "block range is too wide",
    "Block range exceeds the configured limit",
    "BLOCK RANGE LIMIT: 1000",
    "requested block range above max",
    "block ranges over 10000 are not supported",
    "query returned more than 10,000 results",
    "too many logs",
    "response size exceeded",
    "query timeout",
  ])("fails over on %j", (message) => {
    expect(shouldFailover(invalidParams(message))).toBe(true);
  });

  test.each([
    "invalid block range",
    "missing value for required argument 0",
    // The limit word and the block range are in different sentences.
    "max is 5. block range",
    "block range\nmax",
    // Only part of the phrase.
    "max block",
    "maximum blockrange",
  ])("does not treat %j as a provider limit", (message) => {
    const error = invalidParams(message);
    // "invalid block range" fails over as a block-not-held miss, which is a different rule.
    expect(shouldFailover(error)).toBe(message === "invalid block range");
  });

  test("a limit message with another error code stays terminal only when the code is terminal", () => {
    expect(shouldFailover(Object.assign(new Error("exceeds max block range"), { code: -32000 }))).toBe(true);
    expect(shouldFailover(invalidParams("unrelated bad argument"))).toBe(false);
  });

  test("a hostile error message is classified in linear time", () => {
    // Each of these made the previous pattern scan quadratically (seconds at this size).
    const hostile = [
      "max".repeat(60_000),
      "block range".repeat(20_000),
      `${"limit ".repeat(40_000)}block rang`,
    ];
    const started = performance.now();
    for (const message of hostile) expect(shouldFailover(invalidParams(message))).toBe(false);
    expect(performance.now() - started).toBeLessThan(500);
  });
});
