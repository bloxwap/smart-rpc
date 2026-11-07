import { describe, expect, test } from "vitest";

import { assignLags, L1_BLOCK_NUMBER_PRECOMPILE, probeEndpoint } from "../.dev/probe.js";
import {
  LOGS_RANGE_BLOCKS,
  LOGS_RANGE_PROBE,
  PRECOMPILE_PROBE,
  rankRegistry,
  type ProbeObservation,
} from "../src/registry/policy.js";

interface RpcRequest {
  method: string;
  params: unknown[];
}

const HEAD = 0x2fa_f080;
const L1_WORD = `0x${(123_456_789).toString(16).padStart(64, "0")}`;

function node(override: (request: RpcRequest) => Response | undefined = () => undefined): {
  fetchImpl: typeof fetch;
  requests: RpcRequest[];
} {
  const requests: RpcRequest[] = [];
  const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as RpcRequest;
    requests.push(request);
    const custom = override(request);
    if (custom) return custom;
    const ok = (result: unknown) => Response.json({ jsonrpc: "2.0", id: 1, result });
    if (request.method === "eth_chainId") return ok("0x3e7");
    if (request.method === "eth_blockNumber") return ok(`0x${HEAD.toString(16)}`);
    if (request.method === "eth_getLogs") return ok([]);
    if (request.method === "eth_call") {
      const [target] = request.params as [{ to: string }];
      return ok(target.to === L1_BLOCK_NUMBER_PRECOMPILE ? L1_WORD : "0x");
    }
    return Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "not found" } });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

const URL_UNDER_TEST = "https://node.example/evm";
const NOW = new Date("2026-10-30T00:00:00.000Z");

describe("HyperEVM probe observations", () => {
  test("calls the L1 block number precompile with empty calldata", async () => {
    const { fetchImpl, requests } = node();
    const observation = await probeEndpoint(URL_UNDER_TEST, { fetchImpl, now: NOW });
    const precompile = requests.find((request) => request.method === "eth_call" &&
      (request.params[0] as { to: string }).to === L1_BLOCK_NUMBER_PRECOMPILE);
    expect(L1_BLOCK_NUMBER_PRECOMPILE).toBe("0x0000000000000000000000000000000000000809");
    expect(precompile?.params).toEqual([{ to: L1_BLOCK_NUMBER_PRECOMPILE, data: "0x" }, "latest"]);
    expect(observation.methods[PRECOMPILE_PROBE]?.ok).toBe(true);
    expect(observation.ok).toBe(true);
  });

  test("queries an empty-address log page over 999 blocks ending at the head", async () => {
    const { fetchImpl, requests } = node();
    const observation = await probeEndpoint(URL_UNDER_TEST, { fetchImpl, now: NOW });
    const ranges = requests.filter((request) => request.method === "eth_getLogs")
      .map((request) => request.params[0] as { fromBlock: string; toBlock: string });
    const wide = ranges.find((range) => range.fromBlock !== range.toBlock);
    expect(Number.parseInt(wide?.toBlock ?? "", 16)).toBe(HEAD);
    expect(Number.parseInt(wide?.toBlock ?? "", 16) - Number.parseInt(wide?.fromBlock ?? "", 16) + 1).toBe(LOGS_RANGE_BLOCKS);
    expect(observation.methods[LOGS_RANGE_PROBE]?.ok).toBe(true);
  });

  test("records missing HyperCore support and makes the endpoint ineligible", async () => {
    const { fetchImpl } = node((request) => {
      const target = (request.params[0] as { to?: string } | undefined)?.to;
      if (request.method === "eth_call" && target === L1_BLOCK_NUMBER_PRECOMPILE) return Response.json({ jsonrpc: "2.0", id: 1, result: "0x" });
      return undefined;
    });
    const observation = await probeEndpoint(URL_UNDER_TEST, { fetchImpl, now: NOW });
    expect(observation.ok).toBe(true);
    expect(observation.methods[PRECOMPILE_PROBE]?.ok).toBe(false);
    const [ranked] = rankRegistry([{ url: URL_UNDER_TEST }], [{ ...observation, lag: 0 }], NOW.getTime());
    expect(ranked).toMatchObject({ eligible: false, weight: 0 });
  });

  test("rejects a zero precompile word", async () => {
    const { fetchImpl } = node((request) => {
      const target = (request.params[0] as { to?: string } | undefined)?.to;
      if (request.method === "eth_call" && target === L1_BLOCK_NUMBER_PRECOMPILE) {
        return Response.json({ jsonrpc: "2.0", id: 1, result: `0x${"0".repeat(64)}` });
      }
      return undefined;
    });
    const observation = await probeEndpoint(URL_UNDER_TEST, { fetchImpl, now: NOW });
    expect(observation.methods[PRECOMPILE_PROBE]?.ok).toBe(false);
  });

  test("records a provider range cap without confusing it with single-block logs", async () => {
    const { fetchImpl } = node((request) => {
      if (request.method !== "eth_getLogs") return undefined;
      const [range] = request.params as [{ fromBlock: string; toBlock: string }];
      if (range.fromBlock === range.toBlock) return undefined;
      return Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "query exceeds max block range 100" } });
    });
    const observation = await probeEndpoint(URL_UNDER_TEST, { fetchImpl, now: NOW });
    expect(observation.methods.eth_getLogs?.ok).toBe(true);
    expect(observation.methods[LOGS_RANGE_PROBE]?.ok).toBe(false);
  });

  test("marks capability probes failed on the wrong chain", async () => {
    const { fetchImpl } = node((request) => request.method === "eth_chainId"
      ? Response.json({ jsonrpc: "2.0", id: 1, result: "0x3e6" })
      : undefined);
    const observation = await probeEndpoint(URL_UNDER_TEST, { fetchImpl, now: NOW });
    expect(observation.chainIdOk).toBe(false);
    expect(observation.methods[PRECOMPILE_PROBE]?.ok).toBe(false);
    expect(observation.methods[LOGS_RANGE_PROBE]?.ok).toBe(false);
  });
});

function observation(url: string, head: number, headAt: string): ProbeObservation {
  return { at: headAt, url, ok: true, chainIdOk: true, head, lag: null, headAt, methods: { eth_blockNumber: { ms: 10, ok: true } } };
}

describe("head lag adjustment", () => {
  test("projects an earlier head forward by one block per second", () => {
    const early = observation("https://early.example/evm", 1_000, "2026-10-30T00:00:00.000Z");
    const late = observation("https://late.example/evm", 1_004, "2026-10-30T00:00:04.000Z");
    expect(assignLags([early, late]).map((row) => row.lag)).toEqual([0, 0]);
  });

  test("keeps a real gap after time adjustment", () => {
    const stale = observation("https://stale.example/evm", 1_000, "2026-10-30T00:00:00.000Z");
    const tip = observation("https://tip.example/evm", 1_010, "2026-10-30T00:00:03.000Z");
    expect(assignLags([stale, tip]).map((row) => row.lag)).toEqual([7, 0]);
  });

  test("ignores a head from the wrong chain", () => {
    const wrong: ProbeObservation = { ...observation("https://wrong.example/evm", 5_000, "2026-10-30T00:00:05.000Z"), chainIdOk: false, ok: false };
    const right = observation("https://right.example/evm", 1_000, "2026-10-30T00:00:00.000Z");
    expect(assignLags([wrong, right]).map((row) => row.lag)).toEqual([null, 0]);
  });
});
