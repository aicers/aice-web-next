import "server-only";

import type pg from "pg";

import type { AuthSession } from "@/lib/auth/jwt";
import { query as centralQuery } from "@/lib/db/client";
import type { ThreatCategory } from "@/lib/detection";

import { compareAssets } from "./aggregate";
import {
  type BucketAggregate,
  bucketKey,
  compareEventKeyDesc,
  composeMenu,
  type MenuRow,
} from "./baseline/menu";
import {
  COUNT_OBSERVED_SQL,
  COUNT_TRIAGED_SQL,
  MENU_CANDIDATES_PER_BUCKET,
  PER_ASSET_OBSERVED_COUNTS_SQL,
  SELECT_ASSET_DETAIL_EVENTS_BATCH_SQL,
  SELECT_MENU_COHORT_SQL,
  TRIAGE_ASSET_DETAIL_LIMIT,
} from "./baseline/read-path-sql.mjs";
import { buildDispatchContext } from "./dispatch-context";
import type { TriagePeriod } from "./period";
import { getCustomerPool } from "./policy/customer-db";
import {
  cutoffForStop,
  DEFAULT_STRICTNESS_STOP_ID,
  type StrictnessStopId,
} from "./strictness/stops";
import {
  type ScoredTriageEvent,
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
  /** Per-asset enrichment keyed by `orig_addr` for this tenant. */
  enrichmentByAddress: Map<string, AssetEnrichment>;
  detected: number;
  triaged: number;
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
  menuCutoff: number,
  signal: AbortSignal | undefined,
): Promise<CustomerSlice> {
  signal?.throwIfAborted();
  const pool = await getCustomerPool(customerId);

  const freshness = await readFreshness(pool, customerId, signal);
  signal?.throwIfAborted();

  // 1. §4/§6 menu cohort — one SQL pass returns the post-exclusion
  //    cohort aggregates plus per-bucket top-K candidate rows. The
  //    strictness slider's cutoff (#471) is NOT applied at the SQL
  //    level — `composeMenu` owns the filter (RFC §6 option (a),
  //    "cutoff on top of unchanged quota") so the full-cohort bucket
  //    aggregates that drive quota allocation are not narrowed by the
  //    slider. Filtering in SQL would drop buckets whose rows all sit
  //    below the cutoff and silently redistribute their quota.
  const cohort = await selectMenuCohort(pool, period, signal);
  signal?.throwIfAborted();

  const menuResult = composeMenuFromCohort(cohort, menuCutoff);
  const menuRows = menuResult.rows;
  const dbRowByKey = new Map(cohort.candidates.map((r) => [r.event_key, r]));

  const events = menuRowsToScoredEvents(menuRows, dbRowByKey, customerId);

  // Addresses we need per-asset enrichment for: every distinct
  // `orig_addr` that contributed at least one row to this tenant's
  // menu. The cap in `loadTriagePeriod` may drop some of those rows
  // later, so we load enrichment for the wider set here — an asset
  // whose menu rows are all evicted by the cap simply never gets
  // joined back to its enrichment row.
  const addresses = uniqueAddresses(events);

  if (addresses.length === 0) {
    const [detected, triaged] = await Promise.all([
      countObserved(pool, observedFromIso, period.endIso, signal),
      countTriaged(pool, period, signal),
    ]);
    return {
      customerId,
      customerName,
      events,
      enrichmentByAddress: new Map(),
      detected,
      triaged,
      freshness,
    };
  }

  // 3. Funnel + per-asset observed COUNT + per-asset detail events
  //    fan out in parallel — the reads are independent and bounded.
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
      selectAssetDetailEventsBatch(pool, period, addresses, signal),
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
        rowKey: `${customerId}/${address}#${eventIdx}`,
      };
      return scored;
    });
    const observed = observedByAddress.get(address);
    const detectedCount = observed ?? 0;
    // The per-asset truncation predicate fires when the request-level
    // truncation flag holds AND this asset has no in-retention
    // observed row. Keeping the type as `number` (per the issue's
    // explicit "no widening") means consumers can sort on it without
    // a special-case path.
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
    enrichmentByAddress,
    detected,
    triaged,
    freshness,
  };
}

function uniqueAddresses(events: ReadonlyArray<ScoredTriageEvent>): string[] {
  const seen = new Set<string>();
  for (const e of events) {
    if (e.origAddr) seen.add(e.origAddr);
  }
  return Array.from(seen);
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
 * Run the §4/§6 composition over the SQL-delivered cohort aggregates
 * and per-bucket candidates. `menuCutoff` carries the strictness
 * slider's cutoff (#471); the "All" stop passes `0` (no additional
 * cutoff above the cadence threshold). The cutoff is applied here in
 * the algorithm (not in the read-path SQL) so the full-cohort bucket
 * aggregates that drive `composeMenu`'s quota allocation are
 * preserved — RFC §6 option (a), "cutoff on top of unchanged quota".
 */
function composeMenuFromCohort(cohort: MenuCohort, menuCutoff: number) {
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
  });
}

function menuRowsToScoredEvents(
  rows: ReadonlyArray<MenuRow>,
  dbRowByKey: ReadonlyMap<string, MenuCohortDbRow>,
  customerId: number,
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
 */
async function selectAssetDetailEventsBatch(
  pool: pg.Pool,
  period: TriagePeriod,
  addresses: ReadonlyArray<string>,
  signal: AbortSignal | undefined,
): Promise<Map<string, BaselineEventRow[]>> {
  signal?.throwIfAborted();
  if (addresses.length === 0) return new Map();
  const { rows } = await pool.query<BaselineEventRow>(
    SELECT_ASSET_DETAIL_EVENTS_BATCH_SQL,
    [period.startIso, period.endIso, [...addresses], TRIAGE_ASSET_DETAIL_LIMIT],
  );
  const grouped = new Map<string, BaselineEventRow[]>();
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
  const menuCutoff = cutoffForStop(strictness);
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
      menuCutoff,
      signal,
    ),
  );

  const detected = slices.reduce((sum, s) => sum + s.detected, 0);
  const triaged = slices.reduce((sum, s) => sum + s.triaged, 0);
  // Pivot index needs a flat scored events list across customers,
  // built from the union of per-tenant §4 `final_menu_rows` so the
  // pivot corpus matches the analyst's visible menu end-to-end. The
  // cross-tenant cap is applied in §3 priority order
  // (`baseline_score DESC, event_time DESC, event_key DESC`) so a
  // multi-tenant scope with more than `TRIAGE_HARD_EVENT_CAP`
  // composed rows drops the lowest-priority rows first. `id` mirrors
  // `event_key` through `rowToEvent` (a NUMERIC(39,0) stringified via
  // `::text`), so the numeric-string comparator from menu.ts is the
  // correct DESC order — plain `localeCompare` would put "10" before
  // "9" and pick the wrong row at the cap boundary.
  const mergedEvents = slices.flatMap((s) => s.events);
  mergedEvents.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const t = b.time.localeCompare(a.time);
    if (t !== 0) return t;
    return compareEventKeyDesc(a.id, b.id);
  });
  const truncated = mergedEvents.length > TRIAGE_HARD_EVENT_CAP;
  const events = truncated
    ? mergedEvents.slice(0, TRIAGE_HARD_EVENT_CAP)
    : mergedEvents;
  // Asset list derives from the **capped** events so the visible
  // analyst list and the returned pivot corpus stay aligned even when
  // the cross-tenant cap fires. An asset whose menu rows are all
  // dropped by the cap does not appear; an asset whose menu rows are
  // partially dropped has its `score` / `triagedCount` /
  // `lastEventTimeIso` reflect only the surviving rows. Per-tenant
  // enrichment (`customerName`, `detectedCount`,
  // `detectedCountUnavailable`, detail-panel events) is joined back
  // from the slice that produced each surviving row.
  const assets = aggregateAssetsFromCappedEvents(events, slices);
  const passThroughRate =
    detected > 0 ? Math.min(1, Math.max(0, triaged / detected)) : 0;
  const freshness = buildFreshness(slices.map((s) => s.freshness));

  return {
    funnel: { detected, triaged, passThroughRate },
    assets,
    truncated,
    loadedEventCount: events.length,
    events,
    observedDenominatorTruncated,
    freshness,
    strictness,
  };
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
    funnel: { detected: 0, triaged: 0, passThroughRate: 0 },
    assets: [],
    truncated: false,
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
