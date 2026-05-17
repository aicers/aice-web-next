/**
 * Phase 1.B selector membership lists (RFC 0001 §9).
 *
 * Two source-code lists referenced by the §3 selectors and §4 slot
 * allocator. Stored next to the cadence so changing them produces a
 * single visible diff and forces a `baseline_version` bump (§10) at the
 * same time.
 *
 *   * `CRITICAL_CATEGORIES` — S2 fires when
 *     `category(event) ∈ CRITICAL_CATEGORIES`.
 *   * `FAVORED_BUCKETS`     — §4 slot allocator adds the constant `β`
 *     bonus per favored bucket.
 *
 * Values are the calibrated set from ops review (PR 2 / #513). The
 * `CRITICAL_CATEGORIES` set is anchored on the kill-chain stages that
 * Phase 1.A's whitelist already gave a constant `+1.0` bonus to (the
 * highest-priority operator-relevant stages); under Phase 1.B those same
 * categories flip the S2 binary selector. `FAVORED_BUCKETS` is the five
 * kinds documented in RFC §5 (DnsCovertChannel, unlabeled HttpThreat,
 * LockyRansomware, RepeatedHttpSessions, SuspiciousTlsTraffic),
 * expressed in `(kind, is_unlabeled)` `slot_bucket` form per §4.
 */

import { CRITICAL_CATEGORIES as CRITICAL_CATEGORIES_RAW } from "@/lib/triage/story/critical-sets.mjs";

/**
 * Category membership for the S2 "severe" selector (RFC 0001 §3).
 * Anchored on the five kill-chain stages Phase 1.A's whitelist already
 * elevated (`PHASE_1A_WHITELIST_SCORE` in `src/lib/triage/scoring.ts`).
 * Phase 1.B promotes them from an additive bonus into the dedicated S2
 * binary selector.
 *
 * Re-exported from `story/critical-sets.mjs` so the cadence layer, the
 * rule layer, and the harness `.mjs` all read the same source of truth
 * (issue #601). The TS-side typing is preserved via the sibling `.d.ts`
 * declaration.
 */
export const CRITICAL_CATEGORIES = CRITICAL_CATEGORIES_RAW;

/**
 * Bucket-identifier membership for the §4 slot allocator's favored-kind
 * constant bonus (`β`). Buckets are encoded as `"<kind>:<is_unlabeled>"`
 * strings so the read-time slot allocator can look them up by the same
 * tuple it derives per event.
 *
 * Per RFC §5 the five empirically-useful kinds are
 * DnsCovertChannel, unlabeled HttpThreat, LockyRansomware,
 * RepeatedHttpSessions, and SuspiciousTlsTraffic. "Unlabeled HttpThreat"
 * is the virtual `('HttpThreat', true)` slot_bucket (§4); all others
 * are `(kind, false)`.
 */
export const FAVORED_BUCKETS: ReadonlySet<string> = new Set([
  "DnsCovertChannel:false",
  "HttpThreat:true",
  "LockyRansomware:false",
  "RepeatedHttpSessions:false",
  "SuspiciousTlsTraffic:false",
]);
