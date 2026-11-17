import { afterEach, describe, expect, test, vi } from "vitest";

import type { RpcEvent } from "../src/events.js";
import { Scoreboard } from "../src/scoreboard.js";
import { WarmStart, localStoragePersistence, type ScorePersistence, type ScoreSnapshot } from "../src/warmstart.js";

const NOW = 10_000_000;

function setup(persistence?: ScorePersistence, labelled: readonly string[] = ["a", "b"]) {
  const scoreboard = new Scoreboard(
    ["a", "b"].map((id, index) => ({ id, url: `https://${id}.example`, weight: 1, index, supports: (): boolean => true })),
    { perMethod: true, headLag: false, maxLag: 2, staleMs: 30_000, now: () => NOW },
  );
  const events: RpcEvent[] = [];
  const warm = new WarmStart(scoreboard, {
    persistence,
    endpoints: labelled.map((id) => ({ id, label: `label-${id}` })),
    latencyCapMs: 1_000,
    loadTimeoutMs: 1_000,
    now: () => NOW,
    emit: (event) => events.push(event),
  });
  return { scoreboard, warm, events };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("warm start edges", () => {
  test("books of an endpoint with no public label are left out of the snapshot", () => {
    const { scoreboard, warm } = setup(undefined, ["a"]);
    scoreboard.success("a", "eth_call", 40, true);
    scoreboard.success("b", "eth_call", 400, true);
    const snapshot = warm.scores();
    expect(Object.keys(snapshot.endpoints)).toEqual(["label-a"]);
    expect(snapshot.endpoints["label-a"]?.["eth_call"]).toEqual({ ewma: 40, tail: 40, error: 0, n: 1 });
    expect(snapshot.savedAt).toBe(NOW);
  });

  test("closing twice saves once", () => {
    const saved: ScoreSnapshot[] = [];
    const { scoreboard, warm, events } = setup({ load: () => undefined, save: (snapshot) => void saved.push(snapshot) });
    expect(warm.touch()).toBeUndefined();
    scoreboard.success("a", "eth_call", 40, true);
    warm.close();
    warm.close();
    expect(saved).toHaveLength(1);
    expect(saved[0]?.endpoints["label-a"]?.["*"]?.n).toBe(1);
    expect(warm.touch()).toBeUndefined();
    expect(events).toEqual([]);
  });

  test("an endpoint entry that is not a map of books is skipped, and the other endpoint still restores", () => {
    const { scoreboard, warm } = setup();
    const book = { ewma: 40, tail: 60, error: 0, n: 9 };
    expect(warm.restore({ version: 1, savedAt: NOW, endpoints: { "label-a": [book], "label-b": { "*": book } } })).toBe(true);
    expect(scoreboard.books()).toEqual([{ id: "b", method: "*", stat: { ewma: 40, tail: 60, error: 0, n: 2 }, at: NOW }]);
  });

  test("a book that is not an object is skipped, and its neighbours still restore", () => {
    const { scoreboard, warm } = setup();
    const restored = warm.restore({
      version: 1,
      savedAt: NOW,
      endpoints: { "label-a": { "*": 5, eth_call: null, eth_getLogs: { ewma: 5_000, tail: 9_000, error: 2, n: 1 } } },
    });
    expect(restored).toBe(true);
    // Latency is capped at the attempt deadline and the error rate at 1.
    expect(scoreboard.books()).toEqual([
      { id: "a", method: "eth_getLogs", stat: { ewma: 1_000, tail: 1_000, error: 1, n: 1 }, at: NOW },
    ]);
    expect(setup().warm.restore({ version: 1, savedAt: NOW, endpoints: { "label-a": { "*": "book" } } })).toBe(false);
  });

  test("a numeric timer handle, as browsers return, arms the save without unref", () => {
    vi.spyOn(Date, "now").mockReturnValue(50_000);
    const timers: { run: () => void; wait: number }[] = [];
    vi.stubGlobal("setTimeout", (run: () => void, wait: number): number => {
      timers.push({ run, wait });
      return timers.length;
    });
    const cleared: unknown[] = [];
    vi.stubGlobal("clearTimeout", (handle: unknown): void => void cleared.push(handle));
    const save = vi.fn();
    const { scoreboard, warm } = setup({ load: () => undefined, save, saveInterval: 2_500 });

    expect(warm.touch()).toBeUndefined();
    expect(timers.map((timer) => timer.wait)).toEqual([2_500]);
    // A later request before the due time leaves the armed timer alone.
    warm.touch();
    expect(timers).toHaveLength(1);
    expect(save).not.toHaveBeenCalled();

    scoreboard.success("a", "eth_call", 40, true);
    timers[0]?.run();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]?.[0]).toMatchObject({ version: 1, savedAt: NOW });

    // The timer fired, so the next request arms a new one and close clears that one.
    warm.touch();
    expect(timers).toHaveLength(2);
    warm.close();
    expect(cleared).toEqual([2]);
    expect(save).toHaveBeenCalledTimes(2);
  });
});

describe("localStoragePersistence edges", () => {
  test("storage that can be read but not written is not used at all", () => {
    const getItem = vi.fn(() => "stored");
    vi.stubGlobal("localStorage", { getItem });
    const persistence = localStoragePersistence("scores");
    expect(persistence.load()).toBeUndefined();
    expect(() => persistence.save({ version: 1, savedAt: NOW, endpoints: {} })).not.toThrow();
    expect(getItem).not.toHaveBeenCalled();

    const setItem = vi.fn();
    vi.stubGlobal("localStorage", { getItem, setItem });
    expect(persistence.load()).toBe("stored");
    persistence.save({ version: 1, savedAt: NOW, endpoints: {} });
    expect(setItem).toHaveBeenCalledWith("scores", JSON.stringify({ version: 1, savedAt: NOW, endpoints: {} }));
  });
});
