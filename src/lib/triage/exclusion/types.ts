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
 *
 * `snapshotRows` is the audit-grade payload (#472): one entry per
 * stored exclusion row that contributed to `rules`, annotated with
 * the `scope_first_observed` label so the corpus runner can emit an
 * `exclusion_snapshot` payload alongside the fingerprint. The
 * fingerprint itself does NOT hash this field — it stays a function
 * of the matcher-equivalent `(kind, value)` content per
 * `computeExclusionsFingerprint`, so a rule that later flips between
 * `global` and `customer` scope does not bump the fingerprint
 * (matches `compileStoredRowsToActiveSet`'s cross-scope dedup, per
 * #457).
 *
 * Resolvers that do not know about stored rows (the empty default,
 * tests) leave `snapshotRows` undefined; the corpus runner falls back
 * to an empty payload so the snapshot column stays NOT NULL.
 */
export interface ActiveExclusionSet {
  rules: ExclusionRule[];
  snapshotRows?: readonly StoredExclusionSnapshotInput[];
}

/**
 * Upstream `{ scope, kind, value }` row shape used by the audit
 * snapshot writer (#472). The matcher does not consume this — the
 * shared helper produces `rules` and `snapshotRows` from the same
 * stored input so the two cannot drift.
 */
export interface StoredExclusionSnapshotInput {
  scope: "global" | "customer";
  kind: "ipAddress" | "hostname" | "uri" | "domain";
  value: string;
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
