import { describe, expect, test } from "vitest";

import { etherlink, ETHERLINK_MAINNET_CAIP, ETHERLINK_MAINNET_REGISTRY } from "../src/index.js";

describe("Etherlink default endpoints", () => {
  test("omitting endpoints loads the public registry lazily with its documented budgets", () => {
    let fetched = 0;
    const pool = etherlink({
      headLag: { probeInterval: false },
      fetchFn: async () => { fetched += 1; return Response.json({}); },
    });
    try {
      expect(pool.chainIds).toEqual([ETHERLINK_MAINNET_CAIP]);
      expect(pool.endpoints.map(({ url }) => url)).toEqual(ETHERLINK_MAINNET_REGISTRY.map(({ url }) => url));
      expect(pool.endpoints.map(({ weight }) => weight)).toEqual(ETHERLINK_MAINNET_REGISTRY.map(({ weight }) => weight ?? 1));
      expect(fetched).toBe(0);
    } finally { pool.close(); }
  });
});
