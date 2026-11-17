import { expect, test } from "vitest";

import { AllEndpointsFailedError } from "../src/errors.js";
import { evmPolicy, pool } from "./helpers.js";

test("a failover hook that throws during an identity check rejects the call without an unhandled rejection", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
  process.on("unhandledRejection", onUnhandled);
  const calls: string[] = [];
  const client = pool(
    [{
      id: "a",
      url: "a",
      call: async ({ method }) => {
        calls.push(method);
        if (method === "eth_chainId") throw new Error("identity down");
        return "0x10";
      },
    }],
    { verifyIdentity: true, retryCount: 0 },
    { ...evmPolicy(), shouldFailover: () => { throw new Error("hook failed"); } },
  );
  try {
    const error = await client.request({ method: "eth_getBalance", params: ["0x1", "latest"] }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AllEndpointsFailedError);
    expect((error as AllEndpointsFailedError).cause).toMatchObject({ message: "hook failed" });
    // The user read is never sent to an endpoint whose identity could not be established.
    expect(calls).not.toContain("eth_getBalance");
    // Node reports unhandled rejections after the microtask queue drains.
    await new Promise((resolve) => setImmediate(resolve));
    expect(unhandled).toEqual([]);
    // The failed check is not left pending, so a later call checks again.
    const before = calls.length;
    await client.request({ method: "eth_getBalance", params: ["0x1", "latest"] }).catch(() => undefined);
    expect(calls.length).toBeGreaterThan(before);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    client.close();
  }
});
