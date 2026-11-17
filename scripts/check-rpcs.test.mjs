import assert from "node:assert/strict";
import { test } from "node:test";
import { checkEndpoint, latencySummary, parseOptions } from "./check-rpcs.mjs";

const group = { protocol: "ethereum", network: "mainnet", chainId: "eip155:1", identity: 1 };
const entry = { id: "test", url: "https://rpc.example", provider: "test" };
const options = { timeout: 100, samples: 3, state: true };

function serve(t, reply) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    const request = JSON.parse(init.body);
    calls.push(request.method);
    const result = reply(request, calls.length);
    return result instanceof Response ? result : Response.json({ jsonrpc: "2.0", id: request.id, result });
  });
  return calls;
}

test("sample options reject invalid or unbounded maintenance traffic", () => {
  assert.equal(parseOptions([]).samples, 1);
  assert.equal(parseOptions(["--samples", "5", "--state"]).state, true);
  for (const value of ["0", "21", "1.5", "NaN", "-1"]) {
    assert.throws(() => parseOptions(["--samples", value]));
  }
  assert.throws(() => parseOptions(["--samples"]));
  assert.throws(() => parseOptions(["--protocol", "unknown"]));
  assert.deepEqual(parseOptions(["--help"]), { help: true });
});

test("percentiles exclude failures but always expose failure counts", () => {
  assert.deepEqual(latencySummary([
    { status: "passed", durationMs: 30 }, { status: "failed", durationMs: 5000 },
    { status: "passed", durationMs: 10 }, { status: "passed", durationMs: 20 },
  ]), { attempts: 4, successes: 3, failures: 1, p50Ms: 20, p95Ms: 30, minMs: 10, maxMs: 30 });
  assert.equal(latencySummary([]).p50Ms, null);
});

test("identity is checked once before repeated paced head and state reads", async (t) => {
  const calls = serve(t, ({ method }) => method === "eth_chainId" ? "0x1" : "0x10");
  let paced = 0;
  const result = await checkEndpoint(group, entry, options, async () => { paced++; });
  assert.equal(result.status, "passed");
  assert.equal(paced, 10);
  assert.deepEqual(calls, ["eth_chainId", ...Array.from({ length: 3 }, () => ["eth_blockNumber", "eth_getBalance", "eth_call"]).flat()]);
  assert.equal(result.latency.eth_getBalance.successes, 3);
  assert.equal(result.defaultEligible, true);
});

test("another chain is never sampled even if its endpoint is fast", async (t) => {
  const calls = serve(t, () => "0x2");
  const result = await checkEndpoint(group, entry, options, async () => {});
  assert.equal(result.status, "failed");
  assert.equal(result.checks[0].category, "chain_mismatch");
  assert.equal(result.latency.eth_blockNumber.attempts, 0);
  assert.deepEqual(calls, ["eth_chainId"]);
});

test("an intermittent head failure cannot become a passing endpoint", async (t) => {
  serve(t, ({ method }, count) => count === 2 ? new Response("down", { status: 503 }) : method === "eth_chainId" ? "0x1" : "0x10");
  const result = await checkEndpoint(group, entry, options, async () => {});
  assert.equal(result.status, "failed");
  assert.equal(result.latency.eth_blockNumber.successes, 2);
  assert.equal(result.latency.eth_blockNumber.failures, 1);
  assert.equal(result.latency.eth_getBalance.successes, 3);
});

test("a quota denial stops subsequent samples", async (t) => {
  const calls = serve(t, (_request, count) => count === 1 ? "0x1" : new Response("limited", { status: 429 }));
  const result = await checkEndpoint(group, entry, options, async () => {});
  assert.equal(result.status, "failed");
  assert.equal(result.checks[1].category, "rate_limited");
  assert.equal(calls.length, 2);
});

test("paid-only reads cannot be advertised as working keyless state RPCs", async (t) => {
  const calls = serve(t, ({ id, method }) => method === "eth_call"
    ? Response.json({ jsonrpc: "2.0", id, error: { code: -16401, message: "Method is available for paid plans only" } }) : "0x1");
  const result = await checkEndpoint(group, entry, options, async () => {});
  assert.equal(result.status, "failed");
  assert.equal(result.checks.at(-1).category, "plan_restricted");
  assert.equal(calls.length, 4);
});

test("Solana balance samples validate both lamports and context slot", async (t) => {
  serve(t, ({ method }) => method === "getGenesisHash" ? "genesis" : method === "getSlot" ? 100 : { value: 0, context: { slot: 100 } });
  const solana = { ...group, protocol: "solana", identity: "genesis" };
  const result = await checkEndpoint(solana, entry, options, async () => {});
  assert.equal(result.status, "passed");
  assert.equal(result.latency.getBalance.successes, 3);
});

test("malformed JSON-RPC and invalid Solana state are reported", async (t) => {
  serve(t, () => Response.json({ jsonrpc: "2.0", id: -1, result: "0x1" }));
  const result = await checkEndpoint(group, entry, options, async () => {});
  assert.equal(result.checks[0].category, "malformed_response");
  t.mock.restoreAll();
  serve(t, ({ method }) => method === "getGenesisHash" ? "genesis" : method === "getSlot" ? 100 : { value: 0, context: { slot: -1 } });
  const invalid = await checkEndpoint({ ...group, protocol: "solana", identity: "genesis" }, entry, options, async () => {});
  assert.equal(invalid.latency.getBalance.failures, 3);
});
