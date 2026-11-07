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
});
