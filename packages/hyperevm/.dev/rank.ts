import { readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { HYPEREVM_MAINNET_REGISTRY } from "../src/registry.ts";
import {
  assertMainnetRegistryFile,
  assertObservationDocument,
  assertRegistryHistoryFile,
  refreshMainnetRegistry,
  type MainnetRegistryFile,
  type RegistryHistoryFile,
} from "../src/registry/data.ts";
import type { ProbeObservation } from "../src/registry/policy.ts";
import { assignLags, mapPool, probeEndpoint } from "./probe.ts";

const REGISTRY_PATH = new URL("../registry/mainnet.json", import.meta.url);
const HISTORY_PATH = new URL("../registry/history.json", import.meta.url);
const HELP = `Usage: pnpm rank:hyperevm [--dry-run] [--fixtures <json>] [--now <ISO date>]

Refresh HyperEVM mainnet rankings from rolling probe history. Live mode is
explicit and read-only. Fixture mode replays a version-1 observation document;
its latest observation supplies --now when that option is omitted.

Options:
  --dry-run          Print rankings without writing registry data
  --fixtures <path>  Read observations instead of making network requests
  --now <ISO date>   Ranking time, useful for deterministic fixture replay
  --timeout <ms>     Deadline per request, 100-60000 (default: 8000)
  --concurrency <n>  Concurrent endpoints, 1-4 (default: 2)
  --help             Show this help
`;

interface Options {
  dryRun: boolean;
  fixtures?: string;
  now?: number;
  timeoutMs: number;
  concurrency: number;
  help: boolean;
}

function parseOptions(args: readonly string[]): Options {
  const options: Options = { dryRun: false, timeoutMs: 8_000, concurrency: 2, help: false };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--") continue;
    if (flag === "--help" || flag === "-h") return { ...options, help: true };
    if (flag === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
    if (flag === "--fixtures") options.fixtures = resolve(process.env.INIT_CWD ?? process.cwd(), value);
    else if (flag === "--now") {
      options.now = Date.parse(value);
      if (!Number.isFinite(options.now)) throw new Error("--now must be a valid ISO date.");
    } else if (flag === "--timeout" || flag === "--concurrency") {
      if (!/^\d+$/.test(value)) throw new Error(`${flag} must be an integer.`);
      const number = Number(value);
      const [minimum, maximum] = flag === "--timeout" ? [100, 60_000] : [1, 4];
      if (number < minimum || number > maximum) throw new Error(`${flag} must be from ${minimum} to ${maximum}.`);
      if (flag === "--timeout") options.timeoutMs = number;
      else options.concurrency = number;
    } else throw new Error(`Unknown argument: ${flag}`);
  }
  return options;
}

async function readJson(path: URL | string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function readPrevious(): Promise<{ registry: MainnetRegistryFile; history: RegistryHistoryFile }> {
  const registry = await readJson(REGISTRY_PATH);
  const history = await readJson(HISTORY_PATH);
  assertMainnetRegistryFile(registry);
  assertRegistryHistoryFile(history);
  return { registry, history };
}

const sleep = (ms: number) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

/** Do not spend endpoint bursts during maintenance probes. */
function endpointPacer(rps: number): () => Promise<void> {
  const interval = Math.ceil(1_000 / rps);
  let next = 0;
  return async () => {
    const now = performance.now();
    const reserved = Math.max(now, next);
    next = reserved + interval;
    if (reserved > now) await sleep(reserved - now);
  };
}

async function liveObservations(options: Options): Promise<ProbeObservation[]> {
  const probed = await mapPool(HYPEREVM_MAINNET_REGISTRY, options.concurrency, async (endpoint) =>
    probeEndpoint(endpoint.url, {
      timeoutMs: options.timeoutMs,
      beforeRequest: endpointPacer(endpoint.rps),
    }),
  );
  return assignLags(probed);
}

function printTable(rows: MainnetRegistryFile["endpoints"]): void {
  for (const endpoint of rows) {
    const latency = endpoint.stats?.latencyMs ?? "-";
    const uptime = endpoint.stats ? `${Math.round(endpoint.stats.uptime * 100)}%` : "-";
    const core = endpoint.stats?.precompileOk === true ? "core" : endpoint.stats?.precompileOk === false ? "NO-CORE" : "-";
    console.log(
      `${String(endpoint.rank ?? "-").padStart(3)}  w=${endpoint.weight.toFixed(4)}  ${uptime.padStart(4)}  ${String(latency).padStart(8)}ms  ${core.padEnd(7)}  ${endpoint.url}`,
    );
  }
}

async function writeOutputs(registry: MainnetRegistryFile, history: RegistryHistoryFile): Promise<void> {
  const registryTemp = new URL("mainnet.json.tmp", REGISTRY_PATH);
  const historyTemp = new URL("history.json.tmp", HISTORY_PATH);
  await Promise.all([
    writeFile(registryTemp, `${JSON.stringify(registry, null, 2)}\n`),
    writeFile(historyTemp, `${JSON.stringify(history, null, 2)}\n`),
  ]);
  await Promise.all([rename(registryTemp, REGISTRY_PATH), rename(historyTemp, HISTORY_PATH)]);
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  const { registry: previous, history } = await readPrevious();
  let current: ProbeObservation[];
  if (options.fixtures) {
    const fixture = await readJson(options.fixtures);
    assertObservationDocument(fixture);
    current = fixture.observations;
  } else {
    console.log(`Probing ${HYPEREVM_MAINNET_REGISTRY.length} HyperEVM mainnet endpoints.`);
    current = await liveObservations(options);
  }
  const latestFixture = options.fixtures && current.length > 0
    ? Math.max(...current.map((observation) => Date.parse(observation.at)))
    : undefined;
  const nowMs = options.now ?? latestFixture ?? Date.now();
  if (!Number.isFinite(nowMs)) throw new Error("Could not determine a finite ranking time.");
  const next = refreshMainnetRegistry(HYPEREVM_MAINNET_REGISTRY, previous, history, current, nowMs);
  printTable(next.registry.endpoints);
  if (options.dryRun) {
    console.log("Dry run. Registry files were not written.");
    return;
  }
  await writeOutputs(next.registry, next.history);
  console.log(`Wrote ${next.registry.endpoints.length} rows and ${next.history.observations.length} rolling observations.`);
}

await main();
