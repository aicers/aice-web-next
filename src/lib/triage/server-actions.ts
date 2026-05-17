import "server-only";

import { randomUUID } from "node:crypto";
import type pg from "pg";

import type { AuthSession } from "@/lib/auth/jwt";
import { query as centralQuery } from "@/lib/db/client";
import type { ThreatCategory } from "@/lib/detection";

import { compareAssets } from "./aggregate";
import { ENGAGEMENT_TUNABLES } from "./baseline/engagement-tunables";
import {
  type BucketAggregate,
  type BucketEngagement,
  bucketKey,
  compareEventKeyDesc,
  composeMenu,
  type MenuRow,
} from "./baseline/menu";
import {
  COUNT_ELIGIBLE_BY_STOP_SQL,
  COUNT_OBSERVED_SQL,
  COUNT_TRIAGED_SQL,
  MENU_CANDIDATES_PER_BUCKET,
  PER_ASSET_OBSERVED_COUNTS_SQL,
  SELECT_ASSET_DETAIL_EVENTS_BATCH_SQL,
  SELECT_MENU_COHORT_SQL,
  SELECT_STORY_PROTECTED_COHORT_SQL,
  STORY_PROTECTED_PER_TENANT_LIMIT,
  TRIAGE_ASSET_DETAIL_LIMIT,
} from "./baseline/read-path-sql.mjs";
import { buildDispatchContext } from "./dispatch-context";
import {
  selectActiveWindowDays,
  selectBucketEngagement,
  tenantImpressionCount,
} from "./engagement/aggregate";
import type { TriagePeriod } from "./period";
import { getCustomerPool } from "./policy/customer-db";
import {
  cutoffForStop,
  DEFAULT_STRICTNESS_STOP_ID,
  defaultNMultiplierForStop,
  STRICTNESS_STOPS,
  type StrictnessStopId,
} from "./strictness/stops";
import {
  type ScoredTriageEvent,
  STORY_PROTECTED_HARD_CAP,
  TRIAGE_HARD_EVENT_CAP,
  type TriageAsset,
  type TriageCustomerFreshness,
  type TriageEvent,
  type TriageFreshness,
  type TriageLoadResult,
} from "./types";

/**
 * Bound on the asset-list page returned by one Baseline-mode load.
 * `loadTriagePeriod` always returns a single page. The menu does not
 * expose Next/Prev pagination — PR #525 superseded the earlier
 * keyset-pagination proposal (#523), so the asset list ships as a
 * single capped page with no continuation cursor.
 */
export const TRIAGE_ASSET_PAGE_SIZE = 100;

/**
 * `observed_event_meta` retention floor. The lower bound on every
 * `observed_event_meta` read in this request is
 * `max(:from, now() − OBSERVED_EVENT_META_RETENTION_MS)`. Computed
 * once per request and threaded into every `observed_event_meta`
 * SELECT (funnel COUNT, per-asset COUNT) so an out-of-retention row
 * that survived cleanup is never counted into the 30-day-window
 * denominator.
 */
export const OBSERVED_EVENT_META_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Upstream detector store (`review-web`) retention horizon, in
 * milliseconds. Read by the rebuild estimate endpoint (#473) to
 * warn the operator when `to` is older than what the detector store
 * can still serve — the rebuild proceeds, but the result may have
 * fewer rows than what is currently on the corpus.
 *
 * Default (30 days) tracks the operationally agreed value with the
 * `review-web` team. The `REVIEW_DETECTOR_RETENTION_MS` env var
 * overrides for e2e tests / non-default deployments, mirroring the
 * `AIMER_SIGNING_KEY_PREV_RETENTION_MS` override pattern.
 */
export function reviewDetectorRetentionMs(): number {
  const raw = process.env.REVIEW_DETECTOR_RETENTION_MS;
  if (raw && raw.length > 0) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return 30 * 24 * 60 * 60 * 1000;
}

/**
 * Concurrency budget for the per-customer fanout. Matches the
 * dispatcher pattern from #487 — small enough that a multi-tenant
 * page does not stampede the connection pool, large enough that the
 * common 1–4 customer scope completes in one batch.
 */
const FANOUT_CONCURRENCY = 4;

interface BaselineEventRow {
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
  category: ThreatCategory | null;
  baseline_score: number | null;
}

interface BaselineEventDetailRow extends BaselineEventRow {
  /**
   * Per-row marker source (#471 §3). Projected by the asset-detail
   * SQL as `(baseline_score < $5 AND in_story)` so the four-condition
   * marker rule collapses to "row passes when this is `true` AND the
   * slider is not at 'All'" — at "All" the cutoff is `0` and the
   * expression is always `false` by construction, so the SQL itself
   * enforces condition (a) of the rule.
   */
  protected_by_story: boolean;
  /**
   * `baseline_version` carried through to the detail rows so the
   * Phase 1 engagement-action capture (#588) can fire `pivot_click`
   * on rows the analyst opens from the asset-detail panel — the
   * panel-rooted pivot click uses `effectiveAsset.events[0]` as the
   * row-bound reference and the action shape CHECK requires
   * `baseline_version` for `pivot_click` rows.
   */
  baseline_version: string;
}

interface ProtectedCohortDbRow extends BaselineEventRow {
  baseline_version: string;
  raw_score: number;
  selector_tags: string[] | null;
  /**
   * `true` when this row is guaranteed not to be in branch A's SQL
   * cohort or branch A's post-`composeMenu` set — i.e. its `bucket_rn`
   * exceeds `MENU_CANDIDATES_PER_BUCKET` (so branch A's SQL drops it)
   * or its `baseline_score` is below the slider cutoff (so
   * `composeMenu`'s cutoff filter drops it). Sorted to the top of the
   * SQL result so the per-tenant `LIMIT` cannot be consumed by
   * branch-A overlap that JS dedup (now at the merge layer, #596
   * Round 4 item 1) would otherwise shadow with branch A precedence.
   */
  branch_b_unique: boolean;
  /**
   * Unfiltered `COUNT(*) OVER ()` of in-window Story members in this
   * tenant — computed before the SQL `LIMIT` slice (#471 §2, #596
   * Round 4 item 2). Every returned row carries the same value. The
   * merge layer subtracts the count of visible Story members in the
   * final union (identified via `MenuCohortDbRow.in_story` for branch
   * A rows plus every returned branch B row) to compute
   * `storyProtectedDroppedCount`. Counting all in-window members is
   * safe because the merge layer knows which of those members are
   * actually visible via branch A — the Round 2 over-attribution
   * concern is handled in JS rather than by pre-filtering the SQL.
   */
  protected_total_in_window: string;
}

interface EligibleByStopRow {
  total_all: string;
  eligible_top80: string;
  eligible_top50: string;
  eligible_top20: string;
  eligible_top5: string;
}

/**
 * `selectMenuCohort` row shape. Carries the §3 read-time `baseline_score`
 * plus the per-bucket cohort aggregates (`bucket_count`,
 * `bucket_tag_sum`) and the cohort total (`cohort_count`) that the
 * algorithm needs to compute `normalized_volume`,
 * `normalized_top_confidence`, and `default_N` against the **full**
 * post-`Blocklist*` cohort. The columns are constant across all rows
 * sharing a `(kind, is_unlabeled)` partition / the entire result set
 * respectively — surfaced per row so a single SQL response is
 * sufficient.
 */
interface MenuCohortDbRow extends BaselineEventRow {
  baseline_version: string;
  raw_score: number;
  selector_tags: string[] | null;
  is_unlabeled: boolean;
  /**
   * `EXISTS (SELECT 1 FROM event_group_member ...)` evaluated by
   * {@link SELECT_MENU_COHORT_SQL} (#596 Round 4 item 2). Branch A's
   * `composeMenu` output does not by itself reveal Story membership;
   * surfacing the flag here lets the merge layer count visible Story
   * members in the final union and subtract from
   * `protectedTotalInWindow` for an exact `storyProtectedDroppedCount`
   * without over-attributing branch-A-shown rows that branch B's per-
   * tenant `LIMIT` happens to omit.
   */
  in_story: boolean;
  bucket_count: string;
  bucket_tag_sum: string;
  cohort_count: string;
}

interface ObservedCountRow {
  address: string;
  detected_count: string;
}

interface CorpusStateRow {
  last_ingested_at: Date | null;
  last_run_status: TriageCustomerFreshness["status"] | null;
  last_error: string | null;
}

/**
 * Per-asset enrichment carried alongside a tenant's menu rows. The
 * cross-tenant cap in {@link loadTriagePeriod} aggregates `score`,
 * `triagedCount`, and `lastEventTimeIso` from the **capped** events,
 * but `customerName`, `detectedCount`, `detectedCountUnavailable`,
 * and the per-asset detail-panel `events` array are fixed per-tenant
 * inputs that travel through the pipeline unchanged.
 */
interface AssetEnrichment {
  detectedCount: number;
  detectedCountUnavailable: boolean;
  detailEvents: ScoredTriageEvent[];
}

type EligibleByStop = Partial<Record<StrictnessStopId, number>>;

interface ProtectedCohortResult {
  rows: ProtectedCohortDbRow[];
  /**
   * Unfiltered count of in-window Story members in this tenant
   * (`COUNT(*) OVER ()` projected by `SELECT_STORY_PROTECTED_COHORT_SQL`
   * before the `LIMIT` slice). The merge layer uses this as the true
   * Story-member population per tenant and subtracts the visible Story
   * member count (identified through both `MenuCohortDbRow.in_story`
   * for branch A rows and every branch B row) to compute
   * `storyProtectedDroppedCount`. Counting *all* in-window members
   * here is safe because the merge layer knows which are actually
   * visible via branch A — the Round 2 over-attribution risk is
   * handled in JS rather than by FILTERing the SQL pre-count (#596
   * Round 4 item 2).
   */
  totalInWindow: number;
}

interface CustomerSlice {
  customerId: number;
  customerName: string;
  /**
   * Per-tenant `final_menu_rows` projected to scored events. Joined
   * across tenants in {@link loadTriagePeriod}, sorted in §3 priority
   * order, and capped at {@link TRIAGE_HARD_EVENT_CAP} *before* the
   * asset list is aggregated — so the visible asset list and the
   * returned pivot corpus are derived from the same row set.
   */
  events: ScoredTriageEvent[];
  /**
   * Branch B (#471 §1) — Story-protected rows that bypass both the
   * SQL candidate cap and `composeMenu`'s per-bucket quota. Carried
   * separately so the merge layer can apply its independent
   * {@link STORY_PROTECTED_HARD_CAP} (#471 §2 "Multi-tenant merge
   * stage — separate cap for protected rows"). Each row carries
   * `protectedByStory` set per the §3 four-condition rule (#471 §3)
   * so the per-event marker surfaces can render directly from the
   * flag without re-deriving the rule.
   *
   * Includes branch-A overlap — dedup of branch B against branch A is
   * decided in the merge layer after both caps fire, not per-tenant,
   * because a Story member that branch A happens to surface inside
   * one tenant can still be dropped by the cross-tenant
   * `TRIAGE_HARD_EVENT_CAP`; removing the branch B copy before that
   * cap would leave the row with no rescue path (#596 Round 4
   * item 1).
   */
  protectedEvents: ScoredTriageEvent[];
  /**
   * Unfiltered count of in-window Story members in this tenant (per
   * {@link ProtectedCohortResult.totalInWindow}). Summed across the
   * customer scope by the merge layer; the merge layer subtracts the
   * count of Story members visible in the final union (using
   * {@link storyMemberKeysQualified}) to compute the authoritative
   * `storyProtectedDroppedCount` — exact under the #596 Round 4 item
   * 2 fix, no over-attribution of branch-A-shown rows.
   */
  protectedTotalInWindow: number;
  /**
   * Per-tenant set of `${customerId}/${event_key}` for events known
   * to be Story members — every branch A event whose
   * {@link MenuCohortDbRow.in_story} is `true` plus every branch B
   * row returned by the SQL `LIMIT` window. The merge layer unions
   * these across tenants and counts intersection with the final union
   * `events` to determine `storyProtectedDroppedCount` exactly,
   * without needing a separate `isStoryMember` field on every
   * {@link ScoredTriageEvent} (#596 Round 4 item 2).
   */
  storyMemberKeysQualified: Set<string>;
  /** Per-asset enrichment keyed by `orig_addr` for this tenant. */
  enrichmentByAddress: Map<string, AssetEnrichment>;
  detected: number;
  triaged: number;
  /**
   * Per-stop `eligible_top_n` counts for this tenant (#471 §4). Summed
   * across tenants in {@link loadTriagePeriod} so the slider chip's
   * "≈ N" hint reflects the customer scope, not a single tenant.
   */
  eligibleByStop: EligibleByStop;
  freshness: TriageCustomerFreshness;
}

/**
 * Convert a `baseline_triaged_event` row back into the
 * {@link TriageEvent} shape the menu UI consumes. Only the columns
 * present on the corpus row are populated; subtype-specific fields
 * (TLS JA3, DNS answer, country, level, etc.) stay `null` per the
 * "Row-shape gap" section of #458.
 */
function rowToEvent(row: BaselineEventRow): TriageEvent {
  return {
    __typename: row.kind,
    id: row.event_key,
    time: row.event_time.toISOString(),
    sensor: row.sensor,
    category: row.category,
    level: null,
    origAddr: row.orig_addr,
    respAddr: row.resp_addr,
    origPort: row.orig_port,
    respPort: row.resp_port,
    host: row.host,
    query: row.dns_query,
    uri: row.uri,
  };
}

/**
 * Run one tenant's slice of the Triage menu read. A single
 * `selectMenuCohort` call delivers the post-`Blocklist*` cohort with
 * §3 `baseline_score` and §4 per-bucket aggregates attached; the
 * algorithm composes `final_menu_rows`, which the slice exposes as
 * `events`. Per-asset enrichment (observed counts, detail-panel rows)
 * is loaded once per address that contributed to this tenant's menu
 * and returned in {@link AssetEnrichment} for the cross-tenant cap
 * step in {@link loadTriagePeriod} to consume — the asset list itself
 * is aggregated from the **capped** events so the analyst-facing list
 * and the returned pivot corpus stay derived from the same row set
 * even when the cap fires.
 */
async function loadCustomerSlice(
  customerId: number,
  customerName: string,
  period: TriagePeriod,
  observedFromIso: string,
  observedDenominatorTruncated: boolean,
  strictness: StrictnessStopId,
  signal: AbortSignal | undefined,
): Promise<CustomerSlice> {
  signal?.throwIfAborted();
  const pool = await getCustomerPool(customerId);
  const menuCutoff = cutoffForStop(strictness);
  const defaultNMultiplier = defaultNMultiplierForStop(strictness);

  const freshness = await readFreshness(pool, customerId, signal);
  signal?.throwIfAborted();

  // §4/§6 menu cohort + branch B (#471 §1) + per-stop eligible
  // counts (#471 §4) + Phase 2 engagement aggregate fan out in
  // parallel — all reads are independent and bounded. Branch B
  // carries Story-protected rows that bypass both the SQL candidate
  // cap and `composeMenu`'s per-bucket quota; the merge layer
  // (`loadTriagePeriod`) applies a separate `STORY_PROTECTED_HARD_CAP`
  // to the cross-tenant union. The engagement aggregate is wired
  // through for audit at the Phase 2a `γ = 0` first ship — the value
  // is recorded but `composeMenu` multiplies it to zero per RFC §9.2
  // (output stays byte-identical to RFC 0001).
  const [cohort, protectedCohort, eligibleByStop, bucketEngagement] =
    await Promise.all([
      selectMenuCohort(pool, period, signal),
      selectStoryProtectedCohort(pool, period, menuCutoff, signal),
      countEligibleByStop(pool, period, signal),
      loadBucketEngagementForLoader(pool, strictness, signal),
    ]);
  const protectedRows = protectedCohort.rows;
  signal?.throwIfAborted();

  const menuResult = composeMenuFromCohort(
    cohort,
    menuCutoff,
    defaultNMultiplier,
    bucketEngagement,
  );
  const menuRows = menuResult.rows;
  const dbRowByKey = new Map(cohort.candidates.map((r) => [r.event_key, r]));

  // #588 impression-metadata threading. Every row carries its
  // `(slot_bucket, baseline_version)` plus a `shown_by` source label
  // so the client's impression batch records the exact projection
  // reason for each surfaced row. `quota` covers the post-quota
  // composeMenu output; `fallback` covers the MIN_NONZERO_FLOOR
  // rescue path; branch B rows are tagged `story_protected` further
  // down in this function.
  const events = menuRowsToScoredEvents(
    menuRows,
    dbRowByKey,
    customerId,
    menuResult.fallbackInvoked ? "fallback" : "quota",
  );

  // Branch B rows are kept in full — dedup against branch A on
  // `event_key` is decided in the merge layer (`loadTriagePeriod`)
  // after both caps fire, not per-tenant. A Story member that branch
  // A happens to surface inside one tenant can still be dropped by
  // the cross-tenant `TRIAGE_HARD_EVENT_CAP`; removing the branch B
  // copy here would leave the row with no rescue path (#596 Round 4
  // item 1).
  //
  // The marker flag (`protectedByStory`) still collapses #471 §3's
  // four-condition rule into a single boolean on every row so per-
  // event surfaces (asset detail, pivot, Story detail) can render the
  // chain-link directly without re-deriving the rule:
  //
  //   (a) slider != "all"         → `menuCutoff > 0`
  //   (b) baseline_score non-NULL → branch B always projects it
  //   (c) baseline_score < cutoff → `score < menuCutoff`
  //   (d) protected_by_story=true → every branch B row is a Story member
  //
  // Branch-A overlap rows (above-cutoff Story members) carry
  // `protectedByStory: false` by condition (c), so the pivot panel —
  // which renders the marker directly from the flag — does not over-
  // mark them when the merge-layer dedup picks the branch B copy
  // because branch A's copy was dropped by the global scored cap.
  const protectedEvents = protectedRows.map<ScoredTriageEvent>((dbRow) => {
    const event = rowToEvent(dbRow);
    const score = dbRow.baseline_score ?? 0;
    return {
      ...event,
      score,
      customerId,
      protectedByStory:
        dbRow.baseline_score !== null &&
        menuCutoff > 0 &&
        dbRow.baseline_score < menuCutoff,
      rowKey: `${customerId}/${dbRow.event_key}`,
      // #588 impression-metadata threading: branch B rows are
      // surfaced via the Story-protected force-union, so the
      // engagement `shown_by` label is always `story_protected`.
      // `slot_bucket` mirrors the same `(kind, is_unlabeled)` key
      // `composeMenu` would have used.
      baselineVersion: dbRow.baseline_version,
      slotBucket: `${dbRow.kind}:${
        dbRow.kind === "HttpThreat" &&
        (dbRow.selector_tags ?? []).includes("unlabeled-cluster")
      }`,
      shownBy: "story_protected" as const,
    };
  });

  // Set of `${customerId}/${event_key}` known to be Story members.
  // Every branch B row is a Story member by construction; branch A
  // rows are Story members iff `MenuCohortDbRow.in_story` is `true`
  // (#596 Round 4 item 2). The merge layer unions these across
  // tenants and counts intersection with the final union to compute
  // `storyProtectedDroppedCount` exactly.
  const storyMemberKeysQualified = new Set<string>();
  for (const e of events) {
    const dbRow = dbRowByKey.get(e.id);
    if (dbRow?.in_story === true) {
      storyMemberKeysQualified.add(`${customerId}/${e.id}`);
    }
  }
  for (const e of protectedEvents) {
    storyMemberKeysQualified.add(`${customerId}/${e.id}`);
  }

  // Addresses for enrichment: every distinct `orig_addr` from both
  // branches. A Story-protected asset that has no scored events would
  // otherwise miss the per-asset observed COUNT + detail panel.
  const addressesSet = new Set<string>();
  for (const e of events) if (e.origAddr) addressesSet.add(e.origAddr);
  for (const e of protectedEvents) if (e.origAddr) addressesSet.add(e.origAddr);
  const addresses = Array.from(addressesSet);

  if (addresses.length === 0) {
    const [detected, triaged] = await Promise.all([
      countObserved(pool, observedFromIso, period.endIso, signal),
      countTriaged(pool, period, signal),
    ]);
    return {
      customerId,
      customerName,
      events,
      protectedEvents,
      protectedTotalInWindow: protectedCohort.totalInWindow,
      storyMemberKeysQualified,
      enrichmentByAddress: new Map(),
      detected,
      triaged,
      eligibleByStop,
      freshness,
    };
  }

  // Funnel + per-asset observed COUNT + per-asset detail events fan
  // out in parallel — the reads are independent and bounded.
  const [detected, triaged, observedCounts, detailRowsByAddress] =
    await Promise.all([
      countObserved(pool, observedFromIso, period.endIso, signal),
      countTriaged(pool, period, signal),
      perAssetObservedCounts(
        pool,
        observedFromIso,
        period.endIso,
        addresses,
        signal,
      ),
      selectAssetDetailEventsBatch(pool, period, addresses, menuCutoff, signal),
    ]);

  const observedByAddress = new Map<string, number>();
  for (const row of observedCounts) {
    observedByAddress.set(row.address, Number(row.detected_count));
  }

  const enrichmentByAddress = new Map<string, AssetEnrichment>();
  for (const address of addresses) {
    const detailRows = detailRowsByAddress.get(address) ?? [];
    const detailEvents = detailRows.map((dbRow, eventIdx) => {
      const event = rowToEvent(dbRow);
      const score = dbRow.baseline_score ?? 0;
      const scored: ScoredTriageEvent = {
        ...event,
        score,
        customerId,
        protectedByStory: dbRow.protected_by_story === true,
        rowKey: `${customerId}/${address}#${eventIdx}`,
        // #588 baseline_version threaded so the engagement-action
        // capture on `pivot_click` (which uses the detail panel's
        // first row as the row-bound reference) can satisfy the
        // schema-level `engagement_action_shape` CHECK.
        baselineVersion: dbRow.baseline_version,
      };
      return scored;
    });
    const observed = observedByAddress.get(address);
    const detectedCount = observed ?? 0;
    const detectedCountUnavailable =
      observedDenominatorTruncated && observed === undefined;
    enrichmentByAddress.set(address, {
      detectedCount,
      detectedCountUnavailable,
      detailEvents,
    });
  }

  return {
    customerId,
    customerName,
    events,
    protectedEvents,
    protectedTotalInWindow: protectedCohort.totalInWindow,
    storyMemberKeysQualified,
    enrichmentByAddress,
    detected,
    triaged,
    eligibleByStop,
    freshness,
  };
}

async function selectStoryProtectedCohort(
  pool: pg.Pool,
  period: TriagePeriod,
  menuCutoff: number,
  signal: AbortSignal | undefined,
): Promise<ProtectedCohortResult> {
  signal?.throwIfAborted();
  const { rows } = await pool.query<ProtectedCohortDbRow>(
    SELECT_STORY_PROTECTED_COHORT_SQL,
    [
      period.startIso,
      period.endIso,
      STORY_PROTECTED_PER_TENANT_LIMIT,
      MENU_CANDIDATES_PER_BUCKET,
      menuCutoff,
    ],
  );
  // `protected_total_in_window` is the unbounded COUNT(*) OVER ()
  // projected by the SQL — identical across every returned row, so
  // reading the first row is sufficient. An empty result is the only
  // path that needs the explicit `0` fallback (the SQL never emits a
  // bare aggregate row, so an empty in_story CTE simply returns zero
  // rows here).
  const totalInWindow =
    rows.length === 0 ? 0 : Number(rows[0].protected_total_in_window);
  return { rows, totalInWindow };
}

async function countEligibleByStop(
  pool: pg.Pool,
  period: TriagePeriod,
  signal: AbortSignal | undefined,
): Promise<EligibleByStop> {
  signal?.throwIfAborted();
  const { rows } = await pool.query<EligibleByStopRow>(
    COUNT_ELIGIBLE_BY_STOP_SQL,
    [period.startIso, period.endIso],
  );
  if (rows.length === 0) {
    return { all: 0, top80: 0, top50: 0, top20: 0, top5: 0 };
  }
  const r = rows[0];
  return {
    all: Number(r.total_all),
    top80: Number(r.eligible_top80),
    top50: Number(r.eligible_top50),
    top20: Number(r.eligible_top20),
    top5: Number(r.eligible_top5),
  };
}

async function readFreshness(
  pool: pg.Pool,
  customerId: number,
  signal: AbortSignal | undefined,
): Promise<TriageCustomerFreshness> {
  signal?.throwIfAborted();
  const { rows } = await pool.query<CorpusStateRow>(
    `SELECT last_ingested_at, last_run_status, last_error
       FROM baseline_corpus_state
      WHERE id = true`,
  );
  if (rows.length === 0) {
    return {
      customerId,
      status: null,
      lastIngestedAtIso: null,
      rowAbsent: true,
      lastError: null,
    };
  }
  const row = rows[0];
  return {
    customerId,
    status: row.last_run_status,
    lastIngestedAtIso: row.last_ingested_at?.toISOString() ?? null,
    rowAbsent: false,
    lastError: row.last_error,
  };
}

interface MenuCohort {
  postExclusionCount: number;
  bucketAggregates: BucketAggregate[];
  candidates: MenuCohortDbRow[];
}

/**
 * Read the §4 menu cohort in a single SQL pass.
 *
 * The `scored` CTE computes the §3 read-time `baseline_score` over
 * the full post-`Blocklist*` window. The `ranked` CTE attaches three
 * window aggregates over that cohort:
 *
 *   * `bucket_count` and `bucket_tag_sum` per `(kind, is_unlabeled)`
 *     partition — used by the algorithm for
 *     `normalized_volume(b) = bucket_count / max(bucket_count)` and
 *     `normalized_top_confidence(b) =
 *      bucket_tag_sum / bucket_count / MAX_TAGS` (RFC §4). Both are
 *     full-cohort aggregates so a per-bucket SQL row cap on the
 *     returned candidates does not silently re-base them.
 *   * `cohort_count` over the entire cohort — fed to `default_N` so
 *     the §6 cognitive-limit cap is computed against the active
 *     window, not against the candidate slice.
 *
 * Returned rows are bounded by `MENU_CANDIDATES_PER_BUCKET` per
 * bucket, taken in `(baseline_score DESC, event_time DESC, event_key
 * DESC)` order. `MENU_CANDIDATES_PER_BUCKET` is a strict superset of
 * any quota the §6 curve can produce, so the algorithm's
 * `take up to quota[b]` step never starves on a bucket the cohort
 * still has.
 *
 * Defensive `kind NOT LIKE 'Blocklist%'` per RFC §1: cadence already
 * excludes these on the cadence-side INSERT (PR 2 / #513), but the
 * menu read keeps the guard so a regression on the cadence side
 * cannot leak Blocklist* rows into either the asset list or the
 * pivot corpus.
 */
async function selectMenuCohort(
  pool: pg.Pool,
  period: TriagePeriod,
  signal: AbortSignal | undefined,
): Promise<MenuCohort> {
  signal?.throwIfAborted();
  const { rows } = await pool.query<MenuCohortDbRow>(SELECT_MENU_COHORT_SQL, [
    period.startIso,
    period.endIso,
    MENU_CANDIDATES_PER_BUCKET,
  ]);
  return buildCohort(rows);
}

function buildCohort(rows: ReadonlyArray<MenuCohortDbRow>): MenuCohort {
  if (rows.length === 0) {
    return { postExclusionCount: 0, bucketAggregates: [], candidates: [] };
  }
  const postExclusionCount = Number(rows[0].cohort_count);
  const seenBuckets = new Map<string, BucketAggregate>();
  for (const row of rows) {
    const bucket = { kind: row.kind, isUnlabeled: row.is_unlabeled };
    const key = bucketKey(bucket);
    if (seenBuckets.has(key)) continue;
    seenBuckets.set(key, {
      bucket,
      count: Number(row.bucket_count),
      totalTagCardinality: Number(row.bucket_tag_sum),
    });
  }
  return {
    postExclusionCount,
    bucketAggregates: Array.from(seenBuckets.values()),
    candidates: [...rows],
  };
}

/**
 * Phase 2 engagement aggregate read for the menu loader (RFC 0003
 * §9.2). Skipped at the `"all"` stop (no quota allocation to weight)
 * and gated on RFC §6's tenant cold-start floor.
 *
 * At Phase 2a's `γ = 0` first ship the result is recorded for audit
 * but `composeMenu` multiplies it to zero, so any failure here cannot
 * change menu output. The read is wrapped in a defensive try/catch so
 * an issue on the audit substrate (e.g. a missing index, a corrupt
 * snapshot row) never blocks a menu load — the menu degrades to RFC
 * 0001-equivalent output, which is identical to the Phase 2a target.
 */
async function loadBucketEngagementForLoader(
  pool: pg.Pool,
  strictness: StrictnessStopId,
  signal: AbortSignal | undefined,
): Promise<BucketEngagement[] | undefined> {
  if (strictness === "all") return undefined;
  try {
    const tenantCount = await tenantImpressionCount(pool, signal);
    if (tenantCount < ENGAGEMENT_TUNABLES.tenantColdStartMinImpressions) {
      return undefined;
    }
    // Window selection (RFC §3): longest active window with at
    // least one tenant-wide engagement signal, where *active* means
    // `now - engagement_capture_started_at ≥ W`. The fallback chain
    // is `30d → 14d → 7d → cold-start`. A tenant that just crossed
    // the §6 impression-count cold-start floor after a day of
    // capture is still in window-cold-start for any W > 1d; using
    // the 30d window here would silently lengthen the EWMA half-
    // life to 15d when the tenant's actual capture age only
    // supports a 3.5d half-life, and the snapshot's declared
    // `selection_rule` would not match the implementation. With
    // γ = 0 (Phase 2a) the choice does not affect menu output but
    // the audit substrate and §11 calibration analysis still need
    // the window to be the one the RFC describes.
    const windowDays = await selectActiveWindowDays(pool, signal);
    if (windowDays === undefined) return undefined;
    return await selectBucketEngagement(
      pool,
      { windowDays, strictnessStop: strictness },
      signal,
    );
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw err;
    console.warn(
      `[triage] bucket engagement aggregate read failed; falling back to γ=0 (RFC 0001-equivalent): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return undefined;
  }
}

/**
 * Run the §4/§6 composition over the SQL-delivered cohort aggregates
 * and per-bucket candidates. `menuCutoff` carries the strictness
 * slider's cutoff (#471); the "All" stop passes `0` (no additional
 * cutoff above the cadence threshold). The cutoff is applied here in
 * the algorithm (not in the read-path SQL) so the full-cohort bucket
 * aggregates that drive `composeMenu`'s quota allocation are
 * preserved — RFC §6 option (a), "cutoff on top of unchanged quota".
 */
function composeMenuFromCohort(
  cohort: MenuCohort,
  menuCutoff: number,
  defaultNMultiplier: number | null,
  bucketEngagement: ReadonlyArray<BucketEngagement> | undefined,
) {
  const candidates: MenuRow[] = cohort.candidates.map((r) => ({
    eventKey: r.event_key,
    eventTime: r.event_time,
    kind: r.kind,
    baselineVersion: r.baseline_version,
    rawScore: r.raw_score,
    baselineScore: r.baseline_score ?? 0,
    selectorTags: r.selector_tags ?? [],
  }));
  return composeMenu({
    postExclusionCount: cohort.postExclusionCount,
    bucketAggregates: cohort.bucketAggregates,
    candidates,
    cutoff: menuCutoff,
    defaultNMultiplier,
    bucketEngagement,
  });
}

function menuRowsToScoredEvents(
  rows: ReadonlyArray<MenuRow>,
  dbRowByKey: ReadonlyMap<string, MenuCohortDbRow>,
  customerId: number,
  shownBy: "quota" | "fallback",
): ScoredTriageEvent[] {
  return rows.map((row) => {
    const dbRow = dbRowByKey.get(row.eventKey);
    if (dbRow === undefined) {
      // The algorithm only re-emits rows it received; this branch is
      // defensive against future divergence between the SQL row set
      // and the algorithm input set.
      throw new Error(`menu row ${row.eventKey} missing from db row map`);
    }
    const event = rowToEvent(dbRow);
    return {
      ...event,
      score: row.baselineScore,
      customerId,
      rowKey: `${customerId}/${dbRow.event_key}`,
      // #588 impression-metadata threading.
      baselineVersion: dbRow.baseline_version,
      slotBucket: `${dbRow.kind}:${dbRow.is_unlabeled}`,
      shownBy,
    };
  });
}

interface CappedAssetAggregate {
  customerId: number;
  address: string;
  score: number;
  triagedCount: number;
  lastEventTimeIso: string;
}

/**
 * Aggregate the cross-tenant capped event list into the per-asset
 * entries that drive the visible asset list. `score` is the sum of
 * `baseline_score` across the asset's **surviving** menu rows so the
 * analyst-facing list is governed end-to-end by §4 / §6 *and* by the
 * cross-tenant `TRIAGE_HARD_EVENT_CAP` — an asset cannot rank highly
 * from rows that did not survive either step. Per-tenant enrichment
 * (`customerName`, `detectedCount`, `detectedCountUnavailable`,
 * detail-panel events) is joined back from the slice that produced
 * the event.
 *
 * The composite key is `(customerId, address)` to match the same
 * multi-tenant asset key used throughout the menu — two tenants
 * legitimately host the same RFC1918 address.
 */
function aggregateAssetsFromCappedEvents(
  capped: ReadonlyArray<ScoredTriageEvent>,
  slices: ReadonlyArray<CustomerSlice>,
): TriageAsset[] {
  const slicesById = new Map<number, CustomerSlice>();
  for (const s of slices) slicesById.set(s.customerId, s);

  const byKey = new Map<string, CappedAssetAggregate>();
  for (const evt of capped) {
    const address = evt.origAddr;
    if (!address) continue;
    const key = `${evt.customerId}/${address}`;
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, {
        customerId: evt.customerId,
        address,
        score: evt.score,
        triagedCount: 1,
        lastEventTimeIso: evt.time,
      });
    } else {
      existing.score += evt.score;
      existing.triagedCount += 1;
      if (evt.time > existing.lastEventTimeIso) {
        existing.lastEventTimeIso = evt.time;
      }
    }
  }

  const assets: TriageAsset[] = [];
  for (const entry of byKey.values()) {
    const slice = slicesById.get(entry.customerId);
    const enrichment = slice?.enrichmentByAddress.get(entry.address);
    assets.push({
      customerId: entry.customerId,
      customerName: slice?.customerName ?? String(entry.customerId),
      address: entry.address,
      detectedCount: enrichment?.detectedCount ?? 0,
      detectedCountUnavailable: enrichment?.detectedCountUnavailable ?? false,
      triagedCount: entry.triagedCount,
      score: entry.score,
      lastEventTimeIso: entry.lastEventTimeIso,
      events: enrichment?.detailEvents ?? [],
    });
  }
  assets.sort(compareAssets);
  return assets.slice(0, TRIAGE_ASSET_PAGE_SIZE);
}

/**
 * Batched per-asset detail SELECT. Runs a single `cume_dist()` pass
 * over the post-`Blocklist*` cohort and then keeps the newest
 * {@link TRIAGE_ASSET_DETAIL_LIMIT} rows for each requested address.
 * Replaces the prior per-address fanout where `selectAssetDetailEvents`
 * recomputed the full-cohort `cume_dist()` once per asset row.
 *
 * The `cume_dist()` partition stays `(kind, baseline_version)` so the
 * detail-panel score for any row equals the score it would carry in
 * the menu — the address filter is applied *after* the window
 * function, not inside the partition.
 *
 * `menuCutoff` is the strictness slider's cutoff (#471). It is applied
 * inside the SQL `filtered` CTE **before** the per-address
 * `ROW_NUMBER()` so that newer sub-cutoff rows cannot push qualifying
 * older rows out of the newest-`TRIAGE_ASSET_DETAIL_LIMIT` window for
 * an address. This is the right place for the cutoff on the detail
 * path (unlike the menu cohort path, RFC §6) because the detail rows
 * have no bucket aggregates to preserve — the analyst contract is
 * simply "every row shown obeys the selected stop's `baseline_score >=
 * cutoff`".
 */
async function selectAssetDetailEventsBatch(
  pool: pg.Pool,
  period: TriagePeriod,
  addresses: ReadonlyArray<string>,
  menuCutoff: number,
  signal: AbortSignal | undefined,
): Promise<Map<string, BaselineEventDetailRow[]>> {
  signal?.throwIfAborted();
  if (addresses.length === 0) return new Map();
  const { rows } = await pool.query<BaselineEventDetailRow>(
    SELECT_ASSET_DETAIL_EVENTS_BATCH_SQL,
    [
      period.startIso,
      period.endIso,
      [...addresses],
      TRIAGE_ASSET_DETAIL_LIMIT,
      menuCutoff,
    ],
  );
  const grouped = new Map<string, BaselineEventDetailRow[]>();
  for (const row of rows) {
    const address = row.orig_addr;
    if (address === null) continue;
    const list = grouped.get(address);
    if (list === undefined) grouped.set(address, [row]);
    else list.push(row);
  }
  return grouped;
}

async function countObserved(
  pool: pg.Pool,
  observedFromIso: string,
  endIso: string,
  signal?: AbortSignal,
): Promise<number> {
  signal?.throwIfAborted();
  const { rows } = await pool.query<{ count: string }>(COUNT_OBSERVED_SQL, [
    observedFromIso,
    endIso,
  ]);
  return rows.length === 0 ? 0 : Number(rows[0].count);
}

async function countTriaged(
  pool: pg.Pool,
  period: TriagePeriod,
  signal?: AbortSignal,
): Promise<number> {
  signal?.throwIfAborted();
  const { rows } = await pool.query<{ count: string }>(COUNT_TRIAGED_SQL, [
    period.startIso,
    period.endIso,
  ]);
  return rows.length === 0 ? 0 : Number(rows[0].count);
}

async function perAssetObservedCounts(
  pool: pg.Pool,
  observedFromIso: string,
  endIso: string,
  addresses: string[],
  signal: AbortSignal | undefined,
): Promise<ObservedCountRow[]> {
  signal?.throwIfAborted();
  if (addresses.length === 0) return [];
  const { rows } = await pool.query<ObservedCountRow>(
    PER_ASSET_OBSERVED_COUNTS_SQL,
    [observedFromIso, endIso, addresses],
  );
  return rows;
}

/**
 * Pick the worst-state customer for the freshness header badge. The
 * ordering matches #458's "summary picks the worst state" rule:
 *   failed > running > rowAbsent > ok.
 */
function pickWorstFreshness(
  customers: TriageCustomerFreshness[],
): TriageCustomerFreshness | null {
  if (customers.length === 0) return null;
  const rank = (c: TriageCustomerFreshness): number => {
    if (c.status === "failed") return 4;
    if (c.status === "running") return 3;
    if (c.rowAbsent) return 2;
    return 1; // status === "ok" (or null with non-rowAbsent — degenerate)
  };
  let worst = customers[0];
  for (const c of customers.slice(1)) {
    const candidateRank = rank(c);
    const worstRank = rank(worst);
    if (candidateRank > worstRank) worst = c;
    else if (candidateRank === worstRank && c.lastIngestedAtIso) {
      // Tiebreaker for equal severity — pick the oldest ingest so the
      // header surfaces the staleness most likely to matter.
      if (
        worst.lastIngestedAtIso === null ||
        c.lastIngestedAtIso < worst.lastIngestedAtIso
      ) {
        worst = c;
      }
    }
  }
  return worst;
}

function buildFreshness(customers: TriageCustomerFreshness[]): TriageFreshness {
  return { customers, worst: pickWorstFreshness(customers) };
}

async function pMapBatched<T, R>(
  inputs: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < inputs.length; i += concurrency) {
    const batch = inputs.slice(i, i + concurrency);
    const results = await Promise.all(batch.map(fn));
    out.push(...results);
  }
  return out;
}

/**
 * Load one period's worth of Triage data from the per-tenant Baseline
 * corpus. Replaces the Phase 1.A `eventList` GraphQL fanout with
 * direct `baseline_triaged_event` + `observed_event_meta` reads
 * against each tenant DB the caller has scope to.
 *
 * Pipeline per request:
 *   1. Resolve scope via {@link buildDispatchContext}.
 *   2. Compute the request-scoped `observedFromIso` clamp from
 *      `max(:from, now() − OBSERVED_EVENT_META_RETENTION_MS)` so every
 *      observed read inside this request shares a single source of
 *      truth.
 *   3. Fan out per-customer with bounded concurrency to load:
 *      §4 menu cohort, per-asset detail events, per-asset observed
 *      counts, freshness header.
 *   4. Merge per-tenant `final_menu_rows` into one cross-tenant list
 *      sorted by `(baseline_score DESC, event_time DESC, event_key
 *      DESC)`, cap at {@link TRIAGE_HARD_EVENT_CAP}, then aggregate
 *      the asset list from the **capped** events so the visible
 *      asset list and the returned pivot corpus are derived from the
 *      same row set. Trim assets to `TRIAGE_ASSET_PAGE_SIZE` keeping
 *      the global ordering. No `OFFSET` is issued in the
 *      multi-customer path: each per-customer slice is a single
 *      bounded read and the cap/aggregation happens in JS.
 *   5. Sum per-customer funnel counts and pick the worst freshness
 *      state across the scope.
 */
export async function loadTriagePeriod(
  session: AuthSession,
  period: TriagePeriod,
  options: { strictness?: StrictnessStopId; signal?: AbortSignal } = {},
): Promise<TriageLoadResult> {
  const { signal } = options;
  const strictness = options.strictness ?? DEFAULT_STRICTNESS_STOP_ID;
  const ctx = await buildDispatchContext(session);
  const customerIds = ctx.customerIds;

  const now = new Date();
  const periodStartMs = Date.parse(period.startIso);
  const observedRetentionStartMs =
    now.getTime() - OBSERVED_EVENT_META_RETENTION_MS;
  // Clamped lower bound, computed once and threaded through every
  // observed_event_meta read in this request.
  const observedFromMs = Math.max(periodStartMs, observedRetentionStartMs);
  const observedFromIso = new Date(observedFromMs).toISOString();
  // Result-level flag: the window's earliest moment is older than the
  // observed retention floor, so the funnel's denominator covers only
  // the in-retention slice.
  const observedDenominatorTruncated = periodStartMs < observedRetentionStartMs;

  if (customerIds.length === 0) {
    // Admin scope with no registered customers — there is nothing to
    // query. Return an empty result rather than spinning up a no-op
    // promise chain.
    return emptyResult(observedDenominatorTruncated, strictness);
  }

  const namesById = await loadCustomerNames(customerIds);
  const slices = await pMapBatched(customerIds, FANOUT_CONCURRENCY, (id) =>
    loadCustomerSlice(
      id,
      namesById.get(id) ?? String(id),
      period,
      observedFromIso,
      observedDenominatorTruncated,
      strictness,
      signal,
    ),
  );

  const detected = slices.reduce((sum, s) => sum + s.detected, 0);
  const triaged = slices.reduce((sum, s) => sum + s.triaged, 0);
  // Branch A: merge per-tenant `final_menu_rows`, sort in §3 priority
  // order, cap at `TRIAGE_HARD_EVENT_CAP` (#471 §2 — unchanged from
  // the foundation slice).
  const mergedScored = slices.flatMap((s) => s.events);
  mergedScored.sort(compareScoredEvents);
  const truncated = mergedScored.length > TRIAGE_HARD_EVENT_CAP;
  const scoredCapped = truncated
    ? mergedScored.slice(0, TRIAGE_HARD_EVENT_CAP)
    : mergedScored;

  // Branch B: merge per-tenant Story-protected rows, apply the
  // independent merge-layer `STORY_PROTECTED_HARD_CAP` (#471 §2
  // "Multi-tenant merge stage — separate cap for protected rows").
  //
  // Dedup of branch B against branch A is decided here, not per-
  // tenant: a Story member that branch A happens to surface inside
  // one tenant can still be dropped by the cross-tenant
  // `TRIAGE_HARD_EVENT_CAP` above, and removing the branch B copy
  // before that cap fires would leave the row with no rescue path
  // (#596 Round 4 item 1). `mergedProtected` therefore carries every
  // branch B row each tenant returned (including overlap with branch
  // A); branch A precedence is applied below in the union loop only
  // for rows that survived the scored cap.
  //
  // The protected cap drops branch B rows that the analyst can still
  // see via branch A — so we sort `mergedProtected` to push rows that
  // depend on branch B's rescue (those whose branch A copy did NOT
  // survive `scoredCapped`) to the head before the cap slices the
  // tail. This keeps the visible Story-member set maximal under the
  // cap.
  const scoredCappedKeys = new Set<string>();
  for (const e of scoredCapped) {
    scoredCappedKeys.add(`${e.customerId}/${e.id}`);
  }
  const mergedProtected = slices.flatMap((s) => s.protectedEvents);
  mergedProtected.sort((a, b) => {
    const aServedByA = scoredCappedKeys.has(`${a.customerId}/${a.id}`);
    const bServedByA = scoredCappedKeys.has(`${b.customerId}/${b.id}`);
    // Rows NOT in `scoredCapped` come first (branch B is their only
    // path to the screen). Among rows in the same priority class the
    // standard §3 tie-breaker decides.
    if (aServedByA !== bServedByA) return aServedByA ? 1 : -1;
    return compareScoredEvents(a, b);
  });
  const protectedCapped =
    mergedProtected.length > STORY_PROTECTED_HARD_CAP
      ? mergedProtected.slice(0, STORY_PROTECTED_HARD_CAP)
      : mergedProtected;

  // Union deduplicated on `(customerId, event_key)`, branch A
  // preferred per the protection contract (incidental Story
  // membership does not get marked).
  const eventsByKey = new Map<string, ScoredTriageEvent>();
  for (const e of scoredCapped) eventsByKey.set(`${e.customerId}/${e.id}`, e);
  for (const e of protectedCapped) {
    const key = `${e.customerId}/${e.id}`;
    if (!eventsByKey.has(key)) eventsByKey.set(key, e);
  }
  const unrankedEvents = Array.from(eventsByKey.values());
  unrankedEvents.sort(compareScoredEvents);
  // #588 impression-metadata threading: assign each event its 1-based
  // rank in the final merged union so the client's impression batch
  // records the exact visible position. Rank is computed after the
  // dedup + sort so it lines up with what the analyst sees, not with
  // the per-tenant slice ordering.
  const events: ScoredTriageEvent[] = unrankedEvents.map((e, idx) => ({
    ...e,
    rank: idx + 1,
  }));

  // `storyProtectedDroppedCount`: count of in-window Story members
  // that did NOT reach the final union. Computed exactly by
  // (a) summing each tenant's unfiltered `COUNT(*) OVER ()` of
  // in-window Story members (the SQL pre-`LIMIT` count) and
  // (b) subtracting the count of Story members that appear in the
  // final `events`. A row is a known Story member when its qualified
  // key is in any slice's `storyMemberKeysQualified` set — that set
  // includes every branch B row each tenant returned and every
  // branch A row whose `MenuCohortDbRow.in_story` was `true` (#596
  // Round 4 item 2). The subtraction handles all three loss
  // scenarios without over-attribution: per-tenant SQL `LIMIT`
  // truncation, cross-tenant `STORY_PROTECTED_HARD_CAP` overflow,
  // and quota-rescue rows that branch A's `composeMenu` happened to
  // drop while branch B's `LIMIT` also clipped the rescue copy.
  const storyMembersKnown = new Set<string>();
  for (const s of slices) {
    for (const k of s.storyMemberKeysQualified) storyMembersKnown.add(k);
  }
  let visibleStoryMembers = 0;
  for (const e of events) {
    if (storyMembersKnown.has(`${e.customerId}/${e.id}`)) {
      visibleStoryMembers += 1;
    }
  }
  const protectedTotalInWindow = slices.reduce(
    (sum, s) => sum + s.protectedTotalInWindow,
    0,
  );
  const storyProtectedDroppedCount = Math.max(
    0,
    protectedTotalInWindow - visibleStoryMembers,
  );
  const storyProtectedTruncated = storyProtectedDroppedCount > 0;

  // Asset list derives from the **post-merge union** events so the
  // visible analyst list and the returned pivot corpus stay aligned
  // even when either cap fires. An asset whose menu rows are all
  // dropped by either cap does not appear.
  const assets = aggregateAssetsFromCappedEvents(events, slices);

  const shown = events.length;
  const passThroughRate =
    detected > 0 ? Math.min(1, Math.max(0, shown / detected)) : 0;
  const freshness = buildFreshness(slices.map((s) => s.freshness));

  // Sum eligible-by-stop counts across the customer scope. Per-stop
  // hints in the slider chip use this; the count is summed (not
  // unioned) because the eligible aggregate is per-tenant and rows
  // from different tenants cannot collide on `event_key`.
  const eligibleByStop = sumEligibleByStop(slices.map((s) => s.eligibleByStop));

  return {
    funnel: { detected, triaged, shown, passThroughRate },
    assets,
    truncated,
    storyProtectedTruncated,
    storyProtectedDroppedCount,
    eligibleByStop,
    loadedEventCount: events.length,
    events,
    observedDenominatorTruncated,
    freshness,
    strictness,
    // #588: per-menu-load UUID. The client posts this back as the
    // schema-level idempotency key so a replay of the same load is a
    // no-op at the database.
    menuLoadId: randomUUID(),
  };
}

function compareScoredEvents(
  a: ScoredTriageEvent,
  b: ScoredTriageEvent,
): number {
  if (b.score !== a.score) return b.score - a.score;
  const t = b.time.localeCompare(a.time);
  if (t !== 0) return t;
  return compareEventKeyDesc(a.id, b.id);
}

function sumEligibleByStop(
  perTenant: ReadonlyArray<EligibleByStop>,
): EligibleByStop {
  const out: EligibleByStop = {};
  for (const stop of STRICTNESS_STOPS) {
    let total = 0;
    let seen = false;
    for (const t of perTenant) {
      const v = t[stop.id];
      if (typeof v === "number") {
        total += v;
        seen = true;
      }
    }
    if (seen) out[stop.id] = total;
  }
  return out;
}

/**
 * Resolve `customers.name` for the given scope. The map is empty when
 * the central DB returns no row for an id — the caller falls back to
 * the stringified id so the detail header always has something
 * non-empty to render.
 */
async function loadCustomerNames(
  customerIds: number[],
): Promise<Map<number, string>> {
  const { rows } = await centralQuery<{ id: number; name: string }>(
    "SELECT id, name FROM customers WHERE id = ANY($1::int[])",
    [customerIds],
  );
  return new Map(rows.map((r) => [r.id, r.name]));
}

function emptyResult(
  observedDenominatorTruncated: boolean,
  strictness: StrictnessStopId,
): TriageLoadResult {
  return {
    funnel: { detected: 0, triaged: 0, shown: 0, passThroughRate: 0 },
    assets: [],
    truncated: false,
    storyProtectedTruncated: false,
    storyProtectedDroppedCount: 0,
    eligibleByStop: {},
    loadedEventCount: 0,
    events: [],
    observedDenominatorTruncated,
    freshness: { worst: null, customers: [] },
    strictness,
  };
}

export const _testing = {
  loadCustomerSlice,
  pickWorstFreshness,
  buildFreshness,
  rowToEvent,
  buildCohort,
  aggregateAssetsFromCappedEvents,
  MENU_CANDIDATES_PER_BUCKET,
  OBSERVED_EVENT_META_RETENTION_MS,
};
