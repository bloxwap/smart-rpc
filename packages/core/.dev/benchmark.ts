import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";

import { evmCachePlan, evmCachePolicy, LogIndex, planLogQuery, ReadCache, resolveCache } from "../src/index.ts";
import type { RollingLogQueryPlan } from "../src/index.ts";

const HELP = `Usage: pnpm benchmark:core [--scenario cache|logs|plan] [--threads 1,2,4] [options]

Measure independent core operations in Node worker threads. Worker startup,
state construction, and warmup are excluded from the measured interval.

Options:
  --scenario <name>   cache, logs, or plan (default: cache)
  --threads <list>    Comma-separated worker counts (default: 1,2,4)
  --iterations <n>    Measured operations per worker (default: 200000; logs: 2000)
  --warmup <n>        Warmup operations per worker (default: 5% of iterations)
  --json              Print machine-readable results
  --help              Show this help
`;

type Scenario = "cache" | "logs" | "plan";

interface Options {
  scenario: Scenario;
  threads: number[];
  iterations: number;
  warmup: number;
  json: boolean;
  help: boolean;
}

interface Work {
  scenario: Scenario;
  iterations: number;
  warmup: number;
  workerIndex: number;
}

interface WorkerResult {
  workerIndex: number;
  iterations: number;
  elapsedMs: number;
  checksum: number;
}

interface RunResult {
  scenario: Scenario;
  threads: number;
  iterationsPerWorker: number;
  elapsedMs: number;
  operationsPerSecond: number;
  speedup: number;
  workers: Array<WorkerResult & { operationsPerSecond: number }>;
}

type WorkerMessage =
  | { type: "ready"; workerIndex: number }
  | { type: "result"; result: WorkerResult };

function positiveInteger(value: string, flag: string, allowZero = false): number {
  if (!/^\d+$/.test(value)) throw new Error(`${flag} must be an integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < (allowZero ? 0 : 1) || parsed > 100_000_000) {
    throw new Error(`${flag} must be from ${allowZero ? 0 : 1} to 100000000.`);
  }
  return parsed;
}

function parseOptions(args: readonly string[]): Options {
  const options: Options = {
    scenario: "cache",
    threads: [1, 2, 4].filter((count) => count <= availableParallelism()),
    iterations: 0,
    warmup: -1,
    json: false,
    help: false,
  };
  if (options.threads.length === 0) options.threads = [1];
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--") continue;
    if (flag === "--help" || flag === "-h") return { ...options, help: true };
    if (flag === "--json") {
      options.json = true;
      continue;
    }
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
    if (flag === "--scenario") {
      if (value !== "cache" && value !== "logs" && value !== "plan") {
        throw new Error("--scenario must be cache, logs, or plan.");
      }
      options.scenario = value;
    } else if (flag === "--threads") {
      const threads = value.split(",").map((count) => positiveInteger(count, "--threads"));
      if (threads.some((count) => count > 64) || new Set(threads).size !== threads.length) {
        throw new Error("--threads must contain unique worker counts no greater than 64.");
      }
      options.threads = threads;
    } else if (flag === "--iterations") options.iterations = positiveInteger(value, flag);
    else if (flag === "--warmup") options.warmup = positiveInteger(value, flag, true);
    else throw new Error(`Unknown argument: ${flag}`);
  }
  if (options.iterations === 0) options.iterations = options.scenario === "logs" ? 2_000 : 200_000;
  if (options.warmup < 0) options.warmup = Math.floor(options.iterations * 0.05);
  return options;
}

function cacheWorkload(): (iterations: number) => number {
  const cache = new ReadCache(resolveCache({ refreshInterval: false }), evmCachePolicy());
  const params = [{ to: "0x000000000000000000000000000000000000dead", data: "0x" }, "latest"];
  const context = { now: 1_000, head: { block: 100, ageMs: 0 } };
  const initial = cache.lookup("eth_call", params, true, context);
  if (!initial || initial.hit) throw new Error("Expected the initial cache lookup to miss.");
  initial.fill(`0x${"11".repeat(32)}`, 100);
  return (iterations) => {
    let checksum = 0;
    for (let index = 0; index < iterations; index += 1) {
      const lookup = cache.lookup("eth_call", params, true, context);
      if (!lookup?.hit || typeof lookup.result !== "string") throw new Error("Expected a cache hit.");
      checksum += lookup.result.length;
    }
    return checksum;
  };
}

function logsWorkload(): (iterations: number) => number {
  const index = new LogIndex();
  const params = [{
    address: "0x000000000000000000000000000000000000dead",
    fromBlock: "0x0",
    toBlock: "0x3e7",
  }];
  const plan = planLogQuery(params);
  if (plan?.kind !== "rolling") throw new Error("Expected a rolling log plan.");
  const initial = index.lookup(plan, { head: 999, now: 0 });
  if (!initial || initial.hit) throw new Error("Expected the initial log lookup to miss.");
  const logs = Array.from({ length: 1_000 }, (_, block) => ({
    address: "0x000000000000000000000000000000000000dead",
    blockNumber: `0x${block.toString(16)}`,
    logIndex: "0x0",
    topics: [],
    data: "0x",
  }));
  if (!initial.fetch.fill(logs, 0)) throw new Error("Expected the log seed to fill.");
  return (iterations) => {
    let checksum = 0;
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      const lookup = index.lookup(plan as RollingLogQueryPlan, { head: 999, now: 0 });
      if (!lookup?.hit) throw new Error("Expected a log index hit.");
      checksum += lookup.result.length;
    }
    return checksum;
  };
}

function planWorkload(): (iterations: number) => number {
  const params = [{ to: "0x000000000000000000000000000000000000dead", data: "0x" }, "latest"];
  return (iterations) => {
    let checksum = 0;
    for (let index = 0; index < iterations; index += 1) {
      const plan = evmCachePlan("eth_call", params);
      if (!plan) throw new Error("Expected a cache plan.");
      checksum += plan.key.length;
    }
    return checksum;
  };
}

function prepare(work: Work): () => WorkerResult {
  const workload = work.scenario === "cache" ? cacheWorkload() : work.scenario === "logs" ? logsWorkload() : planWorkload();
  workload(work.warmup);
  return () => {
    const started = performance.now();
    const checksum = workload(work.iterations);
    return {
      workerIndex: work.workerIndex,
      iterations: work.iterations,
      elapsedMs: performance.now() - started,
      checksum,
    };
  };
}

async function runThreads(options: Options, threads: number): Promise<Omit<RunResult, "speedup">> {
  const workers = Array.from({ length: threads }, (_, workerIndex) => new Worker(fileURLToPath(import.meta.url), {
    workerData: {
      scenario: options.scenario,
      iterations: options.iterations,
      warmup: options.warmup,
      workerIndex,
    } satisfies Work,
  }));
  try {
    const { results, elapsedMs } = await new Promise<{ results: WorkerResult[]; elapsedMs: number }>((resolve, reject) => {
      const completed: WorkerResult[] = [];
      let ready = 0;
      let started = 0;
      for (const worker of workers) {
        worker.on("message", (message: WorkerMessage) => {
          if (message.type === "ready") {
            ready += 1;
            if (ready === workers.length) {
              started = performance.now();
              for (const item of workers) item.postMessage({ type: "start" });
            }
            return;
          }
          completed.push(message.result);
          if (completed.length === workers.length) {
            resolve({ results: completed, elapsedMs: performance.now() - started });
          }
        });
        worker.once("error", reject);
        worker.once("exit", (code) => {
          if (code !== 0 && completed.length < workers.length) reject(new Error(`Benchmark worker exited with code ${code}.`));
        });
      }
    });
    results.sort((left, right) => left.workerIndex - right.workerIndex);
    if (new Set(results.map((result) => result.checksum)).size !== 1) {
      throw new Error("Workers produced inconsistent results.");
    }
    return {
      scenario: options.scenario,
      threads,
      iterationsPerWorker: options.iterations,
      elapsedMs,
      operationsPerSecond: options.iterations * threads / elapsedMs * 1_000,
      workers: results.map((result) => ({
        ...result,
        operationsPerSecond: result.iterations / result.elapsedMs * 1_000,
      })),
    };
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()));
  }
}

function printResults(options: Options, results: RunResult[]): void {
  if (options.json) {
    console.log(JSON.stringify({ warmupPerWorker: options.warmup, results }, null, 2));
    return;
  }
  console.log(`${options.scenario}: ${options.iterations.toLocaleString()} measured operations per worker; ${options.warmup.toLocaleString()} warmup`);
  console.log("threads       ops/s  speedup   elapsed ms  worker ops/s (min-max)");
  for (const result of results) {
    const rates = result.workers.map((worker) => worker.operationsPerSecond);
    const minimum = Math.min(...rates);
    const maximum = Math.max(...rates);
    console.log(
      `${String(result.threads).padStart(7)} ${Math.round(result.operationsPerSecond).toLocaleString().padStart(11)} ${result.speedup.toFixed(2).padStart(7)}x ${result.elapsedMs.toFixed(1).padStart(12)}  ${Math.round(minimum).toLocaleString()}-${Math.round(maximum).toLocaleString()}`,
    );
  }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  const results: RunResult[] = [];
  let baseline = 0;
  for (const threads of options.threads) {
    const result = await runThreads(options, threads);
    if (baseline === 0) baseline = result.operationsPerSecond;
    results.push({ ...result, speedup: result.operationsPerSecond / baseline });
  }
  printResults(options, results);
}

if (!isMainThread) {
  const work = workerData as Work;
  const measure = prepare(work);
  parentPort?.postMessage({ type: "ready", workerIndex: work.workerIndex } satisfies WorkerMessage);
  parentPort?.once("message", () => {
    parentPort?.postMessage({ type: "result", result: measure() } satisfies WorkerMessage);
  });
} else {
  await main();
}
