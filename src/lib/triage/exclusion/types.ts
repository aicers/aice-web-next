/**
 * Shared exclusion / normalization helper types (1B-1 / discussion #447 §3.4).
 *
 * The cadence runner (#481), the corpus B runner (#460), and the
 * retroactive-DELETE planner (#457) all consume this single helper
 * module so the same active exclusion set produces the same fingerprint
 * everywhere and the cadence-time / retroactive paths target the same
 * normalized columns. The module sits outside `src/lib/triage/policy/`
 * so the policy deprecatability seam (§6 of #447) stays intact.
 */

/**
 * Mirror of the GraphQL `HostNetworkGroupInput` membership shape: exact
 * IPs (`hosts`), CIDR `networks`, and inclusive IP `ranges`. The cadence
 * runner reads all three when matching the IpAddress exclusion against
 * `orig_addr` / `resp_addr` columns.
 */
export interface IpAddressExclusionInput {
  hosts: string[];
  networks: string[];
  ranges: { start: string; end: string }[];
}

/**
 * One stored exclusion. At least one of the four fields is non-null.
 * Multiple non-null fields on the same rule are flattened into
 * independent matchers that are OR-combined — same shape review-web
 * uses for `EventTriageExclusionInput`.
 */
export interface ExclusionRule {
  ipAddress?: IpAddressExclusionInput | null;
  /**
   * Domain regex patterns. The patterns are validated at INSERT time
   * against the Rust ∩ JS intersection grammar (see `validateDomainPattern`)
   * so cadence-time matching cannot diverge from review-web's Stage 1
   * regex matching on stored patterns.
   */
  domain?: string[] | null;
  hostname?: string[] | null;
  uri?: string[] | null;
}

/**
 * The active exclusion set the cadence runner re-applies in step (c) of
 * the per-page pipeline. Pre-#457 this is always empty; once #457 wires
 * real global / customer-scoped storage, the same shape carries the
 * union of (global, customer-scoped) rules without changing the
 * helper's surface.
 */
export interface ActiveExclusionSet {
  rules: ExclusionRule[];
}

/**
 * Per-event normalized exclusion-matching columns. Populated by
 * `normalizeEventColumns` from a `TriageEvent` per the event-kind
 * mapping documented in this issue (#481):
 *
 *   - HTTP variants: `host`, `uri`
 *   - TLS variants: `host` ← `serverName`
 *   - DNS variants: `dnsQuery` ← `query`
 *   - NTLM IP-only carve-out: `host` / `dnsQuery` / `uri` left NULL
 *     (anchored in aicers/review-database#723)
 *   - Other event kinds: nothing (only addresses populated)
 *
 * `origAddr` / `respAddr` are pulled from the same fields as the
 * pivot dimensions; they back the IpAddress exclusion's CIDR / range /
 * exact-host containment.
 */
export interface NormalizedEventColumns {
  origAddr: string | null;
  respAddr: string | null;
  host: string | null;
  dnsQuery: string | null;
  uri: string | null;
}
