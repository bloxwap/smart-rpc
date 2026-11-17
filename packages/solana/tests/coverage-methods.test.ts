import { describe, expect, test } from "vitest";

import { isSafeSolanaMethod, parseSlot, solanaCachePolicy } from "../src/methods.js";

describe("Solana method classification", () => {
  test("an unknown method is safe only when the caller allows it, and a block or a send name wins", () => {
    expect(isSafeSolanaMethod("getCustomIndex")).toBe(false);
    expect(isSafeSolanaMethod("getCustomIndex", [], ["getCustomIndex"])).toBe(true);
    expect(isSafeSolanaMethod("getCustomIndex", ["getCustomIndex"], ["getCustomIndex"])).toBe(false);
    expect(isSafeSolanaMethod("sendTransaction", [], ["sendTransaction"])).toBe(false);
    expect(isSafeSolanaMethod("getSlot")).toBe(true);
    expect(isSafeSolanaMethod("getSlot", ["getSlot"])).toBe(false);
  });

  test("the cache policy skips uncacheable methods and pins cluster constants", () => {
    const policy = solanaCachePolicy();
    expect(policy.classify("sendTransaction", ["tx"])).toBe(false);
    expect(policy.classify("getCustomIndex", [])).toBe(false);
    expect(policy.classify("getGenesisHash", [])).toBe("immutable");
    expect(policy.classify("getVersion", [])).toBe("immutable");
    expect(policy.classify("getBalance", ["account"])).toBe("fresh");
  });

  test("getTransaction is immutable only at the finalized commitment, which is also the default", () => {
    const policy = solanaCachePolicy();
    const classify = (params: unknown) => policy.classify("getTransaction", params);
    expect(classify(undefined)).toBe("immutable");
    expect(classify({ signature: "sig" })).toBe("immutable");
    expect(classify(["sig"])).toBe("immutable");
    expect(classify(["sig", "json"])).toBe("immutable");
    expect(classify(["sig", null])).toBe("immutable");
    expect(classify(["sig", { encoding: "json" }])).toBe("immutable");
    expect(classify(["sig", { commitment: 1 }])).toBe("immutable");
    expect(classify(["sig", { commitment: "finalized" }])).toBe("immutable");
    expect(classify(["sig", { commitment: "confirmed" }])).toBe("fresh");
    expect(classify(["sig", { commitment: "processed" }])).toBe("fresh");
  });

  test("parseSlot accepts whole numbers and digit strings, and nothing else", () => {
    expect(parseSlot(0)).toBe(0);
    expect(parseSlot("123")).toBe(123);
    expect(parseSlot("9007199254740993")).toBeNull();
    expect(parseSlot("0x10")).toBeNull();
    expect(parseSlot("-4")).toBeNull();
    expect(parseSlot("")).toBeNull();
    expect(parseSlot(null)).toBeNull();
    expect(parseSlot({ slot: 5 })).toBeNull();
    expect(parseSlot(5n)).toBeNull();
  });
});
