import {
  blockNumberFromResult,
  evmCachePolicy,
  isAlreadyKnownError,
  isBlockNotHeldError,
  isIdempotentMethod,
  isRebroadcastMethod,
  parseQuantity,
  shouldFailover,
  type ChainPolicy,
  type PinLatestOptions,
  type PoolEndpointConfig,
  type PoolOptions,
  type RpcPool,
} from "../src/index.js";
import { createPool } from "../src/pool.js";

export function evmPolicy(chainId = 1, pin: boolean | PinLatestOptions = false): ChainPolicy {
  return {
    chainIds: [`eip155:${chainId}`],
    probeMethod: "eth_blockNumber",
    probeParams: [],
    parseHead: parseQuantity,
    headFromResult: blockNumberFromResult,
    identityMethod: "eth_chainId",
    identityParams: [],
    expectedIdentity: chainId,
    parseIdentity: parseQuantity,
    isSafeMethod: (method) => isIdempotentMethod(method),
    isRebroadcastMethod,
    shouldFailover,
    isBenignMiss: isBlockNotHeldError,
    isAlreadyKnown: isAlreadyKnownError,
    cachePolicy: evmCachePolicy(),
    pin,
  };
}

export function pool(
  endpoints: readonly PoolEndpointConfig[],
  overrides: Partial<PoolOptions> = {},
  policy: ChainPolicy = evmPolicy(),
): RpcPool {
  return createPool({
    endpoints,
    policy,
    verifyIdentity: false,
    cache: false,
    coalesce: false,
    race: false,
    headLag: { probeInterval: false },
    ...overrides,
  });
}
