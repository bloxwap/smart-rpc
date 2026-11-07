import { createPoolScope } from "@smart-rpc/core";
import { describe, expect, test } from "vitest";

import { MAINNET_GENESIS_HASH, solana } from "../src/index.js";

describe("solana scoped sharing", () => {
  test("equivalent consumers share identity checks, coalescing, and close ownership", async () => {
    const scope = createPoolScope();
    const calls: string[] = [];
    let release: (value: string) => void = () => undefined;
    const response = new Promise<string>((resolve) => { release = resolve; });
    const fetchFn = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body)) as { id: number; method: string };
      calls.push(body.method);
      const result = body.method === "getGenesisHash"
        ? MAINNET_GENESIS_HASH
        : body.method === "getHealth"
          ? await response
          : 10;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
        headers: { "content-type": "application/json" },
      });
    };
    const acquire = () => solana({
      endpoints: ["https://solana.example"],
      fetchFn,
      race: false,
      cache: false,
      headLag: { probeInterval: false },
      sharing: { scope, key: "mainnet-equivalent" },
    });
    const first = acquire();
    const second = acquire();
    const pending = [first.request({ method: "getHealth" }), second.request({ method: "getHealth" })];
    release("ok");
    await expect(Promise.all(pending)).resolves.toEqual(["ok", "ok"]);
    expect(calls.filter((method) => method === "getGenesisHash")).toHaveLength(1);
    expect(calls.filter((method) => method === "getHealth")).toHaveLength(1);
    first.close();
    await expect(second.request({ method: "getSlot" })).resolves.toBe(10);
    second.close();
    scope.close();
  });
});
