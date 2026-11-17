#!/usr/bin/env node
/** Read-only, paced A/B comparison. Each sample starts a fresh Node process and HTTP connection pool. */
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const methods = ["eth_getBalance", "eth_call", "eth_blockNumber"];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function worker(mode, method) {
  const { hyperevm } = await import("../packages/smart-rpc/dist/hyperevm.js");
  const requests = [];
  const events = [];
  const started = performance.now();
  const pool = hyperevm({
    chainId: 999,
    coldStart: mode,
    onEvent(event) {
      if (["request", "success", "error", "race", "quarantine"].includes(event.type)) {
        events.push({ ...event, atMs: performance.now() - started });
      }
    },
    async fetchFn(input, init) {
      const body = JSON.parse(String(init?.body));
      const call = { url: String(input), method: body.method, atMs: performance.now() - started };
      requests.push(call);
      const response = await fetch(input, init);
      call.headersAtMs = performance.now() - started;
      call.httpStatus = response.status;
      return response;
    },
  });
  const address = "0x0000000000000000000000000000000000000000";
  const params = method === "eth_call" ? [{ to: address, data: "0x" }, "latest"]
    : method === "eth_getBalance" ? [address, "latest"] : [];
  try {
    const result = await pool.request({ method, params });
    return { mode, method, status: "passed", elapsedMs: performance.now() - started, result, requests, events };
  } finally {
    pool.close();
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--worker") {
    if (!["weighted", "ordered"].includes(args[1]) || !methods.includes(args[2])) throw new Error("Invalid worker options.");
    console.log(JSON.stringify(await worker(args[1], args[2])));
    return;
  }
  let runs = 5;
  let method = "eth_getBalance";
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--help") {
      console.log("Usage: node scripts/benchmark-hyperevm-startup.mjs [--runs 1-20] [--method eth_getBalance|eth_call|eth_blockNumber]\nBuild first with pnpm build. Compares weighted and ordered cold routing with live read-only requests. Samples are separated by two seconds.");
      return;
    }
    const value = args[++i];
    if (flag === "--runs" && /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 20) runs = Number(value);
    else if (flag === "--method" && methods.includes(value)) method = value;
    else throw new Error(`Invalid option: ${flag} ${value ?? ""}`);
  }
  const results = [];
  const execute = promisify(execFile);
  const checkedAt = new Date().toISOString();
  for (let run = 0; run < runs; run++) {
    for (const mode of run % 2 ? ["ordered", "weighted"] : ["weighted", "ordered"]) {
      const { stdout } = await execute(process.execPath, [fileURLToPath(import.meta.url), "--worker", mode, method]);
      results.push({ run, ...JSON.parse(stdout) });
      await sleep(2000);
    }
  }
  const summary = Object.fromEntries(["weighted", "ordered"].map((mode) => {
    const times = results.filter((row) => row.mode === mode).map((row) => row.elapsedMs).sort((a, b) => a - b);
    return [mode, { samples: times.length, p50Ms: times[Math.ceil(times.length / 2) - 1], minMs: times[0], maxMs: times.at(-1) }];
  }));
  console.log(JSON.stringify({ checkedAt, completedAt: new Date().toISOString(), node: process.version, method,
    note: "Fresh process per sample; elapsed time includes construction, identity verification, budgets, and the first read, but excludes module import. One location and a small sample, not a production tail guarantee.", summary, results }, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
