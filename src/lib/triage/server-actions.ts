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
import { buildDispatchContext } from "./dispatch-context";
import type { TriagePeriod } from "./period";
import { getCustomerPool } from "./policy/customer-db";
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
 * `loadTriagePeriod` always returns a single page; future
 * forward-pagination work would extend the cursor model documented
 * below in {@link mergeAssetPages}.
 */
export const TRIAGE_ASSET_PAGE_SIZE = 100;

/** Bound on the per-asset detail panel (newest-first). */
export const TRIAGE_ASSET_DETAIL_LIMIT = 50;

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
 * Concurrency budget for the per-customer fanout. Matches the
 * dispatcher pattern from #487 — small enough that a multi-tenant
 * page does not stampede the connection pool, large enough that the
 * common 1–4 customer scope completes in one batch.
 */
const FANOUT_CONCURRENCY = 4;

/**
 * Upper bound on the per-bucket candidate rows the menu SELECT returns.
 *
 * The §4 composition takes at most `quota[b]` rows from each bucket,
 * and `Σ quota[b] = default_N`, so per-bucket quota is bounded above
 * by `default_N`. Even at extreme cohort sizes (`post_exclusion ≈
 * 1e12`) the §6 curve caps `default_N` near 400, so loading the top
 * 500 rows per bucket is a strict superset of anything the algorithm
 * can use, while leaving the SQL response bounded by `buckets · 500`
 * — a few thousand rows in the worst case. Per-bucket COUNT and
 * tag-cardinality SUMs travel as window-function columns on every
 * row so the algorithm sees the full-cohort aggregates even though
 * the row set is capped.
 */
const MENU_CANDIDATES_PER_BUCKET = 500;

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
 * post-`BlockList*` cohort. The columns are constant across all rows
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

/**
 * Read-time CUME_DIST contract from RFC §3 — production callers pass
 * no additional cutoff (slider owned by #471). Tests inject a strict
 * cutoff to drive the §6 `MIN_NONZERO_FLOOR` fallback.
 */
const DEFAULT_MENU_CUTOFF = 0;

interface ObservedCountRow {
  address: string;
  detected_count: string;
}

interface CorpusStateRow {
  last_ingested_at: Date | null;
  last_run_status: TriageCustomerFreshness["status"] | null;
  last_error: string | null;
}

interface CustomerSlice {
  customerId: number;
  assets: TriageAsset[];
  events: ScoredTriageEvent[];
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
 * `selectMenuCohort` call delivers the post-`BlockList*` cohort with
 * §3 `baseline_score` and §4 per-bucket aggregates attached; the
 * algorithm composes `final_menu_rows`, and `assets` are aggregated
 * from those rows so the analyst-facing list is governed by the same
 * quota / cutoff / `MIN_NONZERO_FLOOR` contract as the pivot corpus.
 * Per-asset observed counts, detail events, and the freshness header
 * row fan out independently.
 */
async function loadCustomerSlice(
  customerId: number,
  customerName: string,
  period: TriagePeriod,
  observedFromIso: string,
  observedDenominatorTruncated: boolean,
  signal: AbortSignal | undefined,
): Promise<CustomerSlice> {
  signal?.throwIfAborted();
  const pool = await getCustomerPool(customerId);

  const freshness = await readFreshness(pool, customerId, signal);
  signal?.throwIfAborted();

  // 1. §4/§6 menu cohort — one SQL pass returns the post-exclusion
  //    cohort aggregates plus per-bucket top-K candidate rows.
  const cohort = await selectMenuCohort(pool, period, signal);
  signal?.throwIfAborted();

  const menuResult = composeMenuFromCohort(cohort);
  const menuRows = menuResult.rows;
  const dbRowByKey = new Map(cohort.candidates.map((r) => [r.event_key, r]));

  // 2. Asset list derives from the §4 final_menu_rows. The visible
  //    Triage menu is governed by quota / cutoff / MIN_NONZERO_FLOOR
  //    end-to-end — an asset that ranks highly only by rows outside
  //    the menu composition does not appear on the list.
  const assetEntries = aggregateAssetsFromMenu(menuRows, dbRowByKey);
  const addresses = assetEntries.map((a) => a.address);

  if (assetEntries.length === 0) {
    const [detected, triaged] = await Promise.all([
      countObserved(pool, observedFromIso, period.endIso, signal),
      countTriaged(pool, period, signal),
    ]);
    return {
      customerId,
      assets: [],
      events: menuRowsToScoredEvents(menuRows, dbRowByKey, customerId),
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

  const assets: TriageAsset[] = assetEntries.map((entry) => {
    const detailRows = detailRowsByAddress.get(entry.address) ?? [];
    const events = detailRows.map((dbRow, eventIdx) => {
      const event = rowToEvent(dbRow);
      const score = dbRow.baseline_score ?? 0;
      const scored: ScoredTriageEvent = {
        ...event,
        score,
        customerId,
        rowKey: `${customerId}/${entry.address}#${eventIdx}`,
      };
      return scored;
    });
    const observed = observedByAddress.get(entry.address);
    const detectedCount = observed ?? 0;
    // The per-asset truncation predicate fires when the request-level
    // truncation flag holds AND this asset has no in-retention
    // observed row. Keeping the type as `number` (per the issue's
    // explicit "no widening") means consumers can sort on it without
    // a special-case path.
    const detectedCountUnavailable =
      observedDenominatorTruncated && observed === undefined;
    return {
      customerId,
      customerName,
      address: entry.address,
      detectedCount,
      detectedCountUnavailable,
      triagedCount: entry.triagedCount,
      score: entry.score,
      // The §3 tie-breaker for the asset-list ordering uses the
      // newest menu-row event_time for the asset, so the merged
      // ordering across tenants matches `score DESC, last_event_time
      // DESC` from the per-asset menu contribution.
      lastEventTimeIso: entry.lastEventTimeIso,
      events,
    };
  });

  return {
    customerId,
    assets,
    events: menuRowsToScoredEvents(menuRows, dbRowByKey, customerId),
    detected,
    triaged,
    freshness,
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
 * the full post-`BlockList*` window. The `ranked` CTE attaches three
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
 * Defensive `kind NOT LIKE 'BlockList%'` per RFC §1: cadence already
 * excludes these on the cadence-side INSERT (PR 2 / #513), but the
 * menu read keeps the guard so a regression on the cadence side
 * cannot leak BlockList* rows into either the asset list or the
 * pivot corpus.
 */
async function selectMenuCohort(
  pool: pg.Pool,
  period: TriagePeriod,
  signal: AbortSignal | undefined,
): Promise<MenuCohort> {
  signal?.throwIfAborted();
  const { rows } = await pool.query<MenuCohortDbRow>(
    `WITH scored AS (
       SELECT event_key,
              event_time,
              kind,
              sensor,
              orig_addr,
              resp_addr,
              orig_port,
              resp_port,
              host,
              dns_query,
              uri,
              category,
              baseline_version,
              raw_score,
              selector_tags,
              cume_dist() OVER (
                PARTITION BY kind, baseline_version
                ORDER BY raw_score
              ) AS baseline_score,
              (kind = 'HttpThreat'
               AND 'unlabeled-cluster' = ANY(selector_tags)) AS is_unlabeled
         FROM baseline_triaged_event
        WHERE event_time >= $1
          AND event_time <  $2
          AND kind NOT LIKE 'BlockList%'
     ),
     ranked AS (
       SELECT *,
              ROW_NUMBER() OVER (
                PARTITION BY kind, is_unlabeled
                ORDER BY baseline_score DESC, event_time DESC, event_key DESC
              ) AS bucket_rn,
              COUNT(*) OVER (PARTITION BY kind, is_unlabeled) AS bucket_count,
              SUM(coalesce(cardinality(selector_tags), 0))
                OVER (PARTITION BY kind, is_unlabeled) AS bucket_tag_sum,
              COUNT(*) OVER () AS cohort_count
         FROM scored
     )
     SELECT event_key::text                       AS event_key,
            event_time,
            kind,
            sensor,
            orig_addr::text                       AS orig_addr,
            resp_addr::text                       AS resp_addr,
            orig_port,
            resp_port,
            host,
            dns_query,
            uri,
            category,
            baseline_version,
            raw_score,
            selector_tags,
            baseline_score::double precision      AS baseline_score,
            is_unlabeled,
            bucket_count::text                    AS bucket_count,
            bucket_tag_sum::text                  AS bucket_tag_sum,
            cohort_count::text                    AS cohort_count
       FROM ranked
      WHERE bucket_rn <= $3
      ORDER BY baseline_score DESC, event_time DESC, event_key DESC`,
    [period.startIso, period.endIso, MENU_CANDIDATES_PER_BUCKET],
  );
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
 * and per-bucket candidates. Production callers pass the
 * {@link DEFAULT_MENU_CUTOFF} (no additional cutoff above the
 * cohort) because the slider that owns the cutoff dial is in #471;
 * output is determined entirely by quota + fallback alone.
 */
function composeMenuFromCohort(cohort: MenuCohort) {
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
    cutoff: DEFAULT_MENU_CUTOFF,
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

interface AssetEntry {
  address: string;
  score: number;
  triagedCount: number;
  lastEventTimeIso: string | null;
}

/**
 * Aggregate `final_menu_rows` into the per-asset entries that drive
 * the asset list. `score` is the sum of `baseline_score` across the
 * asset's menu rows (matching the §3 cohort-relative semantic), so
 * the analyst-facing list is governed end-to-end by §4 / §6 — an
 * asset cannot rank highly from rows that did not survive the menu
 * composition.
 */
function aggregateAssetsFromMenu(
  menuRows: ReadonlyArray<MenuRow>,
  dbRowByKey: ReadonlyMap<string, MenuCohortDbRow>,
): AssetEntry[] {
  const byAddress = new Map<string, AssetEntry>();
  for (const row of menuRows) {
    const dbRow = dbRowByKey.get(row.eventKey);
    if (dbRow === undefined) continue;
    const address = dbRow.orig_addr;
    if (address === null) continue;
    const entry = byAddress.get(address);
    const isoTime = row.eventTime.toISOString();
    if (entry === undefined) {
      byAddress.set(address, {
        address,
        score: row.baselineScore,
        triagedCount: 1,
        lastEventTimeIso: isoTime,
      });
    } else {
      entry.score += row.baselineScore;
      entry.triagedCount += 1;
      if (entry.lastEventTimeIso === null || isoTime > entry.lastEventTimeIso) {
        entry.lastEventTimeIso = isoTime;
      }
    }
  }
  return Array.from(byAddress.values());
}

/**
 * Batched per-asset detail SELECT. Runs a single `cume_dist()` pass
 * over the post-`BlockList*` cohort and then keeps the newest
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
    `WITH scored AS (
       SELECT event_key,
              event_time,
              kind,
              sensor,
              orig_addr,
              resp_addr,
              orig_port,
              resp_port,
              host,
              dns_query,
              uri,
              category,
              cume_dist() OVER (
                PARTITION BY kind, baseline_version
                ORDER BY raw_score
              ) AS baseline_score
         FROM baseline_triaged_event
        WHERE event_time >= $1
          AND event_time <  $2
          AND kind NOT LIKE 'BlockList%'
     ),
     filtered AS (
       SELECT *,
              ROW_NUMBER() OVER (
                PARTITION BY orig_addr
                ORDER BY event_time DESC, event_key DESC
              ) AS rn
         FROM scored
        WHERE orig_addr IS NOT NULL
          AND orig_addr::text = ANY($3::text[])
     )
     SELECT event_key::text                  AS event_key,
            event_time,
            kind,
            sensor,
            orig_addr::text                  AS orig_addr,
            resp_addr::text                  AS resp_addr,
            orig_port,
            resp_port,
            host,
            dns_query,
            uri,
            category,
            baseline_score::double precision AS baseline_score
       FROM filtered
      WHERE rn <= $4
      ORDER BY orig_addr, event_time DESC`,
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
  const { rows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM observed_event_meta
      WHERE event_time >= $1
        AND event_time <  $2`,
    [observedFromIso, endIso],
  );
  return rows.length === 0 ? 0 : Number(rows[0].count);
}

async function countTriaged(
  pool: pg.Pool,
  period: TriagePeriod,
  signal?: AbortSignal,
): Promise<number> {
  signal?.throwIfAborted();
  const { rows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM baseline_triaged_event
      WHERE event_time >= $1
        AND event_time <  $2`,
    [period.startIso, period.endIso],
  );
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
    `SELECT o.orig_addr::text AS address,
            COUNT(*)::text     AS detected_count
       FROM observed_event_meta o
      WHERE o.event_time >= $1
        AND o.event_time <  $2
        AND o.orig_addr IS NOT NULL
        AND o.orig_addr::text = ANY($3::text[])
      GROUP BY o.orig_addr`,
    [observedFromIso, endIso, addresses],
  );
  return rows;
}

/**
 * Merge per-customer asset pages into a unified page. The per-customer
 * SELECTs each produce a slice ordered by
 * `score DESC, last_event_time DESC`; this function merges them and
 * trims to `TRIAGE_ASSET_PAGE_SIZE` keeping the global ordering.
 *
 * Implementation note: a true keyset-cursor model encodes a per-
 * customer continuation cursor (`{ customerId → (last_score,
 * last_event_time, last_address) }`); this issue ships the first-page
 * shape only — the menu does not yet expose Next/Prev pagination
 * controls and the page-size bound holds within one customer's slice.
 * No `OFFSET` is issued in the multi-customer path: each per-customer
 * slice is a single bounded read and the merge happens in JS.
 */
function mergeAssetPages(slices: CustomerSlice[]): TriageAsset[] {
  const all = slices.flatMap((s) => s.assets);
  all.sort(compareAssets);
  return all.slice(0, TRIAGE_ASSET_PAGE_SIZE);
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
 *   4. Merge per-customer asset pages into one global page sorted by
 *      `(score, triagedCount, detectedCount, address, customerId)`.
 *   5. Sum per-customer funnel counts and pick the worst freshness
 *      state across the scope.
 */
export async function loadTriagePeriod(
  session: AuthSession,
  period: TriagePeriod,
  signal?: AbortSignal,
): Promise<TriageLoadResult> {
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
    return emptyResult(observedDenominatorTruncated);
  }

  const namesById = await loadCustomerNames(customerIds);
  const slices = await pMapBatched(customerIds, FANOUT_CONCURRENCY, (id) =>
    loadCustomerSlice(
      id,
      namesById.get(id) ?? String(id),
      period,
      observedFromIso,
      observedDenominatorTruncated,
      signal,
    ),
  );

  const assets = mergeAssetPages(slices);
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

function emptyResult(observedDenominatorTruncated: boolean): TriageLoadResult {
  return {
    funnel: { detected: 0, triaged: 0, passThroughRate: 0 },
    assets: [],
    truncated: false,
    loadedEventCount: 0,
    events: [],
    observedDenominatorTruncated,
    freshness: { worst: null, customers: [] },
  };
}

export const _testing = {
  loadCustomerSlice,
  pickWorstFreshness,
  buildFreshness,
  rowToEvent,
  buildCohort,
  aggregateAssetsFromMenu,
  MENU_CANDIDATES_PER_BUCKET,
  OBSERVED_EVENT_META_RETENTION_MS,
};
