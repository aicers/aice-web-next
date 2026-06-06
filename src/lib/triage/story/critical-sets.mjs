// Node-safe critical-category / critical-selector constants for the
// Story cadence layer (issue #601 §"MEASURED_QUERIES registration").
//
// Single source of truth for two constants that the cadence layer, the
// rule layer, and the measurement harness all need:
//
//   * `CRITICAL_CATEGORIES` — the category set R1's per-page candidate
//     scan filters on (`category = ANY($::text[])`).
//   * `CRITICAL_SELECTOR_SET` — the selector set R3's per-page scan
//     filters on (`selector_tags && $::text[]`).
//
// Why `.mjs` and not `.ts`: the measurement harness lives in
// `scripts/measure-baseline-read-path.mjs` and loads
// `src/lib/triage/baseline/read-path-sql.mjs` from plain Node. The
// MEASURED_QUERIES entries for R1 / R3 phase-1 / R3 phase-2 reference
// these two constants when binding `$N`, so the constants must be
// loadable from plain Node — a direct `.ts` import would break the
// harness, and `baseline/categories.ts` additionally pulls
// `@/lib/detection` (Next-runtime aware) which a Node import cannot
// resolve. The TS modules (`baseline/categories.ts`,
// `story/rules.ts`) re-export the values from here so the cadence and
// rule layers continue to read identical strings.
//
// String values are hand-mirrored from `ThreatCategory` (in
// `@/lib/detection`) and from `SELECTOR_TAGS` (in
// `baseline/tunables.ts`). Both are version-stamped by
// `baseline_version` (RFC 0001 §10), so changing them is already a
// bump-the-version change; updating the two strings here at the same
// time is part of that change.

/**
 * Category membership for R1's per-page SQL filter and for the S2
 * "severe" selector (RFC 0001 §3 / Story RFC §3.R1). Anchored on the
 * five kill-chain stages Phase 1.A's whitelist already elevated.
 *
 * @type {ReadonlySet<string>}
 */
export const CRITICAL_CATEGORIES = new Set([
  "COMMAND_AND_CONTROL",
  "CREDENTIAL_ACCESS",
  "EXFILTRATION",
  "IMPACT",
  "INITIAL_ACCESS",
]);

/**
 * Selector membership for R3's per-page SQL filter (Story RFC §3.R3).
 * The v1 starting set is the two §9 tags whose semantics map to
 * "critical-class" rather than "frequency/correlation pattern".
 *
 * @type {ReadonlySet<string>}
 */
export const CRITICAL_SELECTOR_SET = new Set([
  "S2-severe",
  "unlabeled-cluster",
]);

// ── Multi-source rule thresholds (R4 / R5, issue #694) ────────────
//
// The R4/R5 phase-1 SQL binds these as `$N` parameters, and the
// measurement harness (`scripts/measure-baseline-read-path.mjs`,
// plain Node) supplies them when probing candidate keys. Like the
// sets above they must be loadable from plain Node, so they live here
// and `story/rules.ts` re-exports them as the rule-layer tunables.

/**
 * R4 (fan-in) — minimum distinct source IPs converging on one victim
 * with the same critical category inside the window.
 *
 * @type {number}
 */
export const R4_MIN_SOURCES = 3;

/**
 * R5 (campaign) — minimum distinct source IPs driving the same
 * critical category inside the window.
 *
 * @type {number}
 */
export const R5_MIN_SOURCES = 5;

/**
 * R5 (campaign) — minimum distinct victims the campaign must span.
 * The ≥2-victims floor is what separates a campaign from an R4
 * fan-in.
 *
 * @type {number}
 */
export const R5_MIN_VICTIMS = 2;
