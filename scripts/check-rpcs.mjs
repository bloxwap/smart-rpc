#!/usr/bin/env node
/**
 * Explicit, read-only network check of the registries in the release build.
 * Run `pnpm build` first. This script is intentionally outside the test suite.
 */

const EVM_CHAINS = {
  bsc: 56, polygon: 137, base: 8453, arbitrum: 42161, monad: 143,
  xlayer: 196, robinhood: 4663, plasma: 9745, ink: 57073, optimism: 10,
  opbnb: 204, arc: 5042, etherlink: 42793, avalanche: 43114, celo: 42220,
  gnosis: 100, mantle: 5000, flare: 14,
};
const PROTOCOLS = ["ethereum", "hyperevm", "solana", ...Object.keys(EVM_CHAINS)];

const HELP = `Usage: node scripts/check-rpcs.mjs [options]

Check each public RPC's chain identity, then its current block or slot.
No transactions are submitted. Build the workspace with pnpm build first.

Options:
  --protocol <name>   A transport subpath (default: all)
  --timeout <ms>      Deadline per HTTP request, 100–60000 (default: 10000)
  --concurrency <n>   Concurrent endpoint checks, 1–4 (default: 2)
  --help             Show this help without importing packages or making requests

JSON is written to stdout. Exit status: 0 = all checks passed, 1 = an endpoint
failed a check, 2 = invalid arguments or a missing/invalid build. A connection
failure can reflect the local network; it does not establish a provider outage.
Checks are paced per provider using the most conservative configured budget.
Where no budget is documented, this checker uses one request/second.
Supported transports: ${PROTOCOLS.join(", ")}.
`;

class CheckFailure extends Error {
  constructor(category, message, details = {}) {
    super(message);
    this.category = category;
    this.details = details;
  }
}

function parseOptions(args) {
  const options = { protocol: undefined, timeout: 10000, concurrency: 2 };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--help" || flag === "-h") return { help: true };
    if (!["--protocol", "--timeout", "--concurrency"].includes(flag)) {
      throw new Error(`Unknown argument: ${flag}`);
    }
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
    if (flag === "--protocol") {
      if (!PROTOCOLS.includes(value)) {
        throw new Error(`--protocol must be one of: ${PROTOCOLS.join(", ")}.`);
      }
      options.protocol = value;
    } else {
      const key = flag.slice(2);
      const number = Number(value);
      const [minimum, maximum] = key === "timeout" ? [100, 60000] : [1, 4];
      if (!/^\d+$/.test(value) || !Number.isInteger(number) || number < minimum || number > maximum) {
        throw new Error(`${flag} must be an integer from ${minimum} to ${maximum}.`);
      }
      options[key] = number;
    }
  }
  return options;
}

async function loadRegistries(protocol) {
  const groups = [];
  if (!protocol || protocol === "ethereum") {
    const ethereum = await import("../packages/smart-rpc/dist/ethereum.js");
    groups.push({
      protocol: "ethereum", network: "mainnet", chainId: "eip155:1", identity: 1,
      entries: ethereum.ETHEREUM_MAINNET_REGISTRY,
    });
  }
  if (!protocol || protocol === "hyperevm") {
    const hyperevm = await import("../packages/smart-rpc/dist/hyperevm.js");
    groups.push(
      {
        protocol: "hyperevm", network: "mainnet", chainId: "eip155:999", identity: 999,
        entries: hyperevm.HYPEREVM_MAINNET_REGISTRY,
      },
      {
        protocol: "hyperevm", network: "testnet", chainId: "eip155:998", identity: 998,
        entries: hyperevm.HYPEREVM_TESTNET_REGISTRY,
      },
    );
  }
  if (!protocol || protocol === "solana") {
    const solana = await import("../packages/smart-rpc/dist/solana.js");
    groups.push(...["mainnet", "devnet", "testnet"].map((network) => ({
      protocol: "solana", network, chainId: `solana:${network}`,
      identity: solana[`${network.toUpperCase()}_GENESIS_HASH`],
      entries: solana[`${network.toUpperCase()}_REGISTRY`],
    })));
  }
  for (const [name, identity] of Object.entries(EVM_CHAINS)) {
    if (protocol && protocol !== name) continue;
    const transport = await import(`../packages/smart-rpc/dist/${name}.js`);
    groups.push({
      protocol: name, network: "mainnet", chainId: `eip155:${identity}`, identity,
      entries: transport[`${name.toUpperCase()}_MAINNET_REGISTRY`],
    });
    if (name === "celo") {
      groups.push({
        protocol: name, network: "sepolia", chainId: "eip155:11142220", identity: 11142220,
        entries: transport.CELO_SEPOLIA_REGISTRY,
      });
    }
  }
  for (const group of groups) {
    if (!Array.isArray(group.entries) || group.entries.length === 0 || group.identity === undefined) {
      throw new Error(`Missing ${group.protocol} ${group.network} registry or identity export. Run pnpm build.`);
    }
    for (const entry of group.entries) {
      if (!entry || typeof entry.url !== "string" || new URL(entry.url).protocol !== "https:" ||
          typeof entry.provider !== "string" || entry.provider.length === 0 ||
          (entry.rps !== undefined && (!Number.isFinite(entry.rps) || entry.rps <= 0))) {
        throw new Error(`Invalid registry entry in ${group.protocol} ${group.network}.`);
      }
    }
  }
  return groups;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Pace requests across all networks belonging to a provider; do not spend bursts. */
function providerPacer(groups) {
  const providers = new Map();
  for (const group of groups) {
    for (const entry of group.entries) {
      const key = entry.providerGroup ?? entry.provider;
      const current = providers.get(key);
      providers.set(key, {
        interval: Math.max(current?.interval ?? 0, Math.ceil(1000 / Math.min(entry.rps ?? 1, entry.providerBudget?.rps ?? Infinity))),
        next: 0,
      });
    }
  }
  return async (entry) => {
    const provider = providers.get(entry.providerGroup ?? entry.provider);
    const now = performance.now();
    const reserved = Math.max(now, provider.next);
    provider.next = reserved + provider.interval;
    const delay = reserved - now;
    if (delay > 0) await sleep(delay);
  };
}

/** Identity and head responses should be tiny; also bound the body while reading. */
async function readBody(response) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let length = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return text + decoder.decode();
      length += chunk.value.byteLength;
      if (length > 65536) {
        await reader.cancel();
        throw new CheckFailure("malformed_response", "RPC response exceeded 64 KiB.");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

function rpcErrorCategory(error) {
  if (/rate.?limit|too many requests|quota|capacity|credits? exceeded/i.test(error.message) || error.code === -32005) {
    return "rate_limited";
  }
  if (/unauthori[sz]ed|forbidden|authentication|invalid api.?key|api.?key required|missing api.?key/i.test(error.message)) {
    return "authentication_required";
  }
  return "rpc_error";
}

let nextRequestId = 1;
async function request(url, method, params, timeout) {
  const id = nextRequestId++;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal: controller.signal,
      redirect: "error",
    });
    if (!response.ok) {
      const category = response.status === 429 ? "rate_limited"
        : response.status === 401 ? "authentication_required"
          : response.status === 403 ? "access_denied" : "http_error";
      await response.body?.cancel();
      throw new CheckFailure(category, `HTTP ${response.status} ${response.statusText}`.trim(), {
        httpStatus: response.status,
        ...(response.headers.has("retry-after") ? { retryAfter: response.headers.get("retry-after") } : {}),
      });
    }
    let body;
    try {
      body = JSON.parse(await readBody(response));
    } catch (error) {
      if (error instanceof SyntaxError) throw new CheckFailure("malformed_response", "Response was not JSON.");
      throw error;
    }
    if (body === null || typeof body !== "object" || Array.isArray(body) || body.jsonrpc !== "2.0" ||
        body.id !== id || Object.hasOwn(body, "result") === Object.hasOwn(body, "error")) {
      throw new CheckFailure("malformed_response", "Response was not a matching JSON-RPC 2.0 result or error.");
    }
    if (Object.hasOwn(body, "error")) {
      const error = body.error;
      if (!error || !Number.isInteger(error.code) || typeof error.message !== "string") {
        throw new CheckFailure("malformed_response", "Response contained an invalid JSON-RPC error.");
      }
      throw new CheckFailure(rpcErrorCategory(error), error.message.slice(0, 500), { rpcCode: error.code });
    }
    return body.result;
  } catch (error) {
    if (error instanceof CheckFailure) throw error;
    if (controller.signal.aborted) throw new CheckFailure("timeout", `Request exceeded ${timeout} ms.`);
    throw new CheckFailure("network_error", error instanceof Error ? error.message : String(error), {
      ...(error?.cause?.code ? { networkCode: error.cause.code } : {}),
    });
  } finally {
    clearTimeout(timer);
  }
}

function hexQuantity(value) {
  return typeof value === "string" && /^0x[\da-f]+$/i.test(value) ? BigInt(value) : undefined;
}

async function checkEndpoint(group, entry, options, pace) {
  const started = performance.now();
  const isSolana = group.protocol === "solana";
  const checks = [];
  const methods = [
    { method: isSolana ? "getGenesisHash" : "eth_chainId", params: [] },
    { method: isSolana ? "getSlot" : "eth_blockNumber", params: isSolana ? [{ commitment: "processed" }] : [] },
  ];
  for (const [index, spec] of methods.entries()) {
    await pace(entry);
    const requestStarted = performance.now();
    try {
      const result = await request(entry.url, spec.method, spec.params, options.timeout);
      if (index === 0) {
        const identity = isSolana ? result : hexQuantity(result);
        if (identity === undefined || (isSolana && (typeof identity !== "string" || identity.length === 0))) {
          throw new CheckFailure("malformed_response", "RPC returned an invalid chain identity.");
        }
        if (identity !== (isSolana ? group.identity : BigInt(group.identity))) {
          throw new CheckFailure("chain_mismatch", "RPC returned another chain's identity.", {
            expectedIdentity: group.identity, reportedIdentity: result,
          });
        }
      } else if (isSolana ? !Number.isSafeInteger(result) || result < 0 : hexQuantity(result) === undefined) {
        throw new CheckFailure("malformed_response", "RPC returned an invalid block or slot.");
      }
      checks.push({ method: spec.method, status: "passed", result, durationMs: Math.round(performance.now() - requestStarted) });
    } catch (error) {
      checks.push({
        method: spec.method, status: "failed", category: error.category ?? "network_error",
        message: error.message, ...error.details, durationMs: Math.round(performance.now() - requestStarted),
      });
      break;
    }
  }
  return {
    protocol: group.protocol, network: group.network, chainId: group.chainId,
    id: entry.id, url: entry.url, provider: entry.provider,
    sourceUrls: entry.sourceUrls, reviewedAt: entry.reviewedAt,
    budget: { rps: entry.rps, burst: entry.burst },
    status: checks.length === 2 && checks.every((check) => check.status === "passed") ? "passed" : "failed",
    checks, durationMs: Math.round(performance.now() - started),
  };
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  const groups = await loadRegistries(options.protocol);
  const checkedAt = new Date().toISOString();
  const pace = providerPacer(groups);
  const queue = groups.flatMap((group) => group.entries.map((entry) => ({ group, entry })));
  const results = new Array(queue.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < queue.length) {
      const index = cursor++;
      const { group, entry } = queue[index];
      results[index] = await checkEndpoint(group, entry, options, pace);
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.concurrency, queue.length) }, worker));
  const passed = results.filter((result) => result.status === "passed").length;
  process.stdout.write(`${JSON.stringify({
    checkedAt, completedAt: new Date().toISOString(),
    scope: "chain-identity-and-head", protocol: options.protocol ?? "all",
    note: "A passing check confirms these methods at this time only. Network errors may be local; provider availability and limits can change.",
    timeoutMs: options.timeout, concurrency: options.concurrency,
    total: results.length, passed, failed: results.length - passed, results,
  }, null, 2)}\n`);
  process.exitCode = passed === results.length ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  if (error?.code === "ERR_MODULE_NOT_FOUND") process.stderr.write("Run pnpm install and pnpm build before checking RPCs.\n");
  process.exitCode = 2;
});
