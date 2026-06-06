import "server-only";

/**
 * Story persistence layer (Story RFC §5).
 *
 * Owns every write to `event_group` / `event_group_member` and the
 * `baseline_corpus_state.story_finalized_through` watermark UPDATE.
 * Pure SQL — no rule logic. The correlator (`./correlator.ts`) calls
 * into this module for each draft and for the per-page watermark
 * advance.
 *
 * Auto-correlated rows take the `ON CONFLICT DO NOTHING` path against
 * one of two partial unique indexes, selected by whether the draft
 * carries a `correlation_key`:
 *
 *   - R1/R3 (`correlation_key IS NULL`) →
 *     `(correlation_rule_id, primary_asset, time_window_start,
 *      time_window_end) WHERE kind = 'auto_correlated' AND
 *      primary_asset IS NOT NULL AND correlation_key IS NULL`
 *     (`event_group_auto_dedup_idx`, re-scoped by migration 0024).
 *   - R4/R5 (`correlation_key IS NOT NULL`) →
 *     `(correlation_rule_id, correlation_key, time_window_start,
 *      time_window_end) WHERE kind = 'auto_correlated' AND
 *      correlation_key IS NOT NULL`
 *     (`event_group_corrkey_dedup_idx`, added by migration 0024).
 *
 * A re-evaluated slop-window candidate therefore never produces a
 * duplicate `event_group` row.
 */

import type pg from "pg";
import type { ThreatCategory } from "@/lib/detection";
import { CRITICAL_CATEGORIES } from "@/lib/triage/baseline/categories";
import type { TriagePeriod } from "../period";
import {
  buildReadR1CandidatesSql,
  buildReadR2CandidatesPhase1Sql,
  buildReadR2CandidatesPhase2Sql,
  buildReadR3CandidatesPhase1Sql,
  buildReadR3CandidatesPhase2Sql,
  buildReadR4CandidatesPhase1Sql,
  buildReadR4CandidatesPhase2Sql,
  buildReadR5CandidatesPhase1Sql,
  buildReadR5CandidatesPhase2Sql,
  buildReadR6CandidatesPhase1Sql,
  buildReadR6CandidatesPhase2Sql,
  buildSelectStoriesForPeriodSql,
  SELECT_BASELINE_EVENTS_BY_KEY_SQL,
  SELECT_STORY_MEMBERS_DETAIL_SQL,
  SELECT_STORY_TOP_MEMBERS_SQL,
} from "./read-path-sql.mjs";
import type { CandidateEvent, StoryDraft, StorySummaryPayload } from "./rules";
import {
  applyMemberCap,
  buildSummaryPayload,
  CRITICAL_SELECTOR_SET,
  LOWSLOW_SELECTOR_SET,
  R4_MIN_SOURCES,
  R5_MIN_SOURCES,
  R5_MIN_VICTIMS,
  STORY_VERSION,
} from "./rules";
import type {
  StoriesSortOrder,
  StoryKind,
  StoryRuleId,
  TriageStory,
  TriageStoryMemberDetail,
  TriageStoryMemberPreview,
} from "./types";

export interface ReadCandidatesArgs {
  client: pg.PoolClient;
  /**
   * Inclusive lower bound on `event_time` for the member scan. Per
   * Story RFC §4 the scan window is
   * `[previous_watermark − max_rule_window, new_horizon]` so that an
   * R3 cluster whose `time_window_end` falls just past the previous
   * watermark can still pick up members that sit before the
   * watermark but inside the rule window. `null` means "no lower
   * bound" — used on the first tick (NULL watermark), where the
   * range degenerates to `(-∞, new_horizon]`.
   */
  memberScanStart: Date | null;
  /**
   * Upper bound on `event_time` for the member scan. Inclusive by
   * default — cadence calls with `newHorizon` and accepts drafts
   * whose `time_window_end == newHorizon`. The rebuild path passes
   * {@link endExclusive} `= true` so events at exactly `to` are kept
   * out of the candidate set; otherwise such an event can extend an
   * otherwise-eligible cluster's end to `to`, which the rebuild's
   * `[from, to)` finalization predicate then drops.
   */
  memberScanEnd: Date;
  /**
   * When true, use `event_time < memberScanEnd` instead of
   * `event_time <= memberScanEnd`. Defaults to false to preserve the
   * cadence call site's inclusive semantics.
   */
  endExclusive?: boolean;
}

interface CandidateRow {
  event_key: string;
  event_time: Date;
  kind: string;
  orig_addr: string | null;
  /** Present only on the R4/R5 multi-source candidate reads; absent
   *  (→ `null`) on the R1/R3 reads that do not select it. */
  resp_addr?: string | null;
  category: string | null;
  selector_tags: string[];
  raw_score: number;
}

function rowToCandidate(row: CandidateRow): CandidateEvent {
  return {
    eventKey: row.event_key,
    eventTime: row.event_time,
    kind: row.kind,
    origAddr: row.orig_addr,
    respAddr: row.resp_addr ?? null,
    category: row.category,
    selectorTags: row.selector_tags ?? [],
    rawScore: Number(row.raw_score),
  };
}

/**
 * R1's per-page candidate scan (Story RFC §3.R1, §5).
 *
 * Pushes the row-level predicate into SQL so the planner can use the
 * `(event_time DESC)` btree on the time range and a category-set
 * filter on `category`, instead of materializing the full range in
 * memory and filtering app-side. `orig_addr IS NOT NULL` is also
 * pushed down because R1 explicitly skips NULL-asset rows at the
 * predicate level (the partial unique index on `event_group` requires
 * a non-NULL `primary_asset`, so a NULL-asset cluster is unreachable
 * by construction).
 *
 *   SELECT ... FROM baseline_triaged_event
 *    WHERE event_time IN [memberScanStart, memberScanEnd]
 *      AND orig_addr IS NOT NULL
 *      AND category = ANY($criticalCategories::text[])
 *
 * Same-asset narrowing is a clustering operation across the returned
 * rows and stays in the rule layer (`rules.ts`). R1 is a single
 * SELECT (no candidate-asset pre-aggregation): the critical-category
 * set is small, so `category = ANY(...)` is enough to bound the
 * working set, and R1's per-cluster member threshold (≥2 distinct
 * categories) does not map to a `COUNT(*) >= N` pre-aggregation in
 * the way R3's ≥3-member threshold does.
 */
export async function readR1Candidates(
  args: ReadCandidatesArgs,
): Promise<CandidateEvent[]> {
  const { client, memberScanStart, memberScanEnd, endExclusive } = args;
  const categories = Array.from(CRITICAL_CATEGORIES) as ThreatCategory[];
  const sql = buildReadR1CandidatesSql({
    memberScanStartIsNull: memberScanStart === null,
    endExclusive: Boolean(endExclusive),
  });
  const params =
    memberScanStart === null
      ? [memberScanEnd, categories]
      : [memberScanStart, memberScanEnd, categories];
  const result = await client.query<CandidateRow>(sql, params);
  return result.rows.map(rowToCandidate);
}

/**
 * R3's per-page candidate scan (Story RFC §3.R3, §5).
 *
 * Two-phase per-asset access pattern, so the issue's measurement
 * gate has a concrete production-shape target for
 * `EXPLAIN ANALYZE` — specifically, the per-asset narrowing that
 * rides the existing `baseline_triaged_event_orig_addr_gist`
 * (`gist_inet_ops` supports `=`).
 *
 * Phase 1 — candidate-asset pre-aggregation:
 *
 *   SELECT host(orig_addr) AS orig_addr
 *     FROM baseline_triaged_event
 *    WHERE event_time IN [memberScanStart, memberScanEnd]
 *      AND orig_addr IS NOT NULL
 *      AND selector_tags && $criticalSelectors::text[]
 *    GROUP BY orig_addr
 *   HAVING COUNT(*) >= 3
 *
 * Phase 2 — per-asset member scan against the candidates phase 1
 * returned (this is the "R3 same-asset-1h" SELECT shape the issue
 * gate names):
 *
 *   SELECT ... FROM baseline_triaged_event
 *    WHERE event_time IN [memberScanStart, memberScanEnd]
 *      AND orig_addr = ANY($assets::inet[])
 *      AND selector_tags && $criticalSelectors::text[]
 *
 * The `orig_addr = ANY(...)` predicate is what the planner uses to
 * fan out into per-asset GiST index probes, instead of materializing
 * every critical-selector row in the tenant-wide scan range.
 * `COUNT(*) >= 3` matches R3's per-rule member threshold, so an
 * asset that cannot reach the threshold in this scan range is
 * dropped at phase 1 instead of paid for in phase 2. Same-asset
 * sliding-window clustering remains a rule-layer operation
 * (`clusterByWindow` in `rules.ts`); the SQL only narrows which
 * assets are read, not how their events cluster.
 *
 * If measurement at scale shows the planner cannot resolve
 * `selector_tags &&` efficiently in phase 1, a GIN index on
 * `selector_tags` is the additive follow-up named in the issue's
 * measurement-gate section — migration-only, no callsite churn.
 */
export async function readR3Candidates(
  args: ReadCandidatesArgs,
): Promise<CandidateEvent[]> {
  const { client, memberScanStart, memberScanEnd, endExclusive } = args;
  const selectors = Array.from(CRITICAL_SELECTOR_SET);
  const memberScanStartIsNull = memberScanStart === null;
  const endExclusiveBool = Boolean(endExclusive);

  const phase1Sql = buildReadR3CandidatesPhase1Sql({
    memberScanStartIsNull,
    endExclusive: endExclusiveBool,
  });
  const phase1Params = memberScanStartIsNull
    ? [memberScanEnd, selectors]
    : [memberScanStart, memberScanEnd, selectors];
  const phase1 = await client.query<{ orig_addr: string }>(
    phase1Sql,
    phase1Params,
  );
  // Mock query layers in unit tests reuse one handler for every
  // `FROM baseline_triaged_event` SELECT, so a result row carrying
  // duplicates is plausible there even though production phase-1
  // SQL is `GROUP BY orig_addr`. Dedupe here so the phase-2 ANY
  // array is well-formed regardless of caller.
  const assets = Array.from(
    new Set(phase1.rows.map((r) => r.orig_addr).filter((a) => a !== null)),
  );
  if (assets.length === 0) return [];

  const phase2Sql = buildReadR3CandidatesPhase2Sql({
    memberScanStartIsNull,
    endExclusive: endExclusiveBool,
  });
  const phase2Params = memberScanStartIsNull
    ? [memberScanEnd, assets, selectors]
    : [memberScanStart, memberScanEnd, assets, selectors];
  const result = await client.query<CandidateRow>(phase2Sql, phase2Params);
  return result.rows.map(rowToCandidate);
}

/**
 * R4's per-page candidate scan (Story RFC §3.R4, §5, issue #694).
 *
 * Two-phase per-victim access pattern mirroring R3. Phase 1
 * pre-aggregates candidate victims:
 *
 *   SELECT host(resp_addr) AS resp_addr, category
 *     FROM baseline_triaged_event
 *    WHERE event_time IN [memberScanStart, memberScanEnd]
 *      AND orig_addr IS NOT NULL AND resp_addr IS NOT NULL
 *      AND category = ANY($criticalCategories::text[])
 *      AND selector_tags && $criticalSelectors::text[]
 *    GROUP BY resp_addr, category
 *   HAVING COUNT(DISTINCT orig_addr) >= R4_MIN_SOURCES
 *
 * Phase 2 reads the member rows for the candidate victims via
 * `resp_addr = ANY($::inet[])`, riding the existing
 * `baseline_triaged_event_resp_addr_gist` (`gist_inet_ops` supports
 * `=`). Final `(resp_addr, category)` grouping, sliding-window
 * clustering, and the distinct-source threshold stay in `rules.ts`.
 */
export async function readR4Candidates(
  args: ReadCandidatesArgs,
): Promise<CandidateEvent[]> {
  const { client, memberScanStart, memberScanEnd, endExclusive } = args;
  const categories = Array.from(CRITICAL_CATEGORIES) as ThreatCategory[];
  const selectors = Array.from(CRITICAL_SELECTOR_SET);
  const memberScanStartIsNull = memberScanStart === null;
  const endExclusiveBool = Boolean(endExclusive);

  const phase1Sql = buildReadR4CandidatesPhase1Sql({
    memberScanStartIsNull,
    endExclusive: endExclusiveBool,
  });
  const phase1Params = memberScanStartIsNull
    ? [memberScanEnd, categories, selectors, R4_MIN_SOURCES]
    : [memberScanStart, memberScanEnd, categories, selectors, R4_MIN_SOURCES];
  const phase1 = await client.query<{
    resp_addr: string | null;
    category: string | null;
  }>(phase1Sql, phase1Params);
  const victims = Array.from(
    new Set(
      phase1.rows
        .map((r) => r.resp_addr)
        .filter((a): a is string => typeof a === "string" && a.length > 0),
    ),
  );
  if (victims.length === 0) return [];

  const phase2Sql = buildReadR4CandidatesPhase2Sql({
    memberScanStartIsNull,
    endExclusive: endExclusiveBool,
  });
  const phase2Params = memberScanStartIsNull
    ? [memberScanEnd, victims, categories, selectors]
    : [memberScanStart, memberScanEnd, victims, categories, selectors];
  const result = await client.query<CandidateRow>(phase2Sql, phase2Params);
  return result.rows.map(rowToCandidate);
}

/**
 * R5's per-page candidate scan (Story RFC §3.R5, §5, issue #694).
 *
 * Two-phase per-signature access pattern. Phase 1 pre-aggregates
 * candidate categories:
 *
 *   SELECT category
 *     FROM baseline_triaged_event
 *    WHERE event_time IN [memberScanStart, memberScanEnd]
 *      AND orig_addr IS NOT NULL AND resp_addr IS NOT NULL
 *      AND category = ANY($criticalCategories::text[])
 *      AND selector_tags && $criticalSelectors::text[]
 *    GROUP BY category
 *   HAVING COUNT(DISTINCT orig_addr) >= R5_MIN_SOURCES
 *      AND COUNT(DISTINCT resp_addr) >= R5_MIN_VICTIMS
 *
 * The `COUNT(DISTINCT resp_addr)` clause enforces the ≥2-victims
 * floor that separates a campaign from an R4 fan-in. Phase 2 reads
 * the member rows for the candidate categories via
 * `category = ANY($::text[])`. Final per-category grouping,
 * sliding-window clustering, and the source/victim thresholds stay
 * in `rules.ts`.
 */
export async function readR5Candidates(
  args: ReadCandidatesArgs,
): Promise<CandidateEvent[]> {
  const { client, memberScanStart, memberScanEnd, endExclusive } = args;
  const categories = Array.from(CRITICAL_CATEGORIES) as ThreatCategory[];
  const selectors = Array.from(CRITICAL_SELECTOR_SET);
  const memberScanStartIsNull = memberScanStart === null;
  const endExclusiveBool = Boolean(endExclusive);

  const phase1Sql = buildReadR5CandidatesPhase1Sql({
    memberScanStartIsNull,
    endExclusive: endExclusiveBool,
  });
  const phase1Params = memberScanStartIsNull
    ? [memberScanEnd, categories, selectors, R5_MIN_SOURCES, R5_MIN_VICTIMS]
    : [
        memberScanStart,
        memberScanEnd,
        categories,
        selectors,
        R5_MIN_SOURCES,
        R5_MIN_VICTIMS,
      ];
  const phase1 = await client.query<{ category: string | null }>(
    phase1Sql,
    phase1Params,
  );
  const campaignCategories = Array.from(
    new Set(
      phase1.rows
        .map((r) => r.category)
        .filter((c): c is string => typeof c === "string" && c.length > 0),
    ),
  );
  if (campaignCategories.length === 0) return [];

  const phase2Sql = buildReadR5CandidatesPhase2Sql({
    memberScanStartIsNull,
    endExclusive: endExclusiveBool,
  });
  const phase2Params = memberScanStartIsNull
    ? [memberScanEnd, campaignCategories, selectors]
    : [memberScanStart, memberScanEnd, campaignCategories, selectors];
  const result = await client.query<CandidateRow>(phase2Sql, phase2Params);
  return result.rows.map(rowToCandidate);
}

/**
 * R6's low-and-slow candidate scan (issue #701).
 *
 * Two-phase per-asset access pattern mirroring R3, but bound with the
 * R6 selector set (`LOWSLOW_SELECTOR_SET = CRITICAL_SELECTOR_SET ∪
 * {S3-recurring}`) and with an additional UTC-hour dispersion floor in
 * phase 1:
 *
 *   SELECT host(orig_addr) AS orig_addr
 *     FROM baseline_triaged_event
 *    WHERE event_time IN [memberScanStart, memberScanEnd]
 *      AND orig_addr IS NOT NULL
 *      AND selector_tags && $lowslowSelectors::text[]
 *    GROUP BY orig_addr
 *   HAVING COUNT(*) >= 3
 *      AND COUNT(DISTINCT date_trunc('hour', event_time AT TIME ZONE 'UTC')) >= 3
 *
 * Phase 2 reads the member rows for the candidate assets via
 * `orig_addr = ANY($::inet[])`. The 24h sliding-window cluster, member
 * floor, and hour-bucket dispersion are re-applied in the rule layer
 * (`detectR6`). Called only from the low-and-slow sweep
 * (`baseline/lowslow-sweep.ts`); the sweep always passes a non-null
 * `memberScanStart` (`watermark − 24h`).
 */
export async function readR6Candidates(
  args: ReadCandidatesArgs,
): Promise<CandidateEvent[]> {
  const { client, memberScanStart, memberScanEnd, endExclusive } = args;
  const selectors = Array.from(LOWSLOW_SELECTOR_SET);
  const memberScanStartIsNull = memberScanStart === null;
  const endExclusiveBool = Boolean(endExclusive);

  const phase1Sql = buildReadR6CandidatesPhase1Sql({
    memberScanStartIsNull,
    endExclusive: endExclusiveBool,
  });
  const phase1Params = memberScanStartIsNull
    ? [memberScanEnd, selectors]
    : [memberScanStart, memberScanEnd, selectors];
  const phase1 = await client.query<{ orig_addr: string }>(
    phase1Sql,
    phase1Params,
  );
  const assets = Array.from(
    new Set(phase1.rows.map((r) => r.orig_addr).filter((a) => a !== null)),
  );
  if (assets.length === 0) return [];

  const phase2Sql = buildReadR6CandidatesPhase2Sql({
    memberScanStartIsNull,
    endExclusive: endExclusiveBool,
  });
  const phase2Params = memberScanStartIsNull
    ? [memberScanEnd, assets, selectors]
    : [memberScanStart, memberScanEnd, assets, selectors];
  const result = await client.query<CandidateRow>(phase2Sql, phase2Params);
  return result.rows.map(rowToCandidate);
}

/**
 * R2's multi-stage low-and-slow candidate scan (issue #702).
 *
 * Two-phase per-asset access pattern mirroring R6, but keyed on
 * `category` rather than the R6 selector set — the "slow R1". Phase 1
 * carries BOTH a distinct-category floor AND the same UTC-hour
 * dispersion floor R6 uses:
 *
 *   SELECT host(orig_addr) AS orig_addr
 *     FROM baseline_triaged_event
 *    WHERE event_time IN [memberScanStart, memberScanEnd]
 *      AND orig_addr IS NOT NULL
 *      AND category IS NOT NULL
 *    GROUP BY orig_addr
 *   HAVING COUNT(DISTINCT date_trunc('hour', event_time AT TIME ZONE 'UTC')) >= 3
 *      AND COUNT(DISTINCT category) >= 3
 *
 * R2 keys on `category IS NOT NULL` (far broader than R6's
 * `selector_tags && LOWSLOW_SELECTOR_SET`), so the phase-1 pushdown is
 * mandatory to keep phase 2 bounded. Phase 2 reads the member rows for
 * the candidate assets via `orig_addr = ANY($::inet[])`, also carrying
 * `AND category IS NOT NULL` so null-category rows the rule layer would
 * only discard are never read. The 24h sliding-window cluster, the
 * distinct-category gate, hour-bucket dispersion, and the ≥1-critical
 * guard are re-applied in the rule layer (`detectR2`). Called only from
 * the low-and-slow sweep (`baseline/lowslow-sweep.ts`); the sweep always
 * passes a non-null `memberScanStart` (`watermark − 24h`).
 */
export async function readR2Candidates(
  args: ReadCandidatesArgs,
): Promise<CandidateEvent[]> {
  const { client, memberScanStart, memberScanEnd, endExclusive } = args;
  const memberScanStartIsNull = memberScanStart === null;
  const endExclusiveBool = Boolean(endExclusive);

  const phase1Sql = buildReadR2CandidatesPhase1Sql({
    memberScanStartIsNull,
    endExclusive: endExclusiveBool,
  });
  const phase1Params = memberScanStartIsNull
    ? [memberScanEnd]
    : [memberScanStart, memberScanEnd];
  const phase1 = await client.query<{ orig_addr: string }>(
    phase1Sql,
    phase1Params,
  );
  const assets = Array.from(
    new Set(phase1.rows.map((r) => r.orig_addr).filter((a) => a !== null)),
  );
  if (assets.length === 0) return [];

  const phase2Sql = buildReadR2CandidatesPhase2Sql({
    memberScanStartIsNull,
    endExclusive: endExclusiveBool,
  });
  const phase2Params = memberScanStartIsNull
    ? [memberScanEnd, assets]
    : [memberScanStart, memberScanEnd, assets];
  const result = await client.query<CandidateRow>(phase2Sql, phase2Params);
  return result.rows.map(rowToCandidate);
}

export interface InsertAutoStoryResult {
  /** Newly-inserted `event_group.id`, or `null` when the partial
   *  unique index suppressed the insert (idempotent replay). */
  groupId: string | null;
}

/**
 * β-style submission tracking carried over from a pre-rebuild auto
 * Story whose natural key matches the new draft (#565). The cadence
 * path leaves this `undefined` so the columns take their DEFAULT
 * (NULL / 0 / NULL); the rebuild service joins the new drafts against
 * the pre-rebuild snapshot on
 * `(correlation_rule_id, primary_asset, time_window_start, time_window_end)`
 * and copies the matching row's values so the operator's
 * "already-analyzed" awareness persists across a rules-changed
 * recompute.
 */
export interface AutoStoryBetaCarryOver {
  lastSentAt: Date | null;
  sendCount: number;
  lastSentBy: string | null;
}

/**
 * INSERT one auto-correlated `event_group` row plus its members in
 * the caller's open transaction. Returns the new group id, or
 * `null` when the partial unique index suppressed the INSERT — the
 * caller treats `null` as "already-finalized, nothing to do".
 *
 * Members are written via a single batched VALUES INSERT against
 * `event_group_member`. The composite PK `(event_group_id, event_key)`
 * makes the path idempotent under retry against a successfully-
 * INSERTed parent.
 *
 * The optional `carryOver` argument is consumed by the rebuild path
 * (#565). When provided, the β columns
 * (`last_sent_at` / `send_count` / `last_sent_by`) are written from
 * the carry-over values instead of the column DEFAULTs, so a rebuilt
 * Story that matches a pre-rebuild row on the natural key inherits
 * the operator's submission tracking.
 */
export async function insertAutoStory(
  client: pg.PoolClient,
  draft: StoryDraft,
  carryOver?: AutoStoryBetaCarryOver,
): Promise<InsertAutoStoryResult> {
  const correlationKey = draft.correlationKey ?? null;
  // Branch the ON CONFLICT arbiter by whether the draft carries a
  // `correlation_key`, NOT by rule id. R1/R3 (`correlation_key
  // IS NULL`) dedup on the legacy asset index; R4/R5
  // (`correlation_key IS NOT NULL`) dedup on the new
  // `correlation_key` index. The two indexes partition cleanly by
  // `correlation_key` NULL-ness (migration 0024 re-scopes the old
  // index with `AND correlation_key IS NULL`), so a `correlation_key`
  // -bearing row is governed solely by the new index and two
  // same-victim/same-window R4 rows that differ only by `category`
  // both persist without tripping an unhandled `unique_violation` on
  // the old index.
  // The ON CONFLICT inference predicate must match the target partial
  // index's predicate exactly (Postgres partial-index arbiter rule),
  // so the R1/R3 branch carries the `AND correlation_key IS NULL`
  // clause migration 0024 added to `event_group_auto_dedup_idx`.
  // Omitting it raises "no unique or exclusion constraint matching the
  // ON CONFLICT specification".
  const onConflict =
    correlationKey !== null
      ? `ON CONFLICT (correlation_rule_id, correlation_key, time_window_start, time_window_end)
              WHERE kind = 'auto_correlated' AND correlation_key IS NOT NULL
              DO NOTHING`
      : `ON CONFLICT (correlation_rule_id, primary_asset, time_window_start, time_window_end)
              WHERE kind = 'auto_correlated' AND primary_asset IS NOT NULL
                AND correlation_key IS NULL
              DO NOTHING`;
  const summaryJson = JSON.stringify(
    draft.summary satisfies StorySummaryPayload,
  );
  const insertGroup =
    carryOver === undefined
      ? await client.query<{ id: string }>(
          `INSERT INTO event_group (
              kind, correlation_rule_id, story_version,
              time_window_start, time_window_end,
              primary_asset, score, summary_payload, correlation_key
            )
            VALUES ('auto_correlated', $1, $2, $3, $4, $5::inet, $6, $7::jsonb, $8)
            ${onConflict}
            RETURNING id::text AS id`,
          [
            draft.ruleId,
            STORY_VERSION,
            draft.timeWindowStart,
            draft.timeWindowEnd,
            draft.primaryAsset,
            draft.score,
            summaryJson,
            correlationKey,
          ],
        )
      : await client.query<{ id: string }>(
          `INSERT INTO event_group (
              kind, correlation_rule_id, story_version,
              time_window_start, time_window_end,
              primary_asset, score, summary_payload, correlation_key,
              last_sent_at, send_count, last_sent_by
            )
            VALUES ('auto_correlated', $1, $2, $3, $4, $5::inet, $6, $7::jsonb, $8,
                    $9, $10, $11::uuid)
            ${onConflict}
            RETURNING id::text AS id`,
          [
            draft.ruleId,
            STORY_VERSION,
            draft.timeWindowStart,
            draft.timeWindowEnd,
            draft.primaryAsset,
            draft.score,
            summaryJson,
            correlationKey,
            carryOver.lastSentAt,
            carryOver.sendCount,
            carryOver.lastSentBy,
          ],
        );
  if (insertGroup.rows.length === 0) {
    return { groupId: null };
  }
  const groupId = insertGroup.rows[0].id;
  await insertStoryMembers(client, groupId, draft.members, "primary");
  return { groupId };
}

export interface InsertCuratedStoryArgs {
  /**
   * Analyst's chosen focus asset. May be `null` for curated Stories
   * — the partial unique-index dedup applies only to
   * `kind = 'auto_correlated'`, so a curated row with NULL
   * `primary_asset` is legal.
   */
  primaryAsset: string | null;
  /**
   * Analyst's selected period. Persisted verbatim to
   * `time_window_start` / `time_window_end` on the `event_group`
   * row.
   */
  timeWindowStart: Date;
  timeWindowEnd: Date;
  /**
   * Member events. The §8 cap and deterministic sampling order are
   * enforced here so #490's mutation cannot accidentally bypass
   * the LLM context-budget contract that auto-correlated Stories
   * obey.
   */
  members: ReadonlyArray<CandidateEvent>;
  /**
   * Optional Story-side `score`. Curated rows are not produced by
   * a rule, so the column is nullable; when omitted, defaults to
   * the post-cap `memberCount` for consistency with R3's score
   * model (count of admitted members).
   */
  score?: number | null;
  /**
   * Optional analyst-provided title (#490). Stored under
   * `summary_payload.manualTitle` (an optional, additive key in
   * RFC §7) when present; absent otherwise — the renderer falls
   * back to the auto-generated `<asset> · <duration> · <cats>`
   * title. Trimmed and capped at 200 chars by the server action
   * before reaching this layer; the repository accepts the value
   * verbatim.
   */
  manualTitle?: string | null;
}

export interface InsertCuratedStoryResult {
  /** Newly-inserted `event_group.id`. Curated rows are NOT subject
   *  to the partial unique-index dedup (which is scoped to
   *  `kind = 'auto_correlated'`), so the insert always succeeds. */
  groupId: string;
}

/**
 * INSERT one analyst-curated `event_group` row plus its members in
 * the caller's open transaction. Mirrors `insertAutoStory`'s shape
 * with three differences:
 *
 *   - `kind = 'analyst_curated'`.
 *   - `correlation_rule_id = NULL` (curated rows have no rule).
 *   - No `ON CONFLICT` clause — the partial unique index is scoped
 *     to `kind = 'auto_correlated'`, so a curated save can
 *     legitimately repeat a `(asset, window)` an analyst already
 *     stored.
 *
 * Built so #490's "Save as Story" mutation has a stable storage
 * path that obeys the §7 fixed-key `summary_payload` contract and
 * the §8 member cap / sampling order. The UI control itself ships
 * with #490.
 */
export async function insertCuratedStory(
  client: pg.PoolClient,
  args: InsertCuratedStoryArgs,
): Promise<InsertCuratedStoryResult> {
  const members = applyMemberCap(args.members);
  const baseSummary = buildSummaryPayload(members);
  const summary: StorySummaryPayload & { manualTitle?: string } =
    args.manualTitle && args.manualTitle.length > 0
      ? { ...baseSummary, manualTitle: args.manualTitle }
      : baseSummary;
  const score = args.score ?? members.length;
  const insertGroup = await client.query<{ id: string }>(
    `INSERT INTO event_group (
        kind, correlation_rule_id, story_version,
        time_window_start, time_window_end,
        primary_asset, score, summary_payload
      )
      VALUES ('analyst_curated', NULL, $1, $2, $3, $4::inet, $5, $6::jsonb)
      RETURNING id::text AS id`,
    [
      STORY_VERSION,
      args.timeWindowStart,
      args.timeWindowEnd,
      args.primaryAsset,
      score,
      JSON.stringify(summary satisfies StorySummaryPayload),
    ],
  );
  const groupId = insertGroup.rows[0].id;
  await insertStoryMembers(client, groupId, members, "primary");
  return { groupId };
}

/**
 * Batched member INSERT. The PK is `(event_group_id, event_key)`, so
 * `ON CONFLICT DO NOTHING` makes the path idempotent under a retry
 * of the same draft against an already-inserted parent.
 */
async function insertStoryMembers(
  client: pg.PoolClient,
  groupId: string,
  members: ReadonlyArray<CandidateEvent>,
  role: "primary" | "context",
): Promise<void> {
  if (members.length === 0) return;
  const params: unknown[] = [];
  const placeholders: string[] = [];
  for (const m of members) {
    const base = params.length;
    placeholders.push(
      `($${base + 1}::bigint, $${base + 2}::numeric, $${base + 3}::text)`,
    );
    params.push(groupId, m.eventKey, role);
  }
  await client.query(
    `INSERT INTO event_group_member (event_group_id, event_key, role)
       VALUES ${placeholders.join(", ")}
       ON CONFLICT (event_group_id, event_key) DO NOTHING`,
    params,
  );
}

/**
 * Advance `baseline_corpus_state.story_finalized_through`. The
 * correlator calls this once per page transaction with
 * `new_horizon = page_max_event_time − slop`. Per the watermark
 * protocol, the column is `>=`-monotonic: a re-run of the same page
 * (e.g., a slop-window replay) must never push the watermark
 * backwards, so the UPDATE uses `GREATEST(...)` to coalesce against
 * the prior value.
 */
export async function advanceStoryWatermark(
  client: pg.PoolClient,
  newHorizon: Date,
): Promise<void> {
  await client.query(
    `UPDATE baseline_corpus_state
        SET story_finalized_through =
              GREATEST(story_finalized_through, $1)
      WHERE id = true`,
    [newHorizon],
  );
}

/**
 * Read the singleton's current `story_finalized_through` value.
 * Returns `null` on a fresh tenant where step (f) has never
 * advanced the watermark — the correlator treats `null` as
 * "no previous boundary", per the first-tick degenerate-protocol
 * branch in the issue body.
 */
export async function readStoryWatermark(
  client: pg.PoolClient,
): Promise<Date | null> {
  const result = await client.query<{ story_finalized_through: Date | null }>(
    `SELECT story_finalized_through
       FROM baseline_corpus_state
      WHERE id = true`,
  );
  return result.rows[0]?.story_finalized_through ?? null;
}

/**
 * Advance `baseline_corpus_state.lowslow_finalized_through` (issue
 * #701). Mirrors {@link advanceStoryWatermark}: the hourly low-and-slow
 * sweep calls this once per tick with `new_horizon = H`
 * (`= story_finalized_through`, cadence's settled point). `GREATEST(...)`
 * keeps the column `>=`-monotonic so a re-run over the same settled
 * range never pushes the watermark backwards. Advanced even on 0-result
 * sweeps — it is a wall-clock/progress watermark, not a Stories-produced
 * one.
 */
export async function advanceLowslowWatermark(
  client: pg.PoolClient,
  newHorizon: Date,
): Promise<void> {
  await client.query(
    `UPDATE baseline_corpus_state
        SET lowslow_finalized_through =
              GREATEST(lowslow_finalized_through, $1)
      WHERE id = true`,
    [newHorizon],
  );
}

/**
 * Read the singleton's current `lowslow_finalized_through` value
 * (issue #701). Returns `null` on a tenant where the low-and-slow
 * sweep has never advanced its watermark — the sweep treats `null` as
 * the first-run case, clamping both ranges to `[H − LOWSLOW_WINDOW_MS,
 * H]` (no 180d backfill).
 */
export async function readLowslowWatermark(
  client: pg.PoolClient,
): Promise<Date | null> {
  const result = await client.query<{
    lowslow_finalized_through: Date | null;
  }>(
    `SELECT lowslow_finalized_through
       FROM baseline_corpus_state
      WHERE id = true`,
  );
  return result.rows[0]?.lowslow_finalized_through ?? null;
}

// ── Stories tab read path (#490) ─────────────────────────────────

interface StoryListRow {
  id: string;
  kind: StoryKind;
  correlation_rule_id: StoryRuleId | null;
  story_version: string;
  time_window_start: Date;
  time_window_end: Date;
  primary_asset: string | null;
  score: number | null;
  summary_payload: StorySummaryPayload;
  created_at: Date;
  last_sent_at: Date | null;
  send_count: number;
}

interface TopMemberRow {
  event_group_id: string;
  event_key: string;
  event_time: Date;
  kind: string;
  category: ThreatCategory | string | null;
  raw_score: number;
}

interface StoryMemberDetailRow {
  event_key: string;
  event_time: Date;
  kind: string;
  sensor: string;
  orig_addr: string | null;
  resp_addr: string | null;
  orig_port: number | null;
  resp_port: number | null;
  host: string | null;
  dns_query: string | null;
  uri: string | null;
  category: ThreatCategory | string | null;
  /** `null` for out-of-period members (still in corpus A, but their
   *  `event_time` falls outside the menu period so the read-time
   *  `cume_dist()` cohort doesn't cover them). */
  baseline_score: number | null;
  /** Carried through to the Story-member pivot adapter so the
   *  Phase 1 engagement-action capture (#588) can fire
   *  `story_pivot_click` rows — the action shape CHECK requires
   *  `baseline_version` for row-bound action rows. */
  baseline_version: string;
}

export interface ListStoriesOptions {
  /** SQL-side ORDER BY axis. Defaults to `"time-window-end"`. */
  sortOrder?: StoriesSortOrder;
  /** When true, push the `last_sent_at IS NULL` partial-index filter
   *  into the SQL WHERE clause so the toggle operates against the
   *  full period rather than the post-LIMIT first page. */
  unsentOnly?: boolean;
}

/**
 * List Stories whose `time_window` overlaps the menu's selected
 * period. Result rows include the top-3 member preview joined in a
 * single round-trip-per-tenant — see {@link selectStoryTopMembers}
 * for the CTE.
 *
 * Callers run this once per tenant in scope and merge results client-
 * side on `(time_window_end DESC, score DESC, customerId, storyId)`
 * for the default sort, or on
 * `(score DESC NULLS LAST, time_window_end DESC, customerId, storyId)`
 * for the score sort. {@link ListStoriesOptions} pushes the sort and
 * the unsent filter into SQL so the truncation cap doesn't silently
 * scope sort/filter to a stale first page.
 */
export async function listStoriesForPeriod(
  pool: pg.Pool,
  customerId: number,
  customerName: string,
  period: TriagePeriod,
  pageSize: number,
  options?: ListStoriesOptions,
  signal?: AbortSignal,
): Promise<TriageStory[]> {
  signal?.throwIfAborted();
  const sql = buildSelectStoriesForPeriodSql({
    sortOrder: options?.sortOrder ?? "time-window-end",
    unsentOnly: Boolean(options?.unsentOnly),
  });
  const { rows } = await pool.query<StoryListRow>(sql, [
    period.startIso,
    period.endIso,
    pageSize,
  ]);
  if (rows.length === 0) return [];

  const previewByStoryId = await selectStoryTopMembers(
    pool,
    rows.map((r) => r.id),
    signal,
  );

  return rows.map((row) => ({
    customerId,
    customerName,
    storyId: row.id,
    kind: row.kind,
    ruleId: row.correlation_rule_id,
    storyVersion: row.story_version,
    timeWindowStartIso: row.time_window_start.toISOString(),
    timeWindowEndIso: row.time_window_end.toISOString(),
    primaryAsset: row.primary_asset,
    score: row.score === null ? null : Number(row.score),
    summary: row.summary_payload,
    createdAtIso: row.created_at.toISOString(),
    lastSentAtIso: row.last_sent_at?.toISOString() ?? null,
    sendCount: Number(row.send_count ?? 0),
    topMembers: previewByStoryId.get(row.id) ?? [],
  }));
}

async function selectStoryTopMembers(
  pool: pg.Pool,
  storyIds: ReadonlyArray<string>,
  signal: AbortSignal | undefined,
): Promise<Map<string, TriageStoryMemberPreview[]>> {
  signal?.throwIfAborted();
  if (storyIds.length === 0) return new Map();
  const { rows } = await pool.query<TopMemberRow>(
    SELECT_STORY_TOP_MEMBERS_SQL,
    [storyIds],
  );
  const out = new Map<string, TriageStoryMemberPreview[]>();
  for (const r of rows) {
    const list = out.get(r.event_group_id);
    const preview: TriageStoryMemberPreview = {
      eventKey: r.event_key,
      eventTimeIso: r.event_time.toISOString(),
      kind: r.kind,
      category: r.category,
      rawScore: Number(r.raw_score),
    };
    if (list === undefined) out.set(r.event_group_id, [preview]);
    else list.push(preview);
  }
  return out;
}

export interface StoryMemberDetailResult {
  /** Joined member rows ordered newest-first. */
  members: TriageStoryMemberDetail[];
  /** True when at least one member was aged out of corpus A and is
   *  silently absent from {@link members}. */
  hasDanglingMembers: boolean;
  /** `summary_payload.memberCount` from the stored row — the
   *  authoritative count for the card / detail header.  */
  storedMemberCount: number;
}

/**
 * Read the member table for one Story's detail panel, joining
 * `event_group_member` to `baseline_triaged_event` with read-time
 * `baseline_score`. The caller passes the stored
 * `summary_payload.memberCount` so the detail panel can render the
 * "X of Y events shown — D aged past corpus A retention" notice.
 *
 * `cutoff` is the strictness slider cutoff (#471 §3) applied to the
 * read-time `baseline_score` to compute the per-row `protectedByStory`
 * flag. Every row joined here is a Story member by construction
 * (`event_group_member` is the join's left side), so the four-
 * condition marker rule collapses to: cutoff > 0 AND baselineScore is
 * non-NULL AND baselineScore < cutoff. Out-of-period members carry
 * `baselineScore === null` and the marker stays silent on them.
 */
export async function readStoryMemberDetail(
  pool: pg.Pool,
  storyId: string,
  storedMemberCount: number,
  period: TriagePeriod,
  cutoff: number,
  signal?: AbortSignal,
): Promise<StoryMemberDetailResult> {
  signal?.throwIfAborted();
  const { rows } = await pool.query<StoryMemberDetailRow>(
    SELECT_STORY_MEMBERS_DETAIL_SQL,
    [storyId, period.startIso, period.endIso],
  );
  const members: TriageStoryMemberDetail[] = rows.map((r) => {
    const baselineScore =
      r.baseline_score === null ? null : Number(r.baseline_score);
    return {
      eventKey: r.event_key,
      eventTimeIso: r.event_time.toISOString(),
      kind: r.kind,
      sensor: r.sensor,
      origAddr: r.orig_addr,
      respAddr: r.resp_addr,
      origPort: r.orig_port,
      respPort: r.resp_port,
      host: r.host,
      dnsQuery: r.dns_query,
      uri: r.uri,
      category: r.category,
      baselineScore,
      baselineVersion: r.baseline_version,
      protectedByStory:
        baselineScore !== null && cutoff > 0 && baselineScore < cutoff,
    };
  });
  return {
    members,
    hasDanglingMembers: members.length < storedMemberCount,
    storedMemberCount,
  };
}

/**
 * Look up the slim {@link CandidateEvent} shape for an explicit set of
 * `event_key` values inside the resolved customer's tenant DB. Used by
 * the curated-save server action to validate member existence and
 * compute the `summary_payload`.
 *
 * Returns the rows that resolved — the caller diffs against the
 * requested set so a missing key produces `MEMBER_NOT_FOUND`. The
 * cross-tenant case is implicit: this query runs against one tenant
 * pool, so a key that lives in a different tenant simply does not
 * resolve here.
 */
export async function readBaselineEventsByKey(
  pool: pg.Pool,
  eventKeys: ReadonlyArray<string>,
  signal?: AbortSignal,
): Promise<CandidateEvent[]> {
  signal?.throwIfAborted();
  if (eventKeys.length === 0) return [];
  const { rows } = await pool.query<{
    event_key: string;
    event_time: Date;
    kind: string;
    orig_addr: string | null;
    category: ThreatCategory | string | null;
    selector_tags: string[] | null;
    raw_score: number;
  }>(SELECT_BASELINE_EVENTS_BY_KEY_SQL, [eventKeys]);
  return rows.map((row) => ({
    eventKey: row.event_key,
    eventTime: row.event_time,
    kind: row.kind,
    origAddr: row.orig_addr,
    // The curated-save path is asset-keyed (orig_addr); `respAddr` is
    // only consumed by the R4/R5 auto-correlation reads, so it is not
    // selected here.
    respAddr: null,
    category: row.category,
    selectorTags: row.selector_tags ?? [],
    rawScore: Number(row.raw_score),
  }));
}
