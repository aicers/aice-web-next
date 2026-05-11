import "server-only";

import type pg from "pg";

import type { AuthSession } from "@/lib/auth/jwt";
import { query as centralQuery } from "@/lib/db/client";
import type { ThreatCategory } from "@/lib/detection";

import { compareAssets } from "./aggregate";
import { assembleMenu, type MenuRow } from "./baseline/menu";
import { buildDispatchContext } from "./dispatch-context";
import type { TriagePeriod } from "./period";
import { getCustomerPool } from "./policy/customer-db";
import { baselineScore } from "./scoring";
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
 * `selectMenuEvents` row shape — extends the read columns with the
 * Phase 1.B fields needed by the read-time menu algorithm
 * ({@link assembleMenu}). `baseline_score` here is the read-time
 * `cume_dist()` over `(kind, baseline_version) ORDER BY raw_score`
 * computed inline by the CTE — distinct from the unused-by-Phase-1.B
 * `baseline_triaged_event.baseline_score` column.
 */
interface MenuEventDbRow extends BaselineEventRow {
  baseline_version: string;
  raw_score: number;
  selector_tags: string[] | null;
}

/**
 * Read-time CUME_DIST contract from RFC §3 — production callers pass
 * no additional cutoff (slider owned by #471). Tests inject a strict
 * cutoff to drive the §6 `MIN_NONZERO_FLOOR` fallback.
 */
const DEFAULT_MENU_CUTOFF = 0;

interface AssetAggregateRow {
  address: string;
  triaged_count: string;
  score: number | null;
  last_event_time: Date | null;
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
 * Run one tenant's slice of the Triage menu read: asset-list
 * aggregation, per-asset detail fetch, per-asset detected counts, the
 * freshness header row, and the pivot-index corpus events list. All
 * five queries share the same period window plus the request-scoped
 * `observedFromIso` clamp.
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

  // 1. Aggregated asset list — single tenant, LIMIT/OFFSET shape.
  const assetRows = await selectAssetAggregate(pool, period, signal);
  signal?.throwIfAborted();

  if (assetRows.length === 0) {
    const detected = await countObserved(pool, observedFromIso, period.endIso);
    const triaged = await countTriaged(pool, period);
    return {
      customerId,
      assets: [],
      events: [],
      detected,
      triaged,
      freshness,
    };
  }

  const addresses = assetRows.map((r) => r.address);

  // 2. Funnel + 3. per-asset observed COUNT + 4. per-asset detail
  //    events + 5. flat corpus events for the pivot index fan out in
  //    parallel — the reads are independent and each one bounded.
  const [detected, triaged, observedCounts, perAssetEvents, menuEventRows] =
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
      Promise.all(
        addresses.map((address) =>
          selectAssetDetailEvents(pool, period, address, signal),
        ),
      ),
      selectMenuEvents(pool, period, signal),
    ]);

  const observedByAddress = new Map<string, number>();
  for (const row of observedCounts) {
    observedByAddress.set(row.address, Number(row.detected_count));
  }

  const assets: TriageAsset[] = assetRows.map((row, idx) => {
    const events = perAssetEvents[idx].map((dbRow, eventIdx) => {
      const event = rowToEvent(dbRow);
      const score = dbRow.baseline_score ?? baselineScore(event);
      const scored: ScoredTriageEvent = {
        ...event,
        score,
        customerId,
        rowKey: `${customerId}/${row.address}#${eventIdx}`,
      };
      return scored;
    });
    const observed = observedByAddress.get(row.address);
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
      address: row.address,
      detectedCount,
      detectedCountUnavailable,
      triagedCount: Number(row.triaged_count),
      score: row.score ?? 0,
      // Carry the per-tenant `MAX(event_time)` through so the cross-
      // customer merge preserves the issue's `score DESC,
      // last_event_time DESC` ordering. The SQL ORDER BY uses the
      // same value within a tenant; the merge step relies on it to
      // resolve ties across tenants.
      lastEventTimeIso: row.last_event_time?.toISOString() ?? null,
      events,
    };
  });

  // The pivot index runs over the menu algorithm's output — the
  // §4 `final_menu_rows` set, capped at `default_N` (RFC §6) with the
  // §6 `MIN_NONZERO_FLOOR` fallback applied when the per-bucket
  // composition falls below the floor. The assembly here uses
  // {@link DEFAULT_MENU_CUTOFF} (no additional cutoff above the
  // cohort) because the slider that owns the cutoff dial is in #471;
  // production output is determined by quota + fallback alone.
  const events: ScoredTriageEvent[] = assembleScoredEvents(
    menuEventRows,
    customerId,
  );

  return {
    customerId,
    assets,
    events,
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

async function selectAssetAggregate(
  pool: pg.Pool,
  period: TriagePeriod,
  signal: AbortSignal | undefined,
): Promise<AssetAggregateRow[]> {
  signal?.throwIfAborted();
  // RFC §3 stored-score / §4: `baseline_score` is read-time
  // `cume_dist()` over `(kind, baseline_version) ORDER BY raw_score`.
  // The pre-existing `baseline_triaged_event.baseline_score` column
  // is Phase 1.A-only (NULL for Phase 1.B rows), so summing it here
  // would silently zero out the score on every Phase 1.B asset.
  // The CTE computes the read-time score in one window pass and the
  // aggregate then sums it per asset.
  //
  // Defensive `kind NOT LIKE 'BlockList%'` per RFC §1: cadence
  // already excludes these on the cadence-side INSERT (PR 2 / #513),
  // but the menu read keeps the guard so a regression on the cadence
  // side cannot leak BlockList* rows into the menu's slot allocation
  // or asset scoring.
  //
  // Single-tenant fast path — LIMIT/OFFSET is permitted here per
  // #458's "single-tenant SQL example". The multi-tenant code path
  // calls this same query per customer and then merges in JS, which
  // is an aggregate-then-merge equivalent of the keyset-cursor model
  // documented in the issue (no per-customer OFFSET).
  const { rows } = await pool.query<AssetAggregateRow>(
    `WITH scored AS (
       SELECT orig_addr,
              event_time,
              cume_dist() OVER (
                PARTITION BY kind, baseline_version
                ORDER BY raw_score
              ) AS baseline_score
         FROM baseline_triaged_event
        WHERE event_time >= $1
          AND event_time <  $2
          AND kind NOT LIKE 'BlockList%'
     )
     SELECT s.orig_addr::text                       AS address,
            COUNT(*)::text                          AS triaged_count,
            SUM(s.baseline_score)::double precision AS score,
            MAX(s.event_time)                       AS last_event_time
       FROM scored s
      WHERE s.orig_addr IS NOT NULL
      GROUP BY s.orig_addr
      ORDER BY score DESC NULLS LAST,
               last_event_time DESC
      LIMIT $3`,
    [period.startIso, period.endIso, TRIAGE_ASSET_PAGE_SIZE],
  );
  return rows;
}

/**
 * Read the period's post-`BlockList*` corpus rows with the read-time
 * `cume_dist()` `baseline_score` attached per RFC §3, then hand them
 * to {@link assembleMenu} for the §4 slot-bucket + quota composition
 * and the §6 `MIN_NONZERO_FLOOR` fallback. Bounded above by
 * {@link TRIAGE_HARD_EVENT_CAP} on the SQL side as a defense-in-
 * depth read cap; the algorithm's own `default_N` cap is far smaller
 * in practice.
 *
 * `slot_bucket` is computed in TypeScript rather than in SQL so the
 * algorithm and the SQL stay independently testable. Per RFC §4 the
 * SQL only needs to deliver `raw_score`, `baseline_version`,
 * `selector_tags`, and the per-row metadata — the bucket key is a
 * pure function of `(kind, selector_tags)` and lives next to the
 * largest-remainder pass in {@link assembleMenu}.
 */
async function selectMenuEvents(
  pool: pg.Pool,
  period: TriagePeriod,
  signal: AbortSignal | undefined,
): Promise<MenuEventDbRow[]> {
  signal?.throwIfAborted();
  const { rows } = await pool.query<MenuEventDbRow>(
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
              ) AS baseline_score
         FROM baseline_triaged_event
        WHERE event_time >= $1
          AND event_time <  $2
          AND kind NOT LIKE 'BlockList%'
     )
     SELECT event_key::text         AS event_key,
            event_time,
            kind,
            sensor,
            orig_addr::text         AS orig_addr,
            resp_addr::text         AS resp_addr,
            orig_port,
            resp_port,
            host,
            dns_query,
            uri,
            category,
            baseline_version,
            raw_score,
            selector_tags,
            baseline_score::double precision AS baseline_score
       FROM scored
      ORDER BY baseline_score DESC, event_time DESC, event_key DESC
      LIMIT $3`,
    [period.startIso, period.endIso, TRIAGE_HARD_EVENT_CAP],
  );
  return rows;
}

/**
 * Run the §4 slot-bucket + quota composition (and the §6 fallback)
 * on a per-tenant {@link selectMenuEvents} result, then re-wrap the
 * surviving rows in {@link ScoredTriageEvent} shape for the menu /
 * pivot consumers. `rowKey` keeps the `${customerId}/${event_key}`
 * convention so the cross-tenant merge in {@link loadTriagePeriod}
 * deduplicates correctly.
 */
function assembleScoredEvents(
  dbRows: ReadonlyArray<MenuEventDbRow>,
  customerId: number,
): ScoredTriageEvent[] {
  const menuRows: MenuRow[] = dbRows.map((r) => ({
    eventKey: r.event_key,
    eventTime: r.event_time,
    kind: r.kind,
    baselineVersion: r.baseline_version,
    rawScore: r.raw_score,
    baselineScore: r.baseline_score ?? 0,
    selectorTags: r.selector_tags ?? [],
  }));
  const dbRowByKey = new Map(dbRows.map((r) => [r.event_key, r]));

  const result = assembleMenu(menuRows, DEFAULT_MENU_CUTOFF);
  return result.rows.map((row) => {
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

async function selectAssetDetailEvents(
  pool: pg.Pool,
  period: TriagePeriod,
  address: string,
  signal: AbortSignal | undefined,
): Promise<BaselineEventRow[]> {
  signal?.throwIfAborted();
  // `baseline_score` is the read-time CUME_DIST per RFC §3, computed
  // over the full post-BlockList* cohort in the window so per-cohort
  // rankings are consistent with the menu read in
  // {@link selectMenuEvents}. The pre-existing Phase 1.A
  // `baseline_score` column is unused here (NULL for Phase 1.B rows).
  // The defensive `kind NOT LIKE 'BlockList%'` mirrors the menu SQL.
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
     )
     SELECT event_key::text         AS event_key,
            event_time,
            kind,
            sensor,
            orig_addr::text         AS orig_addr,
            resp_addr::text         AS resp_addr,
            orig_port,
            resp_port,
            host,
            dns_query,
            uri,
            category,
            baseline_score::double precision AS baseline_score
       FROM scored
      WHERE orig_addr  =  $3
        AND orig_addr IS NOT NULL
      ORDER BY event_time DESC
      LIMIT $4`,
    [period.startIso, period.endIso, address, TRIAGE_ASSET_DETAIL_LIMIT],
  );
  return rows;
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
 * SELECTs each pull `TRIAGE_ASSET_PAGE_SIZE` candidates ordered by
 * `score DESC, last_event_time DESC`; this function merges them and
 * trims to `TRIAGE_ASSET_PAGE_SIZE` keeping the global ordering.
 *
 * Implementation note: a true keyset-cursor model encodes a per-
 * customer continuation cursor (`{ customerId → (last_score,
 * last_event_time, last_address) }`); this issue ships the first-page
 * shape only — the menu does not yet expose Next/Prev pagination
 * controls and the page-size bound holds within one customer's slice.
 * No `OFFSET` is issued in the multi-customer path: each per-customer
 * slice is a single LIMIT-bounded read and the merge happens in JS.
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
 *      asset-list aggregation, per-asset detail events, per-asset
 *      observed counts, freshness header.
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
  // ordered newest-first and trimmed to the global cap. Sourced from
  // per-customer `selectCorpusEvents` results (not `assets[*].events`)
  // so pivot coverage is not narrowed by the asset page or per-asset
  // detail cap.
  const mergedEvents = slices.flatMap((s) => s.events);
  mergedEvents.sort((a, b) => b.time.localeCompare(a.time));
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
  OBSERVED_EVENT_META_RETENTION_MS,
};
