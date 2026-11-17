import { describe, expect, test } from "vitest";

import { numericBlock, supportsEvmRequest, validateCapabilities, type EthereumEndpointCapabilities } from "../src/capabilities.js";
import { ethereum } from "../src/transport.js";

describe("block selectors", () => {
  const pruned: EthereumEndpointCapabilities = { archive: false, blockTags: ["latest", "earliest"] };

  test("a block method with no selector is left for the server to judge", () => {
    expect(supportsEvmRequest(pruned, { method: "eth_getBlockByNumber" })).toBe(true);
    expect(supportsEvmRequest(pruned, { method: "eth_feeHistory", params: ["0x4"] })).toBe(true);
    // The same endpoint still refuses a tag it does not serve.
    expect(supportsEvmRequest(pruned, { method: "eth_getBlockByNumber", params: ["finalized", false] })).toBe(false);
  });

  test("a state method with no selector means latest", () => {
    expect(supportsEvmRequest({ blockTags: ["finalized"] }, { method: "eth_getBalance", params: ["0xabc"] })).toBe(false);
    expect(supportsEvmRequest({ blockTags: ["latest"] }, { method: "eth_getBalance", params: ["0xabc"] })).toBe(true);
  });

  test("genesis state needs an archive node, genesis block data does not", () => {
    expect(supportsEvmRequest(pruned, { method: "eth_getBalance", params: ["0xabc", "earliest"] })).toBe(false);
    expect(supportsEvmRequest(pruned, { method: "eth_getBlockByNumber", params: ["earliest", false] })).toBe(true);
    expect(supportsEvmRequest({ ...pruned, archive: true }, { method: "eth_getBalance", params: ["0xabc", "earliest"] })).toBe(true);
  });

  test("an EIP-1898 blockNumber is judged like the bare selector it wraps", () => {
    expect(supportsEvmRequest(pruned, { method: "eth_call", params: [{}, { blockNumber: "0x10" }] })).toBe(false);
    expect(supportsEvmRequest(pruned, { method: "eth_call", params: [{}, { blockNumber: "latest" }] })).toBe(true);
    expect(supportsEvmRequest(pruned, { method: "eth_call", params: [{}, { blockNumber: "safe" }] })).toBe(false);
    expect(supportsEvmRequest({ archive: true }, { method: "eth_call", params: [{}, { blockNumber: "0x10" }] })).toBe(true);
    // An object naming neither field carries nothing to refuse.
    expect(supportsEvmRequest(pruned, { method: "eth_call", params: [{}, {}] })).toBe(true);
  });
});

describe("eth_getLogs filters", () => {
  const caps: EthereumEndpointCapabilities = { blockTags: ["latest"], maxLogBlockRange: 10, maxLogTopics: 2 };

  test("a block hash filter skips range and tag checks", () => {
    expect(supportsEvmRequest(caps, { method: "eth_getLogs", params: [{ blockHash: "0xabc", fromBlock: "finalized", toBlock: "0xffff" }] })).toBe(true);
    // The topic ceiling still applies to it.
    expect(supportsEvmRequest(caps, { method: "eth_getLogs", params: [{ blockHash: "0xabc", topics: [null, null, null] }] })).toBe(false);
  });

  test("either bound naming an unserved tag is refused, and a missing bound means latest", () => {
    expect(supportsEvmRequest(caps, { method: "eth_getLogs", params: [{ fromBlock: "finalized", toBlock: "latest" }] })).toBe(false);
    expect(supportsEvmRequest(caps, { method: "eth_getLogs", params: [{ fromBlock: "latest", toBlock: "pending" }] })).toBe(false);
    expect(supportsEvmRequest(caps, { method: "eth_getLogs", params: [{ fromBlock: "0x1" }] })).toBe(true);
    expect(supportsEvmRequest(caps, { method: "eth_getLogs", params: [{ toBlock: "0x1" }] })).toBe(true);
    expect(supportsEvmRequest(caps, { method: "eth_getLogs", params: [{}] })).toBe(true);
    expect(supportsEvmRequest({ ...caps, blockTags: ["finalized"] }, { method: "eth_getLogs", params: [{}] })).toBe(false);
  });

  test("malformed filters and inverted ranges are left for the server to report", () => {
    expect(supportsEvmRequest(caps, { method: "eth_getLogs" })).toBe(true);
    expect(supportsEvmRequest(caps, { method: "eth_getLogs", params: [["0x1"]] })).toBe(true);
    expect(supportsEvmRequest(caps, { method: "eth_getLogs", params: [{ fromBlock: "0xff", toBlock: "0x1" }] })).toBe(true);
    expect(supportsEvmRequest(caps, { method: "eth_getLogs", params: [{ fromBlock: "0x1", toBlock: "0xa" }] })).toBe(true);
    expect(supportsEvmRequest(caps, { method: "eth_getLogs", params: [{ fromBlock: "0x1", toBlock: "0xb" }] })).toBe(false);
  });
});

describe("numericBlock", () => {
  test("accepts only hex quantities", () => {
    expect(numericBlock("0xFf")).toBe(255n);
    expect(numericBlock("latest")).toBeUndefined();
    expect(numericBlock("0x")).toBeUndefined();
    expect(numericBlock(255)).toBeUndefined();
  });
});

describe("validateCapabilities", () => {
  test.each([
    ["maxBatchSize", 0],
    ["maxLogBlockRange", 1.5],
    ["maxLogTopics", -1],
    ["maxBatchSize", Number.NaN],
  ] as const)("rejects %s = %s", (key, limit) => {
    expect(() => validateCapabilities({ [key]: limit })).toThrow(`ethereum() capabilities.${key} must be a positive safe integer.`);
  });

  test("accepts omitted and positive limits", () => {
    expect(() => validateCapabilities(undefined)).not.toThrow();
    expect(() => validateCapabilities({ maxBatchSize: 1, maxLogBlockRange: 10_000, maxLogTopics: 4 })).not.toThrow();
  });

  test("ethereum() refuses an endpoint with an invalid limit", () => {
    expect(() => ethereum({ endpoints: [{ url: "https://a.example", capabilities: { maxLogBlockRange: 0 } }], headLag: false }))
      .toThrow("capabilities.maxLogBlockRange must be a positive safe integer.");
  });
});
