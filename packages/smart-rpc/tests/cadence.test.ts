import { describe, expect, test } from "vitest";

import { arbitrum } from "../src/arbitrum.js";
import { arc } from "../src/arc.js";
import { avalanche } from "../src/avalanche.js";
import { base } from "../src/base.js";
import { bsc } from "../src/bsc.js";
import { celo } from "../src/celo.js";
import { ethereum } from "../src/ethereum.js";
import { etherlink } from "../src/etherlink.js";
import { flare } from "../src/flare.js";
import { gnosis } from "../src/gnosis.js";
import { hyperevm } from "../src/hyperevm.js";
import type { RpcPool } from "../src/index.js";
import { ink } from "../src/ink.js";
import { mantle } from "../src/mantle.js";
import { monad } from "../src/monad.js";
import { opbnb } from "../src/opbnb.js";
import { optimism } from "../src/optimism.js";
import { plasma } from "../src/plasma.js";
import { polygon } from "../src/polygon.js";
import { robinhood } from "../src/robinhood.js";
import { solana } from "../src/solana.js";
import { xlayer } from "../src/xlayer.js";

type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface Factory {
  (options: {
    endpoints: readonly { url: string; weight?: number }[];
    fetchFn: FetchFn;
    verifyIdentity: false;
    race: false;
    cache: false;
    routing: "best";
    headLag: { probeInterval: false };
    now: () => number;
  }): RpcPool;
}

const evm = (create: (options: Record<string, unknown>) => RpcPool): Factory =>
  (options) => create({ ...options, pinLatest: false });

/**
 * Lag each chain tolerates before a behind endpoint stops leading head reads: about one second of blocks at the
 * block times measured on 2026-11-08, and the two-block default where no block time is set.
 */
const chains: readonly { name: string; maxLag: number; create: Factory; solana?: boolean }[] = [
  { name: "robinhood (100ms)", maxLag: 10, create: evm(robinhood) },
  { name: "base (200ms)", maxLag: 5, create: evm(base) },
  { name: "arbitrum (250ms)", maxLag: 4, create: evm(arbitrum) },
  { name: "opbnb (250ms)", maxLag: 4, create: evm(opbnb) },
  { name: "monad (300ms)", maxLag: 3, create: evm(monad) },
  { name: "bsc (450ms)", maxLag: 2, create: evm(bsc) },
  { name: "arc (500ms)", maxLag: 2, create: evm(arc) },
  { name: "avalanche (1s)", maxLag: 1, create: evm(avalanche) },
  { name: "celo (1s)", maxLag: 1, create: evm(celo) },
  { name: "ink (1s)", maxLag: 1, create: evm(ink) },
  { name: "xlayer (1s)", maxLag: 1, create: evm(xlayer) },
  { name: "hyperevm (1s)", maxLag: 1, create: evm((options) => hyperevm({ ...options, chainId: 999 })) },
  { name: "flare (1s)", maxLag: 1, create: evm(flare) },
  { name: "plasma (1s)", maxLag: 1, create: evm(plasma) },
  { name: "etherlink (1.2s)", maxLag: 1, create: evm(etherlink) },
  { name: "optimism (2s)", maxLag: 1, create: evm(optimism) },
  { name: "mantle (2s)", maxLag: 1, create: evm(mantle) },
  { name: "gnosis (explicit 2)", maxLag: 2, create: evm(gnosis) },
  { name: "polygon (default)", maxLag: 2, create: evm(polygon) },
  { name: "ethereum (default)", maxLag: 2, create: evm(ethereum) },
  { name: "solana (220ms slots)", maxLag: 5, create: (options) => solana(options), solana: true },
];

/** Which endpoint serves a head read when the preferred one (weight 100) is `behind` units behind its peer. */
async function leader(chain: (typeof chains)[number], behind: number): Promise<string | undefined> {
  const reads: string[] = [];
  const head = 1_000_000;
  const fetchFn: FetchFn = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const host = new URL(url).host;
    const body = JSON.parse(String(init?.body)) as { id: number; method: string };
    const probe = body.method === "eth_blockNumber" || body.method === "getSlot";
    const value = probe ? (host === "behind.example" ? head - behind : head) : "0x0";
    if (!probe) reads.push(host);
    const result = probe && !chain.solana ? `0x${Number(value).toString(16)}` : value;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { headers: { "content-type": "application/json" } });
  };
  const pool = chain.create({
    endpoints: [{ url: "https://behind.example/rpc", weight: 100 }, { url: "https://ahead.example/rpc" }],
    fetchFn, verifyIdentity: false, race: false, cache: false, routing: "best", headLag: { probeInterval: false },
    // A fixed clock: both heads arrive at the same instant, so time alignment does not round either one.
    now: () => 1_000,
  });
  try {
    await pool.probe();
    await pool.request(chain.solana
      ? { method: "getBalance", params: ["11111111111111111111111111111111"] }
      : { method: "eth_getBalance", params: ["0x0000000000000000000000000000000000000001", "latest"] });
    return reads[0];
  } finally {
    pool.close();
  }
}

describe.each(chains)("$name head-lag tolerance", (chain) => {
  test(`an endpoint ${chain.maxLag} behind still leads; ${chain.maxLag + 1} behind it does not`, async () => {
    expect(await leader(chain, chain.maxLag)).toBe("behind.example");
    expect(await leader(chain, chain.maxLag + 1)).toBe("ahead.example");
  });
});
