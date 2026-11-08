#!/usr/bin/env node
/**
 * Explicit, read-only live benchmark of every public registry in the release build,
 * plus the router that rotates across them. Run `pnpm build` first.
 * This script is intentionally outside the test suite and sends small, paced volumes.
 */

const EVM_CHAINS = {
  ethereum: 1, bsc: 56, polygon: 137, base: 8453, arbitrum: 42161, monad: 143,
  xlayer: 196, robinhood: 4663, plasma: 9745, ink: 57073, optimism: 10,
  opbnb: 204, arc: 5042, etherlink: 42793, avalanche: 43114, celo: 42220,
  gnosis: 100, mantle: 5000, flare: 14, hyperevm: 999,
};
const PROTOCOLS = [...Object.keys(EVM_CHAINS), "solana"];

const HELP = `Usage: node scripts/benchmark-rpcs.mjs [options]

Phase A probes every mainnet registry endpoint directly: head latency, success
rate, a same-method state read (eth_getBalance / getBalance with distinct
params), time-aligned head lag, and batch / eth_getLogs / archive support.
Compare the router against bestDirectReadP50: some providers answer the head
method from an edge cache, which no real read can match. Phase B sends a mixed read workload
through the transport's own router and records which endpoints served it.
No transactions are submitted. Build the workspace with pnpm build first.

Options:
  --protocol <list>   Comma-separated transport subpaths (default: all)
  --rounds <n>        Synchronized head rounds per chain, 1–30 (default: 8)
  --router <n>        Router requests per chain, 0–200 (default: 40)
  --timeout <ms>      Deadline per direct request (default: 8000)
  --chains <n>        Chains benchmarked concurrently, 1–8 (default: 4)
  --help              Show this help

JSON is written to stdout; progress goes to stderr. Results describe this
machine's network path at this time only.
Supported transports: ${PROTOCOLS.join(", ")}.
`;

function parseOptions(args) {
  const options = { protocols: PROTOCOLS, rounds: 8, router: 40, timeout: 8000, chains: 4 };
  const ranges = { rounds: [1, 30], router: [0, 200], timeout: [100, 60000], chains: [1, 8] };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--") continue;
    if (flag === "--help" || flag === "-h") return { help: true };
    const value = args[++index];
    if (!value) throw new Error(`${flag} requires a value.`);
    if (flag === "--protocol") {
      const list = value.split(",");
      for (const name of list) if (!PROTOCOLS.includes(name)) throw new Error(`Unknown protocol ${name}.`);
      options.protocols = list;
      continue;
    }
    const key = flag.slice(2);
    if (!ranges[key]) throw new Error(`Unknown argument: ${flag}`);
    const number = Number(value);
    if (!Number.isInteger(number) || number < ranges[key][0] || number > ranges[key][1]) {
      throw new Error(`${flag} must be an integer from ${ranges[key][0]} to ${ranges[key][1]}.`);
    }
    options[key] = number;
  }
  return options;
}

async function loadChain(name) {
  const module = await import(`../packages/smart-rpc/dist/${name}.js`);
  if (name === "solana") {
    return {
      name, solana: true, chainId: "solana:mainnet", identity: module.MAINNET_GENESIS_HASH,
      entries: module.MAINNET_REGISTRY, factory: () => module.solana(),
    };
  }
  const registry = module[`${name.toUpperCase()}_MAINNET_REGISTRY`];
  return {
    name, solana: false, chainId: `eip155:${EVM_CHAINS[name]}`, identity: EVM_CHAINS[name],
    entries: registry, factory: () => module[name](),
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One pacer for the whole run: providers serve many chains from one quota. */
const providerNext = new Map();
async function pace(entry) {
  const key = entry.providerGroup ?? entry.provider;
  const rps = Math.min(entry.rps ?? 2, entry.providerBudget?.rps ?? Infinity, 4);
  const interval = Math.ceil(1000 / rps);
  const now = performance.now();
  const reserved = Math.max(now, providerNext.get(key) ?? 0);
  providerNext.set(key, reserved + interval);
  if (reserved > now) await sleep(reserved - now);
}

function categorize(status, message = "", code) {
  if (status === 429 || code === -32005 || /rate.?limit|too many|quota|capacity|credits?/i.test(message)) return "rate_limited";
  if (status === 401 || status === 403 || /unauthori|forbidden|api.?key/i.test(message)) return "auth";
  if (status) return `http_${status}`;
  if (/range|too many blocks|block range|limit exceeded|exceed/i.test(message)) return "range_limit";
  if (/not (supported|available|found)|method .*not|does not exist|unsupported|whitelist/i.test(message)) return "unsupported";
  if (/missing trie|pruned|state.*not available|historical|archive|header not found/i.test(message)) return "no_archive";
  return "rpc_error";
}

let nextId = 1;
async function post(url, body, timeout) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const started = performance.now();
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
      redirect: "error",
    });
    const text = await response.text();
    const ms = performance.now() - started;
    if (!response.ok) return { ok: false, ms, category: categorize(response.status, text), message: `HTTP ${response.status} ${text.slice(0, 160)}` };
    let json;
    try { json = JSON.parse(text); } catch { return { ok: false, ms, category: "malformed", message: text.slice(0, 160) }; }
    return { ok: true, ms, json, bytes: text.length };
  } catch (error) {
    const ms = performance.now() - started;
    if (controller.signal.aborted) return { ok: false, ms, category: "timeout", message: `>${timeout}ms` };
    return { ok: false, ms, category: "network", message: String(error?.cause?.code ?? error?.message ?? error) };
  } finally {
    clearTimeout(timer);
  }
}

async function call(url, method, params, timeout) {
  const id = nextId++;
  const result = await post(url, { jsonrpc: "2.0", id, method, params }, timeout);
  if (!result.ok) return result;
  const body = result.json;
  if (!body || body.id !== id) return { ok: false, ms: result.ms, category: "malformed", message: "mismatched JSON-RPC id" };
  if (body.error) {
    return { ok: false, ms: result.ms, category: categorize(undefined, body.error.message, body.error.code), message: String(body.error.message).slice(0, 200) };
  }
  return { ok: true, ms: result.ms, result: body.result };
}

const quantile = (values, q) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]);
};
const toHead = (chain, value) => (chain.solana ? (Number.isSafeInteger(value) ? value : null)
  : typeof value === "string" && /^0x[\da-f]+$/i.test(value) ? Number(BigInt(value)) : null);

async function probeEndpoints(chain, options) {
  const stats = chain.entries.map((entry) => ({
    id: entry.id, provider: entry.provider, url: entry.url, rps: entry.rps ?? null,
    tier: entry.tier ?? entry.priority ?? entry.weight ?? null,
    latencies: [], reads: [], lags: [], errors: {}, attempts: 0, identity: null,
  }));
  const headMethod = chain.solana ? "getSlot" : "eth_blockNumber";
  const headParams = chain.solana ? [{ commitment: "processed" }] : [];

  // Identity first; mismatches are excluded from head comparisons.
  await Promise.all(chain.entries.map(async (entry, i) => {
    await pace(entry);
    const r = await call(entry.url, chain.solana ? "getGenesisHash" : "eth_chainId", [], options.timeout);
    if (!r.ok) { stats[i].identity = `error:${r.category}`; return; }
    const ok = chain.solana ? r.result === chain.identity : toHead(chain, r.result) === chain.identity;
    stats[i].identity = ok ? "ok" : `mismatch:${r.result}`;
  }));

  for (let round = 0; round < options.rounds; round += 1) {
    const samples = await Promise.all(chain.entries.map(async (entry, i) => {
      if (stats[i].identity?.startsWith("mismatch")) return null;
      await pace(entry);
      stats[i].attempts += 1;
      const r = await call(entry.url, headMethod, headParams, options.timeout);
      if (!r.ok) { stats[i].errors[r.category] = (stats[i].errors[r.category] ?? 0) + 1; return null; }
      const head = toHead(chain, r.result);
      if (head === null) { stats[i].errors.malformed = (stats[i].errors.malformed ?? 0) + 1; return null; }
      stats[i].latencies.push(r.ms);
      const at = performance.now();
      // Same-method read: a state read with distinct params, which edge caches cannot answer.
      await pace(entry);
      const read = chain.solana
        ? await call(entry.url, "getBalance", [solanaKey(round * 97 + i + 50000)], options.timeout)
        : await call(entry.url, "eth_getBalance", [evmAddress(round * 97 + i + 50000), "latest"], options.timeout);
      if (read.ok) stats[i].reads.push(read.ms);
      else stats[i].errors[`read_${read.category}`] = (stats[i].errors[`read_${read.category}`] ?? 0) + 1;
      return { head, at };
    }));
    // Time-aligned lag: an endpoint lags only behind heads other endpoints had
    // already reported by the time its own answer arrived (+50ms slack). A slow
    // responder is not credited for seeing a block that did not exist earlier.
    samples.forEach((sample, i) => {
      if (!sample) return;
      const seen = samples.filter((other) => other && other.at <= sample.at + 50).map((other) => other.head);
      stats[i].lags.push(Math.max(0, Math.max(...seen) - sample.head));
    });
    await sleep(250);
  }

  // Capability probes.
  await Promise.all(chain.entries.map(async (entry, i) => {
    const s = stats[i];
    if (s.identity !== "ok") return;
    const probes = {};
    await pace(entry);
    const batchId = nextId++;
    const batch = await post(entry.url, [
      { jsonrpc: "2.0", id: batchId, method: headMethod, params: headParams },
      { jsonrpc: "2.0", id: batchId + 1, method: chain.solana ? "getGenesisHash" : "eth_chainId", params: [] },
    ], options.timeout);
    nextId += 1;
    probes.batch = batch.ok && Array.isArray(batch.json) && batch.json.length === 2 && batch.json.every((x) => x && "result" in x)
      ? "yes" : batch.ok ? "no" : batch.category;
    if (!chain.solana) {
      await pace(entry);
      const head = await call(entry.url, "eth_blockNumber", [], options.timeout);
      const headNumber = head.ok ? toHead(chain, head.result) : null;
      if (headNumber !== null) {
        await pace(entry);
        const from = `0x${Math.max(0, headNumber - 50).toString(16)}`;
        const logs = await call(entry.url, "eth_getLogs", [{ fromBlock: from, toBlock: head.result }], options.timeout);
        probes.getLogs50 = logs.ok ? `yes(${logs.result.length} logs, ${Math.round(logs.ms)}ms)` : `${logs.category}: ${logs.message?.slice(0, 80)}`;
      }
      await pace(entry);
      const archive = await call(entry.url, "eth_getBalance", ["0x0000000000000000000000000000000000000000", "0x1"], options.timeout);
      probes.archiveBlock1 = archive.ok ? "yes" : `${archive.category}: ${archive.message?.slice(0, 80)}`;
    } else {
      await pace(entry);
      const hash = await call(entry.url, "getLatestBlockhash", [{ commitment: "confirmed" }], options.timeout);
      probes.getLatestBlockhash = hash.ok ? `yes(${Math.round(hash.ms)}ms)` : `${hash.category}: ${hash.message?.slice(0, 80)}`;
    }
    s.probes = probes;
  }));

  return stats.map((s) => ({
    id: s.id, provider: s.provider, url: s.url, rps: s.rps, identity: s.identity,
    successRate: s.attempts ? +(s.latencies.length / s.attempts).toFixed(2) : 0,
    p50: quantile(s.latencies, 0.5), p95: quantile(s.latencies, 0.95),
    readP50: quantile(s.reads, 0.5), readP95: quantile(s.reads, 0.95),
    avgLag: s.lags.length ? +(s.lags.reduce((a, b) => a + b, 0) / s.lags.length).toFixed(2) : null,
    maxLag: s.lags.length ? Math.max(...s.lags) : null,
    errors: s.errors, probes: s.probes ?? null,
  }));
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = "";
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; out = `1${out}`; }
  return out;
}
/** Distinct, valid 32-byte account keys so each read misses the router cache. */
const solanaKey = (n) => base58(Array.from({ length: 32 }, (_, i) => (n * 131 + i * 17 + 7) % 251 + 1));
const evmAddress = (n) => `0x${(0xbe0c000000n + BigInt(n)).toString(16).padStart(40, "0")}`;

/** Mixed reads with distinct params: cache hits are counted separately, not as latency. */
function workload(chain, n, head) {
  if (chain.solana) {
    return [
      { method: "getBalance", params: [solanaKey(n)] },
      { method: "getAccountInfo", params: [solanaKey(n + 10000), { encoding: "base64" }] },
      { method: "getLatestBlockhash", params: [{ commitment: "confirmed" }] },
      { method: "getSlot", params: [] },
    ][n % 4];
  }
  return [
    { method: "eth_getBalance", params: [evmAddress(n), "latest"] },
    { method: "eth_getTransactionCount", params: [evmAddress(n + 10000), "latest"] },
    { method: "eth_getBlockByNumber", params: [`0x${Math.max(0, head - 3 - n).toString(16)}`, false] },
    { method: "eth_blockNumber", params: [] },
  ][n % 4];
}

async function benchRouter(chain, options) {
  if (options.router === 0) return null;
  let transport;
  try { transport = chain.factory(); } catch (error) { return { error: `factory: ${error.message}` }; }
  const served = {};
  const events = { failover: 0, hedge: 0, race: 0, throttle: 0, eject: 0, quarantine: 0, restore: 0, error: 0, coalesce: 0, cache: 0 };
  const ejected = [];
  const unsubscribe = transport.onEvent?.((event) => {
    if (event.type === "success") served[event.endpoint] = (served[event.endpoint] ?? 0) + 1;
    if (event.type in events) events[event.type] += 1;
    if (event.type === "eject" || event.type === "quarantine" || event.type === "throttle") ejected.push(`${event.type}:${event.endpoint}:${event.reason ?? event.cause ?? ""}`.slice(0, 160));
  });
  let head = 0;
  if (!chain.solana) {
    try { head = Number(BigInt(await transport.request({ chainId: chain.chainId, method: "eth_blockNumber", params: [] }))); } catch {}
  }
  const latencies = [];
  let cacheFast = 0;
  const failures = {};
  let cursor = 0;
  const started = performance.now();
  const worker = async () => {
    while (cursor < options.router) {
      const n = cursor++;
      const spec = workload(chain, n, head);
      const t = performance.now();
      try {
        await transport.request({ chainId: chain.chainId, method: spec.method, params: spec.params });
        const ms = performance.now() - t;
        if (ms < 3) cacheFast += 1; else latencies.push(ms);
      } catch (error) {
        const key = `${spec.method}: ${error?.name ?? "Error"} ${String(error?.message ?? error).slice(0, 100)}`;
        failures[key] = (failures[key] ?? 0) + 1;
      }
      await sleep(100);
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  const elapsedMs = Math.round(performance.now() - started);
  const snapshot = transport.snapshot?.().map((s) => ({
    endpoint: s.endpoint ?? s.label, score: s.score !== undefined ? Math.round(s.score) : undefined,
    state: s.state ?? s.circuit, lag: s.lag, inflight: s.inflight,
  }));
  unsubscribe?.();
  transport.close?.();
  return {
    requests: options.router, succeeded: latencies.length + cacheFast, servedLocally: cacheFast,
    successRate: +((latencies.length + cacheFast) / options.router).toFixed(3),
    p50: quantile(latencies, 0.5), p95: quantile(latencies, 0.95), elapsedMs,
    servedBy: served, events, ejected, failures, snapshot,
  };
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) { process.stdout.write(HELP); return; }
  const startedAt = new Date().toISOString();
  const queue = [...options.protocols];
  const out = {};
  const worker = async () => {
    while (queue.length) {
      const name = queue.shift();
      process.stderr.write(`[bench] ${name} start\n`);
      try {
        const chain = await loadChain(name);
        const endpoints = await probeEndpoints(chain, options);
        const router = await benchRouter(chain, options);
        const healthy = endpoints.filter((e) => e.successRate >= 0.8 && e.p50 !== null);
        const bestP50 = healthy.length ? Math.min(...healthy.map((e) => e.p50)) : null;
        const readable = healthy.filter((e) => e.readP50 !== null);
        const bestRead = readable.length ? Math.min(...readable.map((e) => e.readP50)) : null;
        out[name] = {
          chainId: chain.chainId, endpointCount: endpoints.length, healthyCount: healthy.length,
          bestDirectP50: bestP50, bestDirectReadP50: bestRead,
          routerVsBestP50: router?.p50 && bestP50 ? +(router.p50 / bestP50).toFixed(2) : null,
          routerVsBestReadP50: router?.p50 && bestRead ? +(router.p50 / bestRead).toFixed(2) : null,
          endpoints, router,
        };
        process.stderr.write(`[bench] ${name} done: ${healthy.length}/${endpoints.length} healthy, router ${router?.successRate ?? "-"} p50 ${router?.p50 ?? "-"}ms vs best read ${bestRead ?? "-"}ms\n`);
      } catch (error) {
        out[name] = { error: String(error?.stack ?? error) };
        process.stderr.write(`[bench] ${name} failed: ${error.message}\n`);
      }
    }
  };
  await Promise.all(Array.from({ length: options.chains }, worker));
  process.stdout.write(`${JSON.stringify({ startedAt, completedAt: new Date().toISOString(), options, chains: out }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
});
