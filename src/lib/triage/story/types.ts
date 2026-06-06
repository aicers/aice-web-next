import type { ThreatCategory } from "@/lib/detection";

/**
 * Sort axis for the Stories list — pushed down to SQL so the
 * post-LIMIT page never silently scopes the toggle to a stale first
 * page. Default is `"time-window-end"` (most recent first); the
 * `"score"` variant uses the same `(score DESC NULLS LAST,
 * time_window_end DESC, id DESC)` ordering at SQL and merge time.
 */
export type StoriesSortOrder = "time-window-end" | "score";

/**
 * Hard cap on the number of Stories the read path returns per period.
 * Larger than the Asset list (#458) page size because the Story list
 * is a flatter view (one row per cluster, not per asset), but bounded
 * so the cross-tenant fanout cannot stampede the React render.
 */
export const TRIAGE_STORY_PAGE_SIZE = 200;

/**
 * Heuristic correlation rule identifiers persisted on
 * `event_group.correlation_rule_id`. `'R2'` is reserved by #489 for
 * the v2 kill-chain RFC bump and is intentionally absent from the
 * surface. `'R4'` (fan-in) and `'R5'` (campaign) are the
 * multi-source rules added by #694 — both additive new
 * `correlation_rule_id` values that keep `story_version = 'v1'`.
 *
 * NOTE: kept in sync with the `ACTIVE_RULE_IDS` tuple in
 * `./rules.ts` (the two definitions are intentionally duplicated;
 * single-sourcing is a separate follow-up).
 */
export type StoryRuleId = "R1" | "R3" | "R4" | "R5";

/**
 * `event_group.kind` discriminator. Auto-correlated rows are produced
 * by the cadence-side correlator (#489); analyst-curated rows are
 * produced by Pivot → "Save as Story" (#490).
 */
export type StoryKind = "auto_correlated" | "analyst_curated";

/**
 * Fixed-key shape of `event_group.summary_payload` (Story RFC §7).
 *
 * Required keys are stable across `story_version` for the v1 cohort.
 * `manualTitle` is an OPTIONAL key that #490 introduces — written only
 * on analyst-curated rows whose save provided a non-blank title.
 * Absence (not an empty string) means "fall back to the auto-
 * generated title".
 */
export interface StorySummaryPayload {
  kindHistogram: Record<string, number>;
  categoryHistogram: Record<string, number>;
  memberCount: number;
  durationMs: number;
  distinctAssetCount: number;
  topRawScore: number;
  manualTitle?: string;
}

/**
 * Single Story row surfaced to the UI. The composite identity is
 * `(customerId, storyId)` — `event_group.id` is `BIGSERIAL` per tenant
 * DB and is NOT globally unique.
 */
export interface TriageStory {
  /** Tenant owning the row. Required for every read / write path. */
  customerId: number;
  /** Display name of the customer. Resolved once per request from `customers`. */
  customerName: string;
  /** `event_group.id` rendered as a decimal string (BIGSERIAL). */
  storyId: string;
  kind: StoryKind;
  /** `null` for analyst-curated rows. */
  ruleId: StoryRuleId | null;
  storyVersion: string;
  timeWindowStartIso: string;
  timeWindowEndIso: string;
  /** INET literal; `null` only for curated Stories without an asset. */
  primaryAsset: string | null;
  /** `event_group.score`. `null` for curated rows without an explicit score. */
  score: number | null;
  summary: StorySummaryPayload;
  createdAtIso: string;
  /**
   * β-style "Sent to aimer-web" indicator. #493 writes this column; #490
   * reads and renders it. `null` when the row has never been submitted.
   */
  lastSentAtIso: string | null;
  /** Cumulative count of submissions to aimer-web. `0` until #493 fires. */
  sendCount: number;
  /** Top-3 member preview. Aged-out members are silently absent. */
  topMembers: TriageStoryMemberPreview[];
}

/**
 * Slim preview row for the top-3 member list on a Story card. Sort
 * key is `raw_score DESC, event_time DESC` — see #490's "Top-3 event
 * preview" subsection.
 */
export interface TriageStoryMemberPreview {
  eventKey: string;
  eventTimeIso: string;
  kind: string;
  category: ThreatCategory | string | null;
  rawScore: number;
}

/**
 * Detail-panel row for a single Story member. Joined view of
 * `event_group_member` ⨝ `baseline_triaged_event`, with the read-time
 * `baseline_score` (`cume_dist()` over `(kind, baseline_version)`).
 */
export interface TriageStoryMemberDetail {
  eventKey: string;
  eventTimeIso: string;
  kind: string;
  sensor: string;
  origAddr: string | null;
  respAddr: string | null;
  origPort: number | null;
  respPort: number | null;
  host: string | null;
  dnsQuery: string | null;
  uri: string | null;
  category: ThreatCategory | string | null;
  /** `null` for members whose `event_time` falls outside the menu
   *  period — those events still exist in corpus A (so the
   *  dangling-member contract does not flag them) but the read-time
   *  `cume_dist()` cohort doesn't cover them, so a meaningful
   *  baseline_score is not defined. The UI renders `—`. */
  baselineScore: number | null;
  /** `baseline_version` from `baseline_triaged_event`. Threaded
   *  through to the pivot adapter so the Phase 1 engagement
   *  capture (#588) can fire `story_pivot_click` rows — the action
   *  shape CHECK requires `baseline_version` for row-bound actions. */
  baselineVersion: string;
  /**
   * Story-protected marker eligibility (#471 §3). `true` when the
   * member would render the chain-link marker on the Story-detail
   * member row, per the four-condition rule:
   *   (a) slider != "all" (i.e. cutoff > 0)
   *   (b) `baselineScore` is non-NULL
   *   (c) `baselineScore < cutoff`
   *   (d) the member is a Story member — always true here, since this
   *       shape comes from `event_group_member ⨝ baseline_triaged_event`.
   * Out-of-period members carry `baselineScore === null` and stay
   * silent (condition (b) fails). The flag is computed against the
   * strictness cutoff threaded through `loadStoryDetail` so the Story-
   * detail surface honors the same rule the asset-detail and pivot
   * surfaces do.
   */
  protectedByStory: boolean;
}

/**
 * Errors returned by the curated-save server action.
 *
 *   - `OVER_CAP` — `memberEventKeys.length > STORY_MEMBER_CAP`
 *   - `EMPTY` — `memberEventKeys.length < 1`
 *   - `MEMBER_NOT_FOUND` — at least one `event_key` does not resolve
 *     in the resolved customer's `baseline_triaged_event` (the
 *     cross-tenant case where the key exists in a different tenant is
 *     this same error, not a separate code)
 *   - `ASSET_MISMATCH` — `primaryAsset` matches no resolved member's
 *     `orig_addr`
 *   - `CUSTOMER_OUT_OF_SCOPE` — `customerId` is not in the caller's
 *     session effective scope
 *   - `MULTI_CUSTOMER_NOT_ALLOWED` — defensive case: the input
 *     attempted to mix members from multiple customers (UI prevents,
 *     server enforces)
 */
export type SaveCuratedStoryError =
  | { code: "OVER_CAP"; cap: number; received: number }
  | { code: "EMPTY" }
  | { code: "MEMBER_NOT_FOUND"; missingEventKeys: string[] }
  | { code: "ASSET_MISMATCH"; primaryAsset: string }
  | { code: "CUSTOMER_OUT_OF_SCOPE"; customerId: number }
  | { code: "MULTI_CUSTOMER_NOT_ALLOWED" };

export type SaveCuratedStoryResult =
  | { ok: true; customerId: number; storyId: string }
  | { ok: false; error: SaveCuratedStoryError };

/**
 * Input contract for the curated-save server action. Defined here
 * (alongside the result/error types) so a client component can import
 * the shape without crossing the `server-only` boundary the server
 * helper carries.
 *
 * `memberCustomerIds` is a parallel array to `memberEventKeys` —
 * `memberCustomerIds[i]` is the tenant-of-origin for `memberEventKeys[i]`
 * as observed by the analyst's pivot focus. The server enforces that
 * every entry equals `customerId`, returning `MULTI_CUSTOMER_NOT_ALLOWED`
 * on any mismatch. This is what makes the server's defensive
 * single-tenant guard reachable: without per-member provenance the
 * server resolves keys against exactly one tenant pool and the
 * cross-tenant case collapses into `MEMBER_NOT_FOUND`.
 */
export interface SaveCuratedStoryInput {
  customerId: number;
  memberEventKeys: string[];
  memberCustomerIds: number[];
  primaryAsset: string;
  title?: string;
}

/**
 * Composite key encoded in the Stories tab URL hash
 * (`#triage.story=<customerId>/<storyId>`). The `customerId` half is
 * mandatory because `event_group.id` is `BIGSERIAL` per tenant DB and
 * a bare `storyId` cannot be resolved unambiguously across the
 * caller's customer scope. A hash carrying a bare `storyId` (from an
 * older URL shape) parses with `customerId = null`; the consumer
 * surfaces the stale-hash toast and falls back to the Stories list
 * root.
 */
export interface TriageStoryFocus {
  customerId: number | null;
  storyId: string;
}
