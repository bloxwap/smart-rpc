import { expect, test } from "vitest";
import { etherlink, ETHERLINK_CHAIN_ID, ETHERLINK_RPC_URL } from "../src/index.js";

const publicChecks = process.env.SMART_RPC_LIVE_ETHERLINK === "1";
const idle = { probeInterval: false } as const;
const address = "0x0000000000000000000000000000000000000000";

test.skipIf(!publicChecks)("public Etherlink identity and current full-block head", async () => {
  const pool = etherlink({ headLag: idle, race: false, timeout: 10_000 });
  try {
    expect(Number(await pool.request({ method: "eth_chainId" }))).toBe(ETHERLINK_CHAIN_ID);
    expect(await pool.request({ method: "eth_blockNumber" })).toMatch(/^0x[\da-f]+$/i);
  } finally { pool.close(); }
}, 25_000);

test.skipIf(!publicChecks)("public Etherlink accepts a bounded numeric log filter", async () => {
  const pool = etherlink({ headLag: idle, race: false, timeout: 10_000 });
  try {
    const head = BigInt(String(await pool.request({ method: "eth_blockNumber" })));
    // A one-block query with a zero address avoids broad production traffic.
    const block = `0x${head.toString(16)}`;
    expect(await pool.request({ method: "eth_getLogs", params: [{ address, fromBlock: block, toBlock: block }] })).toEqual(expect.any(Array));
  } finally { pool.close(); }
}, 25_000);

const archiveUrl = process.env.ETHERLINK_ARCHIVE_RPC_URL;
const archiveBlock = process.env.ETHERLINK_ARCHIVE_BLOCK;
test.skipIf(!archiveUrl || !archiveBlock)("configured archive provider serves the requested historical state", async () => {
  const pool = etherlink({ endpoints: [{ url: archiveUrl!, capabilities: { archive: true } }], headLag: idle, race: false });
  try {
    expect(await pool.request({ method: "eth_getBalance", params: [address, archiveBlock!] })).toMatch(/^0x[\da-f]+$/i);
  } finally { pool.close(); }
}, 25_000);

const tags = process.env.ETHERLINK_FINALITY_TEST === "1";
test.skipIf(!tags)("explicitly opted-in provider preserves safe and finalized block tags", async () => {
  const pool = etherlink({ endpoints: [{ url: process.env.ETHERLINK_RPC_URL ?? ETHERLINK_RPC_URL, capabilities: { blockTags: ["latest", "safe", "finalized"] } }], headLag: idle, race: false });
  try {
    for (const tag of ["safe", "finalized"]) {
      const block = await pool.request({ method: "eth_getBlockByNumber", params: [tag, false] });
      expect(block).toMatchObject({ number: expect.stringMatching(/^0x[\da-f]+$/i) });
    }
  } finally { pool.close(); }
}, 30_000);

const wsUrl = process.env.ETHERLINK_WS_RPC_URL;
test.skipIf(!wsUrl)("configured dedicated WebSocket URL serves EVM requests", async () => {
  const pool = etherlink({ endpoints: [wsUrl!], headLag: idle, race: false });
  try {
    expect(Number(await pool.request({ method: "eth_chainId" }))).toBe(ETHERLINK_CHAIN_ID);
    expect(await pool.request({ method: "eth_blockNumber" })).toMatch(/^0x[\da-f]+$/i);
  } finally { pool.close(); }
}, 25_000);
