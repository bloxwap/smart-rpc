import { createPublicClient } from "viem";
import { bsc, mainnet } from "viem/chains";
import { describe, expect, test } from "vitest";

import { asViemTransport } from "../src/adapter.js";

interface Call {
  method: string;
}

function mockRpc(answer: (call: Call) => unknown | Promise<unknown>) {
  const calls: Call[] = [];
  return {
    calls,
    async fetchFn(_input: string | URL | Request, init?: RequestInit): Promise<Response> {
      const body = JSON.parse(String(init?.body)) as { id: number; method: string };
      const call = { method: body.method };
      calls.push(call);
      const result = await answer(call);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
        headers: { "content-type": "application/json" },
      });
    },
  };
}

describe("asViemTransport", () => {
  test("equivalent viem clients coalesce and close independently, then reopen fresh", async () => {
    let release: (value: string) => void = () => undefined;
    const response = new Promise<string>((resolve) => { release = resolve; });
    const mock = mockRpc(({ method }) => {
      if (method === "eth_chainId") return "0x1";
      if (method === "eth_getBalance") return response;
      return "0x10";
    });
    const transport = asViemTransport({
      endpoints: ["https://eth.example/rpc?credential=one"],
      fetchFn: mock.fetchFn,
      headLag: { probeInterval: false },
      race: false,
      cache: false,
    });
    const first = createPublicClient({ transport });
    const second = createPublicClient({ transport });
    const args: { method: "eth_getBalance"; params: [`0x${string}`, "latest"] } = {
      method: "eth_getBalance",
      params: ["0x1", "latest"],
    };
    const pending = [first.request(args), second.request(args)];
    release("0x2");
    await expect(Promise.all(pending)).resolves.toEqual(["0x2", "0x2"]);
    expect(mock.calls.filter(({ method }) => method === "eth_getBalance")).toHaveLength(1);
    expect(mock.calls.filter(({ method }) => method === "eth_chainId")).toHaveLength(1);

    first.transport.close();
    await expect(second.request({ method: "eth_blockNumber" })).resolves.toBe("0x10");
    second.transport.close();

    const fresh = createPublicClient({ transport });
    await expect(fresh.request({ method: "eth_blockNumber" })).resolves.toBe("0x10");
    expect(mock.calls.filter(({ method }) => method === "eth_chainId")).toHaveLength(2);
    fresh.transport.close();
  });

  test("clients with different timeouts use separate pools and one endpoint budget", async () => {
    const mock = mockRpc(() => "0x1");
    const transport = asViemTransport({
      endpoints: [{ url: "https://limited.example", rps: 1, burst: 2 }],
      fetchFn: mock.fetchFn,
      verifyIdentity: false,
      headLag: false,
      race: false,
      cache: false,
      retryCount: 0,
      now: () => 0,
    });
    const first = transport({ timeout: 1_000, retryCount: 0 });
    const second = transport({ timeout: 2_000, retryCount: 0 });
    await first.request({ method: "eth_chainId" });
    expect(second.value?.snapshot()[0]?.tokens).toBe(1);
    await second.request({ method: "eth_chainId" });
    expect(first.value?.snapshot()[0]?.tokens).toBe(0);
    expect(second.value?.snapshot()[0]?.tokens).toBe(0);
    first.value?.close();
    second.value?.close();
  });

  test("chain identity separates clients and mismatched explicit chains fail", () => {
    const transport = asViemTransport({ endpoints: ["https://multi.example"], headLag: false });
    const ethereumClient = transport({ chain: mainnet });
    const bscClient = transport({ chain: bsc });
    expect(ethereumClient.value?.chainIds).toEqual(["eip155:1"]);
    expect(bscClient.value?.chainIds).toEqual(["eip155:56"]);
    ethereumClient.value?.close();
    bscClient.value?.close();

    const configured = asViemTransport({ chainId: 1, endpoints: ["https://multi.example"] });
    expect(() => configured({ chain: bsc })).toThrow("does not match configured chain");
  });
});
