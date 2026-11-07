import { describe, expect, test } from "vitest";

import { ETHEREUM_MAINNET_REGISTRY, ethereum } from "../src/ethereum.js";
import {
  HYPEREVM_MAINNET_REGISTRY,
  HYPEREVM_TESTNET_REGISTRY,
  hyperevm,
} from "../src/hyperevm.js";
import { createSmartRpc, type RpcEvent, type SmartRpcTransport } from "../src/index.js";
import {
  DEVNET_GENESIS_HASH,
  DEVNET_REGISTRY,
  MAINNET_GENESIS_HASH,
  MAINNET_REGISTRY,
  TESTNET_GENESIS_HASH,
  TESTNET_REGISTRY,
  solana,
} from "../src/solana.js";

type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface Call {
  url: string;
  id: unknown;
  method: string;
}

const canonical = (url: string): string => new URL(url).href;

function stubFetch(handler: (call: Call) => Response, calls: Call[]): FetchFn {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = JSON.parse(String(init?.body)) as { id: unknown; method: string };
    const call = { url: canonical(url), id: body.id, method: body.method };
    calls.push(call);
    return handler(call);
  };
}

function result(call: Call, value: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id: call.id, result: value });
}

const deterministic = {
  routing: "best" as const,
  race: false,
  cache: false,
  headLag: { probeInterval: false as const },
};

interface TransportCase {
  name: string;
  chainId: string;
  identityMethod: string;
  identity: string;
  wrongIdentity: string;
  readMethod: string;
  readResult: string | number;
  registry: readonly { url: string }[];
  create: (fetchFn: FetchFn, onEvent?: (event: RpcEvent) => void, endpoints?: readonly string[]) => SmartRpcTransport;
}

const mainnets: readonly TransportCase[] = [
  {
    name: "Ethereum",
    chainId: "eip155:1",
    identityMethod: "eth_chainId",
    identity: "0x1",
    wrongIdentity: "0x3e7",
    readMethod: "eth_blockNumber",
    readResult: "0x1234",
    registry: ETHEREUM_MAINNET_REGISTRY,
    create: (fetchFn, onEvent, endpoints) => ethereum({ ...deterministic, fetchFn, onEvent, endpoints, budget: false }),
  },
  {
    name: "HyperEVM",
    chainId: "eip155:999",
    identityMethod: "eth_chainId",
    identity: "0x3e7",
    wrongIdentity: "0x1",
    readMethod: "eth_blockNumber",
    readResult: "0x1234",
    registry: HYPEREVM_MAINNET_REGISTRY,
    create: (fetchFn, onEvent, endpoints) => hyperevm({ ...deterministic, chainId: 999, fetchFn, onEvent, endpoints, budget: false }),
  },
  {
    name: "Solana",
    chainId: "solana:mainnet",
    identityMethod: "getGenesisHash",
    identity: MAINNET_GENESIS_HASH,
    wrongIdentity: DEVNET_GENESIS_HASH,
    readMethod: "getSlot",
    readResult: 1234,
    registry: MAINNET_REGISTRY,
    create: (fetchFn, onEvent, endpoints) => solana({ ...deterministic, fetchFn, onEvent, endpoints, budget: false }),
  },
];

describe.each(mainnets)("$name public defaults through the published subpath", (network) => {
  test.each([429, 503])("fails over an HTTP %i response to another public provider", async (status) => {
    const calls: Call[] = [];
    const events: RpcEvent[] = [];
    let unavailable: string | undefined;
    const fetchFn = stubFetch((call) => {
      if (call.method === network.identityMethod) return result(call, network.identity);
      unavailable ??= call.url;
      if (call.url === unavailable) {
        return new Response("Provider unavailable", {
          status,
          headers: { "retry-after": "30" },
        });
      }
      return result(call, network.readResult);
    }, calls);
    const transport = network.create(fetchFn, (event) => events.push(event));
    try {
      await expect(transport.request({ chainId: network.chainId, method: network.readMethod, params: [] }))
        .resolves.toBe(network.readResult);
      const reads = calls.filter((call) => call.method === network.readMethod);
      expect(reads).toHaveLength(2);
      expect(reads[0]?.url).not.toBe(reads[1]?.url);
      const publicUrls = new Set(network.registry.map((entry) => canonical(entry.url)));
      expect(reads.every((call) => publicUrls.has(call.url))).toBe(true);
      expect(events.some((event) => event.type === "failover" && event.method === network.readMethod)).toBe(true);
      expect(transport.snapshot?.().find((row) => canonical(row.url) === unavailable)?.ejected).toBe(true);
      expect(events.some((event) => event.type === "eject" && event.cooldownMs >= 29_000)).toBe(true);
    } finally {
      transport.close?.();
    }
  });

  test("quarantines a wrong-network default before sending it application reads", async () => {
    const calls: Call[] = [];
    let wrongNetwork: string | undefined;
    const fetchFn = stubFetch((call) => {
      if (call.method === network.identityMethod) {
        wrongNetwork ??= call.url;
        return result(call, call.url === wrongNetwork ? network.wrongIdentity : network.identity);
      }
      return result(call, network.readResult);
    }, calls);
    const transport = network.create(fetchFn);
    try {
      await expect(transport.request({ chainId: network.chainId, method: network.readMethod, params: [] }))
        .resolves.toBe(network.readResult);
      await expect(transport.request({ chainId: network.chainId, method: network.readMethod, params: [] }))
        .resolves.toBe(network.readResult);
      expect(calls.filter((call) => call.url === wrongNetwork).map((call) => call.method))
        .toEqual([network.identityMethod]);
      expect(transport.snapshot?.().find((row) => canonical(row.url) === wrongNetwork)?.quarantined).toBe(true);
    } finally {
      transport.close?.();
    }
  });

  test("an explicit endpoint replaces the public registry", async () => {
    const calls: Call[] = [];
    const customUrl = "https://private.example/rpc";
    const fetchFn = stubFetch((call) => result(call,
      call.method === network.identityMethod ? network.identity : network.readResult,
    ), calls);
    const transport = network.create(fetchFn, undefined, [customUrl]);
    try {
      await expect(transport.request({ chainId: network.chainId, method: network.readMethod, params: [] }))
        .resolves.toBe(network.readResult);
      expect(new Set(calls.map((call) => call.url))).toEqual(new Set([canonical(customUrl)]));
      expect(transport.snapshot?.().map((row) => row.url)).toEqual([customUrl]);
    } finally {
      transport.close?.();
    }
  });
});

describe("public registry composition", () => {
  test("all default networks retain separate endpoint pools and identity checks", async () => {
    const networks = [
      ...mainnets,
      {
        chainId: "eip155:998",
        registry: HYPEREVM_TESTNET_REGISTRY,
        identityMethod: "eth_chainId",
        identity: "0x3e6",
        readMethod: "eth_blockNumber",
        readResult: "0x1234",
      },
      {
        chainId: "solana:devnet",
        registry: DEVNET_REGISTRY,
        identityMethod: "getGenesisHash",
        identity: DEVNET_GENESIS_HASH,
        readMethod: "getSlot",
        readResult: 1234,
      },
      {
        chainId: "solana:testnet",
        registry: TESTNET_REGISTRY,
        identityMethod: "getGenesisHash",
        identity: TESTNET_GENESIS_HASH,
        readMethod: "getSlot",
        readResult: 1234,
      },
    ];
    const byUrl = new Map(networks.flatMap((network) =>
      network.registry.map((entry) => [canonical(entry.url), network] as const),
    ));
    const calls: Call[] = [];
    const fetchFn = stubFetch((call) => {
      const network = byUrl.get(call.url);
      if (!network) throw new Error(`Unregistered default RPC: ${call.url}`);
      return result(call, call.method === network.identityMethod ? network.identity : network.readResult);
    }, calls);
    const options = { ...deterministic, fetchFn };
    const rpc = createSmartRpc({
      transports: [
        ethereum(options),
        hyperevm(options),
        solana(options),
        solana({ ...options, cluster: "devnet" }),
        solana({ ...options, cluster: "testnet" }),
      ],
    });
    try {
      for (const network of networks) {
        calls.length = 0;
        await expect(rpc.request({ chainId: network.chainId, method: network.readMethod, params: [] }))
          .resolves.toBe(network.readResult);
        expect(calls.map((call) => call.method)).toEqual([network.identityMethod, network.readMethod]);
        const allowed = new Set(network.registry.map((entry) => canonical(entry.url)));
        expect(calls.every((call) => allowed.has(call.url))).toBe(true);
      }
    } finally {
      rpc.close();
    }
  });

  test("registry budgets reach every default pool through the published factories", () => {
    const transports = [
      { transport: ethereum(deterministic), registry: ETHEREUM_MAINNET_REGISTRY },
      { transport: hyperevm(deterministic), registry: [...HYPEREVM_MAINNET_REGISTRY, ...HYPEREVM_TESTNET_REGISTRY] },
      { transport: solana(deterministic), registry: MAINNET_REGISTRY },
      { transport: solana({ ...deterministic, cluster: "devnet" }), registry: DEVNET_REGISTRY },
      { transport: solana({ ...deterministic, cluster: "testnet" }), registry: TESTNET_REGISTRY },
    ];
    try {
      for (const { transport, registry } of transports) {
        const snapshots = transport.snapshot?.() ?? [];
        expect(snapshots).toHaveLength(registry.length);
        for (const entry of registry) {
          expect(snapshots.find((row) => row.url === entry.url)?.tokens).toBe(entry.burst);
        }
      }
    } finally {
      for (const { transport } of transports) transport.close?.();
    }
  });
});
