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
 * Both ship empty in PR 1 (this file). PR 2 populates them with ops
 * sign-off and wires them into the four-selector scoring + slot
 * allocation paths. Until PR 2 lands, the cadence keeps using the
 * Phase 1.A scoring rule from `src/lib/triage/scoring.ts`.
 *
 * Why the lists live in source code and not in the database:
 *   * The values are part of the algorithm contract (`baseline_version`)
 *     and must be reviewable in a PR diff alongside the code that reads
 *     them. A runtime-mutable table would make audit-time reproduction
 *     (§10) require joining against a history snapshot.
 *   * The lists are small (handful of enum members) — there is no
 *     scaling reason to keep them out of the binary.
 */

import type { ThreatCategory } from "@/lib/detection";

/**
 * Category membership for the S2 "severe" selector (RFC 0001 §3).
 * Populated in PR 2 once ops have signed off on the kill-chain stage
 * subset that should always fire S2.
 */
export const CRITICAL_CATEGORIES: ReadonlySet<ThreatCategory> = new Set();

/**
 * Bucket-identifier membership for the §4 slot allocator's favored-kind
 * constant bonus (`β`). Buckets are identified by their `(kind, sensor)`
 * pair-string per §4; PR 2 fills the set with the operator-relevant
 * (kind, sensor) tuples and wires the lookup into the slot allocator.
 */
export const FAVORED_BUCKETS: ReadonlySet<string> = new Set();
