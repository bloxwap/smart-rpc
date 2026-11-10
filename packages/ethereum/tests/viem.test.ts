import { beforeEach, describe, expect, test, vi } from "vitest";

const { http, webSocket } = vi.hoisted(() => ({
  http: vi.fn(),
  webSocket: vi.fn(),
}));

vi.mock("viem", async () => {
  const actual = await vi.importActual<typeof import("viem")>("viem");
  return {
    ...actual,
    http: (...args: unknown[]) => http(...args),
    webSocket: (...args: unknown[]) => webSocket(...args),
  };
});

import { ethereum } from "../src/transport.js";
import { connectViem } from "../src/viem.js";

function child(): () => { request: () => Promise<string> } {
  return () => ({
    request: () => Promise.resolve("0x1"),
  });
}

describe("ethereum child transports", () => {
  beforeEach(() => {
    http.mockReset();
    webSocket.mockReset();
    http.mockImplementation(() => child());
    webSocket.mockImplementation(() => child());
  });

  test("uses viem http() for http urls and webSocket() for ws urls", () => {
    const client = ethereum({
      endpoints: ["https://eth.example/rpc", "wss://eth.example/ws"],
      headLag: { probeInterval: false },
    });
    expect(http).toHaveBeenCalledWith("https://eth.example/rpc", expect.objectContaining({ retryCount: 0 }));
    expect(webSocket).toHaveBeenCalledWith("wss://eth.example/ws", expect.objectContaining({ retryCount: 0 }));
    client.close();
  });

  test("caps batches and forwards headers without enabling a disabled provider", () => {
    const client = ethereum({
      endpoints: [
        { url: "https://batched.example", headers: { authorization: "Bearer test" }, capabilities: { batch: true, maxBatchSize: 10 } },
        { url: "https://unbatched.example", capabilities: { batch: false } },
      ], batch: { batchSize: 100, wait: 5 }, headLag: false,
    });
    expect(http).toHaveBeenCalledWith("https://batched.example", expect.objectContaining({ batch: { batchSize: 10, wait: 5 }, fetchOptions: { headers: { authorization: "Bearer test" } } }));
    expect(http).toHaveBeenCalledWith("https://unbatched.example", expect.objectContaining({ batch: false }));
    client.close();
  });

  test("dedicated subscriptions stay on the verified viem connection and release on close", async () => {
    let id = "0x1";
    const unsubscribe = vi.fn().mockResolvedValue({ result: true });
    const subscribe = vi.fn().mockResolvedValue({ get subscriptionId() { return id; }, unsubscribe });
    const request = vi.fn().mockResolvedValue("0x1");
    webSocket.mockImplementation(() => () => ({ request, value: { subscribe } }));
    const connection = connectViem("wss://subscriptions.example", { timeout: 500, expectedChainId: 1, reconnect: { attempts: 3, delay: 100 } });
    const onData = vi.fn();
    const subscription = await connection.subscribe({ params: ["newHeads"], onData });
    expect(request).toHaveBeenCalledWith({ method: "eth_chainId" });
    expect(subscribe).toHaveBeenCalledWith(expect.objectContaining({ params: ["newHeads"] }));
    expect(subscribe.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ onData: expect.any(Function) }));
    expect(webSocket).toHaveBeenCalledWith("wss://subscriptions.example", expect.objectContaining({ reconnect: { attempts: 3, delay: 100 }, retryCount: 0 }));
    expect(subscription.subscriptionId).toBe("0x1");
    id = "0x2"; // viem replaces the ID after it reconnects and resubscribes.
    expect(subscription.subscriptionId).toBe("0x2");
    connection.close();
    connection.close();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    await expect(connection.subscribe({ params: ["newHeads"], onData })).rejects.toThrow("closed");
  });

  test("does not subscribe on another chain or silently discard WS headers", async () => {
    const subscribe = vi.fn();
    webSocket.mockImplementation(() => () => ({ request: vi.fn().mockResolvedValue("0x2"), value: { subscribe } }));
    const connection = connectViem("wss://wrong.example", { timeout: 500, expectedChainId: 1 });
    await expect(connection.subscribe({ params: ["newHeads"], onData: () => undefined })).rejects.toThrow("different chain");
    expect(subscribe).not.toHaveBeenCalled();
    connection.close();
    expect(() => connectViem("wss://header.example", { timeout: 500, headers: { authorization: "test" } })).toThrow("WebSocket headers");
  });

  test("a socket close makes the next subscription event recheck eth_chainId", async () => {
    const identities = ["0x1", "0x2"];
    const request = vi.fn(async () => identities.shift() ?? "0x2");
    const socket = new EventTarget();
    const subscribe = vi.fn(async () => ({
      get subscriptionId() { return "0x1"; },
      unsubscribe: vi.fn(async () => ({ result: true })),
    }));
    webSocket.mockImplementation(() => () => ({
      request,
      value: { subscribe, getSocket: () => socket },
    }));
    const connection = connectViem("wss://recheck.example", { timeout: 500, expectedChainId: 1 });
    const onData = vi.fn();
    await connection.subscribe({ params: ["newHeads"], onData });
    expect(request).toHaveBeenCalledTimes(1);
    socket.dispatchEvent(new Event("close"));
    const wrapped = (subscribe.mock.calls as unknown as [[{ onData: (data: unknown) => void }]])[0]?.[0];
    wrapped?.onData({ number: "0x2" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(request).toHaveBeenCalledTimes(2);
    expect(onData).not.toHaveBeenCalled();
    connection.close();
  });
});
