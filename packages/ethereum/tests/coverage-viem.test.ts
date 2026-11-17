import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

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

import { connectViem } from "../src/viem.js";

type Wrapped = { onData: (data: unknown) => void };
type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

/** A viem webSocket() child whose pieces the test controls. */
function socketChild(parts: { request?: ReturnType<typeof vi.fn>; subscribe?: ReturnType<typeof vi.fn>; getSocket?: () => unknown } = {}) {
  const unsubscribe = vi.fn(async () => ({ result: true }));
  const request = parts.request ?? vi.fn(async () => "0x1");
  const subscribe = parts.subscribe ?? vi.fn(async () => ({ subscriptionId: "0xsub", unsubscribe }));
  const value = parts.getSocket ? { subscribe, getSocket: parts.getSocket } : { subscribe };
  webSocket.mockImplementation(() => () => ({ request, value }));
  const wrapped = (): Wrapped => {
    const options = (subscribe.mock.calls as unknown as [Wrapped][])[0]?.[0];
    if (!options) throw new Error("subscribe was not called");
    return options;
  };
  return { request, subscribe, unsubscribe, wrapped };
}

const flush = async (): Promise<void> => { await new Promise((resolve) => setTimeout(resolve, 0)); };

beforeEach(() => {
  http.mockReset();
  webSocket.mockReset();
  http.mockImplementation(() => () => ({ request: vi.fn(async () => "0x1") }));
  webSocket.mockImplementation(() => () => ({ request: vi.fn(async () => "0x1") }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("connectViem construction", () => {
  test("refuses a URL that is neither http(s) nor ws(s) without building a transport", () => {
    expect(() => connectViem("ftp://files.example/rpc", { timeout: 500 })).toThrow("RPC URL must be http(s) or ws(s): ftp:");
    expect(http).not.toHaveBeenCalled();
    expect(webSocket).not.toHaveBeenCalled();
  });

  test.each([
    [{ wait: -1 }, "batch.wait must be a non-negative finite number."],
    [{ wait: Number.POSITIVE_INFINITY }, "batch.wait must be a non-negative finite number."],
    [{ batchSize: 0 }, "batch.batchSize must be a positive safe integer."],
    [{ batchSize: 1.5 }, "batch.batchSize must be a positive safe integer."],
  ])("refuses batch settings %o", (batch, message) => {
    expect(() => connectViem("https://batch.example", { timeout: 500, batch })).toThrow(message);
  });
});

describe("connectViem calls", () => {
  test("a closed connection rejects calls without reaching viem", async () => {
    const request = vi.fn(async () => "0x1");
    http.mockImplementation(() => () => ({ request }));
    const connection = connectViem("https://closed.example", { timeout: 500 });
    await expect(connection.call({ method: "eth_blockNumber" })).resolves.toBe("0x1");
    connection.close();
    await expect(connection.call({ method: "eth_blockNumber" })).rejects.toThrow("Connection is closed.");
    expect(request).toHaveBeenCalledTimes(1);
  });

  test("an unbatched call without a caller signal gets its own live signal each time", async () => {
    const request = vi.fn(async (_body: unknown, _options: { signal: AbortSignal }) => "0x1");
    http.mockImplementation(() => () => ({ request }));
    const connection = connectViem("https://unbatched.example", { timeout: 500 });
    await connection.call({ method: "eth_blockNumber" });
    await connection.call({ method: "eth_getBalance", params: ["0xabc", "latest"] });
    expect(request.mock.calls[0]?.[0]).toEqual({ method: "eth_blockNumber", params: [] });
    expect(request.mock.calls[1]?.[0]).toEqual({ method: "eth_getBalance", params: ["0xabc", "latest"] });
    const signals = request.mock.calls.map((call) => call[1].signal);
    expect(signals.every((signal) => signal instanceof AbortSignal && !signal.aborted)).toBe(true);
    expect(signals[0]).not.toBe(signals[1]);
    connection.close();
  });

  test("a caller signal is passed through to an unbatched call", async () => {
    const request = vi.fn(async (_body: unknown, _options: { signal: AbortSignal }) => "0x1");
    http.mockImplementation(() => () => ({ request }));
    const connection = connectViem("https://signal.example", { timeout: 500 });
    const controller = new AbortController();
    await connection.call({ method: "eth_sendRawTransaction", params: ["0x01"] }, { signal: controller.signal });
    expect(request.mock.calls[0]?.[1].signal).toBe(controller.signal);
    connection.close();
  });

  test("a batched call whose signal is already aborted rejects with its reason and sends nothing", async () => {
    const request = vi.fn(async () => "0x1");
    http.mockImplementation(() => () => ({ request }));
    const connection = connectViem("https://aborted.example", { timeout: 500, batch: true });
    const controller = new AbortController();
    const reason = new Error("caller gave up");
    controller.abort(reason);
    await expect(connection.call({ method: "eth_blockNumber" }, { signal: controller.signal })).rejects.toBe(reason);
    await flush();
    expect(request).not.toHaveBeenCalled();
    connection.close();
  });
});

describe("Retry-After hints", () => {
  type FetchHook = { onFetchResponse: (response: Response) => void };
  const hook = (): FetchHook => (http.mock.calls as unknown as [string, FetchHook][])[0]![1];
  const limited = (seconds: string, status = 429): Response => new Response("slow down", { status, headers: { "retry-after": seconds } });

  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
  });

  test("the recorded wait is attached to an error that carries none", async () => {
    const failure = new Error("HTTP request failed.");
    const request = vi.fn(async () => {
      hook().onFetchResponse(limited("7"));
      throw failure;
    });
    http.mockImplementation(() => () => ({ request }));
    const connection = connectViem("https://limited.example", { timeout: 500 });
    await expect(connection.call({ method: "eth_blockNumber" })).rejects.toBe(failure);
    const headers = (failure as Error & { headers?: Headers }).headers;
    expect(headers).toBeInstanceOf(Headers);
    expect(headers?.get("retry-after")).toBe("7");
    // The failed call consumed the hint.
    expect(connection.retryAfter()).toBe(0);
    connection.close();
  });

  test("a sub-second wait is rounded up to one second", async () => {
    const failure = new Error("HTTP request failed.");
    const request = vi.fn(async () => {
      hook().onFetchResponse(limited("0.2", 503));
      throw failure;
    });
    http.mockImplementation(() => () => ({ request }));
    const connection = connectViem("https://subsecond.example", { timeout: 500 });
    await expect(connection.call({ method: "eth_blockNumber" })).rejects.toBe(failure);
    expect((failure as Error & { headers?: Headers }).headers?.get("retry-after")).toBe("1");
    connection.close();
  });

  test("an error that already names a wait keeps its own headers", async () => {
    const own = new Headers({ "retry-after": "30" });
    const failure = Object.assign(new Error("HTTP request failed."), { headers: own });
    const request = vi.fn(async () => {
      hook().onFetchResponse(limited("7"));
      throw failure;
    });
    http.mockImplementation(() => () => ({ request }));
    const connection = connectViem("https://own.example", { timeout: 500 });
    await expect(connection.call({ method: "eth_blockNumber" })).rejects.toBe(failure);
    expect(failure.headers).toBe(own);
    connection.close();
  });

  test("a thrown non-object is rethrown untouched", async () => {
    const request = vi.fn(async () => {
      hook().onFetchResponse(limited("7"));
      throw "socket hang up"; // eslint-disable-line @typescript-eslint/only-throw-error
    });
    http.mockImplementation(() => () => ({ request }));
    const connection = connectViem("https://string.example", { timeout: 500 });
    await expect(connection.call({ method: "eth_blockNumber" })).rejects.toBe("socket hang up");
    expect(connection.retryAfter()).toBe(0);
    connection.close();
  });

  test("only 429 and 503 record a wait, and reading it clears it", () => {
    const connection = connectViem("https://take.example", { timeout: 500 });
    hook().onFetchResponse(limited("7", 500));
    expect(connection.retryAfter()).toBe(0);
    hook().onFetchResponse(limited("7"));
    hook().onFetchResponse(limited("3"));
    expect(connection.retryAfter()).toBe(7_000);
    expect(connection.retryAfter()).toBe(0);
    connection.close();
  });
});

describe("dedicated subscriptions", () => {
  const onData = (): void => undefined;

  test("an HTTP connection cannot subscribe", async () => {
    const connection = connectViem("https://http.example", { timeout: 500, expectedChainId: 1 });
    await expect(connection.subscribe({ params: ["newHeads"], onData })).rejects.toThrow("Subscriptions require a documented WebSocket endpoint.");
    connection.close();
  });

  test("a WebSocket child that exposes no subscribe cannot subscribe", async () => {
    const request = vi.fn(async () => "0x1");
    webSocket.mockImplementation(() => () => ({ request, value: {} }));
    const connection = connectViem("wss://bare.example", { timeout: 500, expectedChainId: 1 });
    await expect(connection.subscribe({ params: ["newHeads"], onData })).rejects.toThrow("Subscriptions require a documented WebSocket endpoint.");
    expect(request).not.toHaveBeenCalled();
    connection.close();
  });

  test("a subscription without an expected chain id is refused before any request", async () => {
    const { request, subscribe } = socketChild();
    const connection = connectViem("wss://anonymous.example", { timeout: 500 });
    await expect(connection.subscribe({ params: ["newHeads"], onData })).rejects.toThrow("Subscriptions require expectedChainId");
    expect(request).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
    connection.close();
  });

  test("closing during identity verification stops before subscribing upstream", async () => {
    const identity = deferred<string>();
    const { subscribe } = socketChild({ request: vi.fn(() => identity.promise) });
    const connection = connectViem("wss://closing.example", { timeout: 500, expectedChainId: 1 });
    const pending = connection.subscribe({ params: ["newHeads"], onData });
    connection.close();
    identity.resolve("0x1");
    await expect(pending).rejects.toThrow("Connection is closed.");
    expect(subscribe).not.toHaveBeenCalled();
  });

  test("closing while the upstream subscribe is pending releases it", async () => {
    const unsubscribe = vi.fn(async () => ({ result: true }));
    const upstream = deferred<{ subscriptionId: string; unsubscribe: typeof unsubscribe }>();
    const subscribe = vi.fn(() => upstream.promise);
    socketChild({ subscribe });
    const connection = connectViem("wss://late.example", { timeout: 500, expectedChainId: 1 });
    const pending = connection.subscribe({ params: ["newHeads"], onData });
    await flush();
    expect(subscribe).toHaveBeenCalledTimes(1);
    connection.close();
    expect(unsubscribe).not.toHaveBeenCalled();
    upstream.resolve({ subscriptionId: "0xsub", unsubscribe });
    await expect(pending).rejects.toThrow("Connection closed while subscribing.");
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  test("close() survives an upstream unsubscribe that rejects", async () => {
    const unsubscribe = vi.fn(async () => { throw new Error("socket already gone"); });
    socketChild({ subscribe: vi.fn(async () => ({ subscriptionId: "0xsub", unsubscribe })) });
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const connection = connectViem("wss://gone.example", { timeout: 500, expectedChainId: 1 });
      await connection.subscribe({ params: ["newHeads"], onData });
      expect(() => connection.close()).not.toThrow();
      await flush();
      expect(unsubscribe).toHaveBeenCalledTimes(1);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  test("a subscription the caller released is not unsubscribed again on close", async () => {
    const { unsubscribe } = socketChild();
    const connection = connectViem("wss://released.example", { timeout: 500, expectedChainId: 1 });
    const subscription = await connection.subscribe({ params: ["newHeads"], onData });
    await expect(subscription.unsubscribe()).resolves.toEqual({ result: true });
    connection.close();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  test("events on the verified socket are delivered without another identity check", async () => {
    const socket = new EventTarget();
    const { request, wrapped } = socketChild({ getSocket: () => socket });
    const connection = connectViem("wss://steady.example", { timeout: 500, expectedChainId: 1 });
    const received = vi.fn();
    await connection.subscribe({ params: ["newHeads"], onData: received });
    wrapped().onData({ number: "0x2" });
    wrapped().onData({ number: "0x3" });
    expect(received.mock.calls).toEqual([[{ number: "0x2" }], [{ number: "0x3" }]]);
    expect(request).toHaveBeenCalledTimes(1);
    connection.close();
  });

  test("a replaced socket is re-verified before its first event is delivered", async () => {
    let socket = new EventTarget();
    const { request, wrapped } = socketChild({ getSocket: () => socket });
    const connection = connectViem("wss://replaced.example", { timeout: 500, expectedChainId: 1 });
    const received = vi.fn();
    await connection.subscribe({ params: ["newHeads"], onData: received });
    socket = new EventTarget(); // viem reconnected without the old socket reporting a close.
    wrapped().onData({ number: "0x2" });
    expect(received).not.toHaveBeenCalled();
    await flush();
    expect(request).toHaveBeenCalledTimes(2);
    expect(received.mock.calls).toEqual([[{ number: "0x2" }]]);
    wrapped().onData({ number: "0x3" });
    expect(request).toHaveBeenCalledTimes(2);
    expect(received).toHaveBeenCalledTimes(2);
    connection.close();
  });

  test("an event awaiting re-verification is dropped when the connection closes first", async () => {
    const socket = new EventTarget();
    const recheck = deferred<string>();
    const request = vi.fn<() => Promise<string>>().mockResolvedValueOnce("0x1").mockReturnValueOnce(recheck.promise);
    const { wrapped } = socketChild({ request, getSocket: () => socket });
    const connection = connectViem("wss://dropped.example", { timeout: 500, expectedChainId: 1 });
    const received = vi.fn();
    await connection.subscribe({ params: ["newHeads"], onData: received });
    socket.dispatchEvent(new Event("close"));
    wrapped().onData({ number: "0x2" });
    connection.close();
    recheck.resolve("0x1");
    await flush();
    expect(request).toHaveBeenCalledTimes(2);
    expect(received).not.toHaveBeenCalled();
  });

  test("a child whose socket cannot be read still subscribes and delivers", async () => {
    const getSocket = vi.fn(() => { throw new Error("socket not open"); });
    const { request, wrapped } = socketChild({ getSocket });
    const connection = connectViem("wss://unreadable.example", { timeout: 500, expectedChainId: 1 });
    const received = vi.fn();
    const subscription = await connection.subscribe({ params: ["newHeads"], onData: received });
    expect(subscription.subscriptionId).toBe("0xsub");
    wrapped().onData({ number: "0x2" });
    expect(received).toHaveBeenCalledWith({ number: "0x2" });
    expect(getSocket).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledTimes(1);
    connection.close();
  });
});
