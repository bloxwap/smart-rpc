import { afterEach, describe, expect, test, vi } from "vitest";

import { pool } from "./helpers.js";

class FakeDocument {
  visibilityState: string;
  readonly listeners = new Set<() => void>();

  constructor(state: string) {
    this.visibilityState = state;
  }

  addEventListener(type: string, listener: () => void): void {
    if (type === "visibilitychange") this.listeners.add(listener);
  }

  removeEventListener(type: string, listener: () => void): void {
    if (type === "visibilitychange") this.listeners.delete(listener);
  }

  show(): void {
    this.set("visible");
  }

  hide(): void {
    this.set("hidden");
  }

  private set(state: string): void {
    this.visibilityState = state;
    for (const listener of [...this.listeners]) listener();
  }
}

const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");

function fakeDocument(state: string): FakeDocument {
  const document = new FakeDocument(state);
  Object.defineProperty(globalThis, "document", { value: document, configurable: true, writable: true });
  return document;
}

afterEach(() => {
  vi.useRealTimers();
  if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
  else Reflect.deleteProperty(globalThis, "document");
});

describe("browser activity probes", () => {
  test("probes as soon as a hidden page becomes visible and stays paused while hidden", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const document = fakeDocument("hidden");
    const calls: string[] = [];
    const client = pool([{
      url: "a",
      call: async ({ method }) => {
        calls.push(method);
        return "0x1";
      },
    }], {
      now: () => Date.now(),
      headLag: { probeInterval: 10, probeIdleTimeout: false },
    });

    await client.request({ method: "eth_call", params: [] });
    await vi.advanceTimersByTimeAsync(50);
    expect(calls.filter((method) => method === "eth_blockNumber")).toHaveLength(0);

    document.show();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.filter((method) => method === "eth_blockNumber")).toHaveLength(1);

    document.hide();
    await vi.advanceTimersByTimeAsync(50);
    expect(calls.filter((method) => method === "eth_blockNumber")).toHaveLength(1);
    client.close();
  });

  test("suppresses visibility bursts and duplicates while a probe is in flight", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const document = fakeDocument("hidden");
    let probes = 0;
    let release!: (result: string) => void;
    const response = new Promise<string>((resolve) => {
      release = resolve;
    });
    const client = pool([{
      url: "a",
      call: async ({ method }) => {
        if (method === "eth_blockNumber") {
          probes += 1;
          return response;
        }
        return "0x1";
      },
    }], {
      now: () => Date.now(),
      headLag: { probeInterval: 60_000, probeIdleTimeout: false },
    });

    await client.request({ method: "eth_call", params: [] });
    document.show();
    await vi.advanceTimersByTimeAsync(0);
    expect(probes).toBe(1);

    for (let index = 0; index < 20; index += 1) {
      document.hide();
      document.show();
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(probes).toBe(1);

    release("0x10");
    await vi.advanceTimersByTimeAsync(0);
    for (let index = 0; index < 20; index += 1) {
      document.hide();
      document.show();
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(probes).toBe(1);
    client.close();
  });

  test("removes the visibility listener on idle stop and close and restarts it on demand", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const document = fakeDocument("hidden");
    let probes = 0;
    const client = pool([{
      url: "a",
      call: async ({ method }) => {
        if (method === "eth_blockNumber") probes += 1;
        return "0x1";
      },
    }], {
      now: () => Date.now(),
      headLag: { probeInterval: 10, probeIdleTimeout: 30 },
    });

    expect(document.listeners.size).toBe(0);
    await client.request({ method: "eth_call", params: [] });
    expect(document.listeners.size).toBe(1);
    await vi.advanceTimersByTimeAsync(30);
    expect(document.listeners.size).toBe(0);
    expect(probes).toBe(0);

    document.show();
    await vi.advanceTimersByTimeAsync(0);
    expect(probes).toBe(0);
    await client.request({ method: "eth_call", params: [] });
    expect(document.listeners.size).toBe(1);
    client.close();
    expect(document.listeners.size).toBe(0);
  });
});
