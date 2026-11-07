import { afterEach, describe, expect, test, vi } from "vitest";

import { pool } from "./helpers.js";

afterEach(() => {
  vi.useRealTimers();
});

const read = { method: "eth_getBalance", params: ["0x1", "latest"] };

describe("cold backup hedges", () => {
  test("verifies a cold backup and dispatches it while the primary is still active", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const seen: string[] = [];
    let primarySignal: AbortSignal | undefined;
    let releasePrimary!: (result: string) => void;
    const primaryResponse = new Promise<string>((resolve) => {
      releasePrimary = resolve;
    });
    const client = pool([
      {
        id: "primary",
        url: "primary",
        call: async ({ method }, options) => {
          seen.push(`primary:${method}`);
          if (method === "eth_chainId") return "0x1";
          primarySignal = options?.signal;
          return primaryResponse;
        },
      },
      {
        id: "backup",
        url: "backup",
        call: async ({ method }) => {
          seen.push(`backup:${method}`);
          return method === "eth_chainId" ? "0x1" : "0xbackup";
        },
      },
    ], {
      verifyIdentity: true,
      routing: "best",
      race: false,
      headLag: { probeInterval: false },
      hedge: { minDelay: 10, multiplier: 0 },
      retryCount: 0,
    });

    const pending = client.request(read);
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual(["primary:eth_chainId", "primary:eth_getBalance"]);
    await vi.advanceTimersByTimeAsync(10);
    await expect(pending).resolves.toBe("0xbackup");
    expect(seen).toEqual([
      "primary:eth_chainId",
      "primary:eth_getBalance",
      "backup:eth_chainId",
      "backup:eth_getBalance",
    ]);
    expect(primarySignal?.aborted).toBe(true);
    releasePrimary("0xprimary");
    await vi.advanceTimersByTimeAsync(0);
    client.close();
  });

  test("leaves the primary running when the backup identity check fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const backupCalls: string[] = [];
    const client = pool([
      {
        url: "primary",
        call: async ({ method }) => {
          if (method === "eth_chainId") return "0x1";
          await new Promise((resolve) => setTimeout(resolve, 30));
          return "0xprimary";
        },
      },
      {
        url: "backup",
        call: async ({ method }) => {
          backupCalls.push(method);
          if (method === "eth_chainId") throw new Error("identity unavailable");
          return "0xbackup";
        },
      },
    ], {
      verifyIdentity: true,
      routing: "best",
      hedge: { minDelay: 10, multiplier: 0 },
      retryCount: 0,
    });

    const pending = client.request(read);
    await vi.advanceTimersByTimeAsync(30);
    await expect(pending).resolves.toBe("0xprimary");
    expect(backupCalls).toEqual(["eth_chainId"]);
    client.close();
  });

  test("cancels the caller while a cold backup is being checked without dispatching or recording failures", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const backupCalls: string[] = [];
    const errors: unknown[] = [];
    let releaseIdentity!: (result: string) => void;
    const identity = new Promise<string>((resolve) => {
      releaseIdentity = resolve;
    });
    const client = pool([
      {
        url: "primary",
        call: async ({ method }) => method === "eth_chainId"
          ? "0x1"
          : new Promise<string>(() => undefined),
      },
      {
        url: "backup",
        call: async ({ method }) => {
          backupCalls.push(method);
          return method === "eth_chainId" ? identity : "0xbackup";
        },
      },
    ], {
      verifyIdentity: true,
      routing: "best",
      hedge: { minDelay: 10, multiplier: 0 },
      retryCount: 0,
      onEvent: (event) => {
        if (event.type === "error") errors.push(event);
      },
    });

    const controller = new AbortController();
    const outcome = client.request({ ...read, signal: controller.signal }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10);
    expect(backupCalls).toEqual(["eth_chainId"]);
    controller.abort();
    await expect(outcome).resolves.toMatchObject({ name: "AbortError" });
    releaseIdentity("0x1");
    await vi.advanceTimersByTimeAsync(0);
    expect(backupCalls).toEqual(["eth_chainId"]);
    expect(errors).toEqual([]);
    client.close();
  });

  test("charges the cold identity check to the operation budget without failing the primary", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const backupCalls: string[] = [];
    const client = pool([
      {
        url: "primary",
        call: async ({ method }) => {
          if (method === "eth_chainId") return "0x1";
          await new Promise((resolve) => setTimeout(resolve, 30));
          return "0xprimary";
        },
      },
      {
        url: "backup",
        call: async ({ method }) => {
          backupCalls.push(method);
          return "0x1";
        },
      },
    ], {
      verifyIdentity: true,
      routing: "best",
      hedge: { minDelay: 10, multiplier: 0 },
      retryCount: 0,
      operationBudget: { maxRequests: 3 },
    });

    const pending = client.request(read);
    await vi.advanceTimersByTimeAsync(30);
    await expect(pending).resolves.toBe("0xprimary");
    expect(backupCalls).toEqual(["eth_chainId"]);
    client.close();
  });

  test("does not dispatch a cold hedge after its identity check spends the last endpoint token", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const backupCalls: string[] = [];
    const client = pool([
      {
        url: "primary",
        call: async ({ method }) => {
          if (method === "eth_chainId") return "0x1";
          await new Promise((resolve) => setTimeout(resolve, 30));
          return "0xprimary";
        },
      },
      {
        url: "backup",
        rps: 0.01,
        burst: 1,
        call: async ({ method }) => {
          backupCalls.push(method);
          return "0x1";
        },
      },
    ], {
      verifyIdentity: true,
      routing: "best",
      hedge: { minDelay: 10, multiplier: 0 },
      retryCount: 0,
    });

    const pending = client.request(read);
    await vi.advanceTimersByTimeAsync(30);
    await expect(pending).resolves.toBe("0xprimary");
    expect(backupCalls).toEqual(["eth_chainId"]);
    client.close();
  });

  test("shares an identity check already started by another caller", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const backupCalls: string[] = [];
    let releaseIdentity!: (result: string) => void;
    const identity = new Promise<string>((resolve) => {
      releaseIdentity = resolve;
    });
    const client = pool([
      {
        url: "primary",
        supports: (method) => method !== "eth_getCode",
        call: async ({ method }) => method === "eth_chainId"
          ? "0x1"
          : new Promise<string>(() => undefined),
      },
      {
        url: "backup",
        call: async ({ method }) => {
          backupCalls.push(method);
          if (method === "eth_chainId") return identity;
          return method === "eth_getCode" ? "0xcode" : "0xbackup";
        },
      },
    ], {
      verifyIdentity: true,
      routing: "best",
      hedge: { minDelay: 10, multiplier: 0 },
      retryCount: 0,
    });

    const warming = client.request({ method: "eth_getCode", params: ["0x1", "latest"] });
    await vi.advanceTimersByTimeAsync(0);
    expect(backupCalls).toEqual(["eth_chainId"]);
    const pending = client.request(read);
    await vi.advanceTimersByTimeAsync(10);
    expect(backupCalls).toEqual(["eth_chainId"]);

    releaseIdentity("0x1");
    await vi.advanceTimersByTimeAsync(0);
    await expect(warming).resolves.toBe("0xcode");
    await expect(pending).resolves.toBe("0xbackup");
    expect(backupCalls[0]).toBe("eth_chainId");
    expect(backupCalls.slice(1).sort()).toEqual(["eth_getBalance", "eth_getCode"]);
    client.close();
  });

  test("does not dispatch a cold hedge after its identity check spends the last provider token", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const backupCalls: string[] = [];
    const provider = { providerGroup: "shared", providerBudget: { rps: 0.01, burst: 3 } };
    const client = pool([
      {
        url: "primary",
        ...provider,
        call: async ({ method }) => {
          if (method === "eth_chainId") return "0x1";
          await new Promise((resolve) => setTimeout(resolve, 30));
          return "0xprimary";
        },
      },
      {
        url: "backup",
        ...provider,
        call: async ({ method }) => {
          backupCalls.push(method);
          return "0x1";
        },
      },
    ], {
      verifyIdentity: true,
      routing: "best",
      hedge: { minDelay: 10, multiplier: 0 },
      retryCount: 0,
    });

    const pending = client.request(read);
    await vi.advanceTimersByTimeAsync(30);
    await expect(pending).resolves.toBe("0xprimary");
    expect(backupCalls).toEqual(["eth_chainId"]);
    client.close();
  });
});
