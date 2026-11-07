import type { ScoreSnapshot } from "@smart-rpc/core";
import { describe, expect, test } from "vitest";

import { solana } from "../src/index.js";

describe("Solana warm-start labels", () => {
  test("unlabeled credentialed URLs never reach scores or persisted JSON", async () => {
    const urls = [
      "https://user:SOLANA_SECRET_ONE@same.example/private/PATH_ONE?api-key=QUERY_ONE",
      "https://user:SOLANA_SECRET_TWO@same.example/private/PATH_TWO?api-key=QUERY_TWO",
    ];
    let now = 10_000_000;
    const fetchFn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body = JSON.parse(String(init?.body)) as { id: number };
      now += url === urls[0] ? 400 : 20;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: "ok" }), {
        headers: { "content-type": "application/json" },
      });
    };
    const saved: ScoreSnapshot[] = [];
    const options = {
      endpoints: urls,
      verifyIdentity: false,
      routing: "best",
      race: false,
      cache: false,
      coalesce: false,
      headLag: false,
      now: () => now,
      fetchFn,
    } as const;
    const transport = solana({
      ...options,
      persist: { load: () => undefined, save: (snapshot) => void saved.push(snapshot) },
    });
    await transport.request({ method: "getHealth" });
    await transport.request({ method: "getHealth" });
    const snapshot = transport.scores();
    const labels = Object.keys(snapshot.endpoints);
    expect(labels).toHaveLength(2);
    expect(new Set(labels).size).toBe(2);
    for (const label of labels) expect(label).toMatch(/^endpoint:[0-9a-f]{16}$/);
    expect(transport.endpoints.map((endpoint) => endpoint.id)).toEqual(urls);
    transport.close();
    expect(saved).toHaveLength(1);
    for (const text of [JSON.stringify(snapshot), JSON.stringify(saved)]) {
      for (const secret of [...urls, "SOLANA_SECRET", "QUERY_", "same.example", "private", "PATH_", "api-key"]) {
        expect(text).not.toContain(secret);
      }
    }

    const restored = solana(options);
    expect(restored.restoreScores(JSON.stringify(snapshot))).toBe(true);
    expect(Object.keys(restored.scores().endpoints)).toEqual(labels);
    expect(restored.endpoints.map((endpoint) => endpoint.id)).toEqual(urls);
  });
});
