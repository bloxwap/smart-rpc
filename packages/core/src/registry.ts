/** Source-backed, keyless HTTP RPC used by a chain's default transport. */
export interface PublicRpcEndpoint {
  /** Stable registry identifier; transports may retain their existing public labels. */
  readonly id: string;
  readonly url: string;
  readonly provider: string;
  /** Provider or protocol documentation establishing public access. */
  readonly sourceUrls: readonly string[];
  /** Date the documentation was reviewed, not an uptime guarantee. */
  readonly reviewedAt: string;
  /** Conservative client request budget, including identity checks and probes. */
  readonly rps: number;
  readonly burst: number;
  /** Methods this endpoint must never receive. */
  readonly unsupportedMethods?: readonly string[] | undefined;
}
