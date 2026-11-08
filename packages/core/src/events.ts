/**
 * Telemetry events emitted for each routed call.
 * Every `endpoint`, `from`, and `to` is the endpoint's public label.
 * @module
 */

import type { MethodStat } from "./score.js";

/** A listener receives one of these for every routing decision it asked to see. */
export type RpcEvent =
  | {
      type: "request";
      endpoint: string;
      method: string;
    }
  | {
      type: "success";
      endpoint: string;
      method: string;
      latencyMs: number;
      hedged: boolean;
    }
  | {
      type: "error";
      endpoint: string;
      method: string;
      latencyMs: number;
      error: Error;
      /** True when the error describes the call. The endpoint answered, so it is treated as healthy. */
      terminal?: boolean | undefined;
    }
  | {
      type: "failover";
      from: string;
      to: string;
      method: string;
    }
  | {
      type: "hedge";
      endpoint: string;
      method: string;
    }
  | {
      /** A safe read went to these endpoints at once, best score first. Each also gets a `request`. */
      type: "race";
      endpoints: string[];
      method: string;
    }
  | {
      /** The call joined an identical read already in flight and sent nothing of its own. */
      type: "coalesce";
      method: string;
    }
  | {
      type: "head";
      endpoint: string;
      head: number;
      best: number;
      lag: number;
      /** False when this head is ignored as implausible, or no reference head is believed yet. */
      trusted: boolean;
    }
  | {
      /** The chain check disagreed. The endpoint gets no more calls. */
      type: "quarantine";
      endpoint: string;
      reported: unknown;
      expected: unknown;
    }
  | {
      /** Consecutive failures or a `Retry-After` took the endpoint out of rotation. */
      type: "eject";
      endpoint: string;
      failures: number;
      cooldownMs: number;
      error: Error;
    }
  | {
      /** A healthy answer closed an ejected endpoint's circuit. */
      type: "restore";
      endpoint: string;
    }
  | {
      /** `persist.load` or `persist.save` failed, or loaded a snapshot that is not valid. Calls are unaffected. */
      type: "persist";
      operation: "load" | "save";
      error: Error;
    }
  | {
      /** A cacheable read hit memory, went upstream, or was re-read in the background. */
      type: "cache";
      method: string;
      outcome: "hit" | "miss" | "refresh";
      stale: number | null;
    };

/** One endpoint as the pool currently scores it. */
export interface EndpointSnapshot {
  id: string;
  url: string;
  weight: number;
  quarantined: boolean;
  ejected: boolean;
  inflight: number;
  /** Whole tokens left in the endpoint's request budget. Null when it has none. */
  tokens: number | null;
  head: number | null;
  lag: number | null;
  score: number;
  methods: Record<string, MethodStat>;
}
