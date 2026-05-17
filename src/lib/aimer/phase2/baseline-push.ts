/**
 * Phase 2 baseline streaming push payload loader (sub-issue #571).
 *
 * Used by `POST /api/aimer/phase2/baseline-event/next-batch` to assemble
 * the new-row batch payload that goes into a `phase2.baseline.v1`
 * envelope. Reads `baseline_triaged_event` past the cursor stored in
 * `aimer_push_state` and enriches each row with the RFC 0002 §6
 * baseline-batch fields that are NOT persisted on the corpus row:
 *
 *   - `window_signals` — S1 / S3 / S4 + correlated event_keys at push
 *     time, computed by the same SQL the menu uses for window-level
 *     signals (RFC 0001 §8 against `observed_event_meta`).
 *   - `score_window_context` — `kind_cohort_window`, `kind_cohort_size`,
 *     `baseline_rank_snapshot` (`CUME_DIST()` over the same-kind /
 *     same-baseline_version slice at push time).
 *   - `asset_context` — `primary_asset` + a small `peer_event_summary`
 *     condensing other baseline-passing events from the same asset in
 *     the same window.
 *   - `scoring_weights_snapshot` — the §9 selector weights / saturation
 *     caps / tag thresholds in effect at push time.
 *
 * Per-event budget for `asset_context.peer_event_summary` is held under
 * 2 KB by limiting `top_peer_kinds` to {@link PEER_KIND_TOP_LIMIT}.
 *
 * The slice is limited per call by the shared
 * {@link PHASE2_REFRESH_PAYLOAD_MAX_BYTES} budget so a single round-trip
 * stays well below aimer-web's `BRIDGE_MAX_PAYLOAD_BYTES` ceiling — the
 * drain loop handles multi-batch progress on its own.
 */

import "server-only";

import type pg from "pg";

import {
  type BaselineRefreshEvent,
  PHASE2_REFRESH_EXTERNAL_KEY_RESERVE_BYTES,
  PHASE2_REFRESH_PAYLOAD_MAX_BYTES,
} from "@/lib/aimer/phase2/payload-builders";
import {
  SELECTOR_SATURATION,
  SELECTOR_TAGS,
  SELECTOR_WEIGHTS,
  STATISTICS_WINDOW_DAYS,
  TAG_THRESHOLDS,
} from "@/lib/triage/baseline/tunables";
import { getCustomerPool } from "@/lib/triage/policy/customer-db";

/**
 * Default page size — upper bound on rows pulled per call before the
 * byte budget kicks in. Sized to ~baseline cadence page so the SQL
 * round-trip cost stays bounded even on very busy tenants. The byte
 * budget below trims further as needed.
 */
const DEFAULT_ROW_LIMIT = 500;

/**
 * Hard cap on rows actually emitted per call after the byte budget is
 * enforced. Multi-batch progress is the drain loop's job; this loader
 * never tries to produce more than one batch per call.
 */
const MAX_ROWS_PER_BATCH = 500;

/**
 * Cap on the `top_peer_kinds[]` array embedded in
 * `asset_context.peer_event_summary`. Keeps the per-event budget under
 * the 2 KB target stated in #571's "Asset short context" section.
 */
const PEER_KIND_TOP_LIMIT = 5;

/**
 * Cap on `window_signals.s4_correlated_event_keys[]`. Bounds the
 * per-event payload contribution from the correlated-event set while
 * still surfacing the most relevant peers.
 */
const S4_EVENT_KEYS_LIMIT = 50;

export interface BaselineStreamingEvent extends BaselineRefreshEvent {
  raw_score: number | null;
  selector_tags: string[] | null;
  raw_event: Record<string, unknown>;
  score_window_context: {
    kind_cohort_window: { from: string; to: string };
    kind_cohort_size: number;
    baseline_rank_snapshot: number | null;
  };
  window_signals: {
    s1_percentile_rank: number | null;
    s3_recurring_count: number;
    s4_correlated_count: number;
    s4_correlated_event_keys: string[];
  };
  asset_context: {
    primary_asset: string | null;
    peer_event_summary: {
      total_peer_count: number;
      top_peer_kinds: Array<{ kind: string; count: number }>;
    };
  };
  scoring_weights_snapshot: typeof SCORING_WEIGHTS_SNAPSHOT;
}

export interface BaselineStreamingSlice {
  events: BaselineStreamingEvent[];
  /** Last (event_time, event_key) tuple consumed — cursor target on ack. */
  lastEventTime: Date | null;
  lastEventKey: string | null;
  /** True when at least one un-consumed row remains past this slice. */
  hasMore: boolean;
  /** Baseline version observed (single — streaming is single-version). */
  baselineVersion: string | null;
}

interface BaselineCursorRowSql {
  event_key: string;
  event_time: Date;
  event_time_iso: string;
  kind: string;
  sensor: string;
  orig_addr: string | null;
  orig_port: number | null;
  resp_addr: string | null;
  resp_port: number | null;
  proto: number | null;
  host: string | null;
  dns_query: string | null;
  uri: string | null;
  category: string | null;
  baseline_version: string;
  exclusions_fp: string;
  raw_score: number | null;
  selector_tags: string[] | null;
  payload_summary: unknown;
}

const SCORING_WEIGHTS_SNAPSHOT = Object.freeze({
  selector_weights: { ...SELECTOR_WEIGHTS },
  selector_saturation: { ...SELECTOR_SATURATION },
  tag_thresholds: { ...TAG_THRESHOLDS },
  statistics_window_days: [...STATISTICS_WINDOW_DAYS] as readonly number[],
  selector_tags: { ...SELECTOR_TAGS },
});

export interface LoadBaselineStreamingSliceInput {
  customerId: number;
  cursorEventTime: Date | null;
  cursorEventKey: string | null;
  /**
   * Maximum payload bytes (inner JSON, before envelope). Defaults to
   * {@link PHASE2_REFRESH_PAYLOAD_MAX_BYTES} minus the
   * {@link PHASE2_REFRESH_EXTERNAL_KEY_RESERVE_BYTES} reserve so the
   * post-augmentation payload still fits the shared cap.
   */
  maxBytes?: number;
  /** Max rows pulled from PG before the byte budget trims. */
  rowLimit?: number;
}

/**
 * Load the next streaming slice of baseline rows past the cursor +
 * enrich each row with the §6 baseline-batch fields. Returns the slice,
 * the (event_time, event_key) cursor target for the post-ack advance,
 * and a `hasMore` hint.
 */
export async function loadBaselineStreamingSlice(
  input: LoadBaselineStreamingSliceInput,
): Promise<BaselineStreamingSlice> {
  const pool = await getCustomerPool(input.customerId);
  const client = await pool.connect();
  try {
    return await loadSlice(client, input);
  } finally {
    client.release();
  }
}

async function loadSlice(
  client: pg.PoolClient,
  input: LoadBaselineStreamingSliceInput,
): Promise<BaselineStreamingSlice> {
  const rowLimit = Math.min(
    Math.max(1, input.rowLimit ?? DEFAULT_ROW_LIMIT),
    MAX_ROWS_PER_BATCH,
  );
  const rows = await selectCursorSlice(client, {
    cursorEventTime: input.cursorEventTime,
    cursorEventKey: input.cursorEventKey,
    // Pull one extra row so we can compute `hasMore` without a second
    // round-trip — the trailing row stays in the cursor for the next
    // call.
    limit: rowLimit + 1,
  });

  const oversizeCheck = rows.slice(0, rowLimit);
  const hasMore = rows.length > rowLimit;

  if (oversizeCheck.length === 0) {
    return {
      events: [],
      lastEventTime: null,
      lastEventKey: null,
      hasMore: false,
      baselineVersion: null,
    };
  }

  // Window for `kind_cohort_window` + `baseline_rank_snapshot`. We use
  // the slice's own [min(event_time), max(event_time)] span so the
  // cohort the menu would render at push time is documented on the
  // payload — the read-time strictness slider (#471) is intentionally
  // NOT applied here per the issue's payload-builder section.
  const minTime = oversizeCheck[0].event_time;
  const maxTime = oversizeCheck[oversizeCheck.length - 1].event_time;
  const cohortFromIso = minTime.toISOString();
  const cohortToIso = maxTime.toISOString();
  const baselineVersion = oversizeCheck[0].baseline_version;

  const rankByKey = await loadBaselineRankSnapshot(client, {
    cohortFromIso,
    cohortToIso,
    baselineVersion,
    eventKeys: oversizeCheck.map((r) => r.event_key),
  });
  const cohortSize = rankByKey.cohortSize;

  const signalsByKey = await loadWindowSignals(
    client,
    oversizeCheck.map((r) => ({
      event_key: r.event_key,
      kind: r.kind,
      orig_addr: r.orig_addr,
      resp_addr: r.resp_addr,
      category: r.category,
    })),
  );

  const peerSummaryByAsset = await loadPeerEventSummaries(client, {
    cohortFromIso,
    cohortToIso,
    assets: Array.from(
      new Set(
        oversizeCheck
          .map((r) => r.orig_addr)
          .filter((v): v is string => v !== null),
      ),
    ),
  });

  const enriched: BaselineStreamingEvent[] = oversizeCheck.map((row) =>
    buildStreamingEvent(row, {
      cohortFromIso,
      cohortToIso,
      cohortSize,
      rankByKey: rankByKey.rankByKey,
      signal: signalsByKey.get(row.event_key) ?? null,
      peerSummary: peerSummaryByAsset.get(row.orig_addr ?? "") ?? null,
    }),
  );

  // Trim by serialized byte budget. The drain loop will pick up the
  // trimmed tail on the next iteration via the unchanged cursor.
  const rawBudget = input.maxBytes ?? PHASE2_REFRESH_PAYLOAD_MAX_BYTES;
  const budget = Math.max(
    1,
    rawBudget - PHASE2_REFRESH_EXTERNAL_KEY_RESERVE_BYTES,
  );
  const fitted = trimToBudget(enriched, baselineVersion, budget);

  if (fitted.length === 0) {
    // Even a single event exceeds the budget — emit it anyway (the
    // byte cap is a soft preference, never a deadlock). The next loop
    // iteration will advance past it.
    fitted.push(enriched[0]);
  }
  const trimmed = fitted.length < enriched.length || hasMore;
  const last = fitted[fitted.length - 1];

  return {
    events: fitted,
    lastEventTime: oversizeCheck[fitted.length - 1].event_time,
    lastEventKey: last.event_key,
    hasMore: trimmed,
    baselineVersion,
  };
}

async function selectCursorSlice(
  client: pg.PoolClient,
  input: {
    cursorEventTime: Date | null;
    cursorEventKey: string | null;
    limit: number;
  },
): Promise<BaselineCursorRowSql[]> {
  const params: unknown[] = [];
  let where = "";
  if (input.cursorEventTime !== null && input.cursorEventKey !== null) {
    params.push(input.cursorEventTime, input.cursorEventKey);
    where = `WHERE (event_time, event_key) > ($1::timestamptz, $2::numeric)`;
  }
  params.push(input.limit);
  const limitParamIdx = params.length;
  const { rows } = await client.query<BaselineCursorRowSql>(
    `SELECT event_key::text                  AS event_key,
            event_time,
            to_char(event_time AT TIME ZONE 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS event_time_iso,
            kind,
            sensor,
            host(orig_addr)::text            AS orig_addr,
            orig_port,
            host(resp_addr)::text            AS resp_addr,
            resp_port,
            proto,
            host,
            dns_query,
            uri,
            category,
            baseline_version,
            exclusions_fp,
            raw_score,
            selector_tags,
            payload_summary
       FROM baseline_triaged_event
       ${where}
       ORDER BY event_time, event_key
       LIMIT $${limitParamIdx}`,
    params,
  );
  return rows;
}

async function loadBaselineRankSnapshot(
  client: pg.PoolClient,
  input: {
    cohortFromIso: string;
    cohortToIso: string;
    baselineVersion: string;
    eventKeys: readonly string[];
  },
): Promise<{ rankByKey: Map<string, number>; cohortSize: number }> {
  const rankByKey = new Map<string, number>();
  if (input.eventKeys.length === 0) {
    return { rankByKey, cohortSize: 0 };
  }
  // `CUME_DIST() OVER (PARTITION BY kind ORDER BY raw_score)` over the
  // same-kind / same-baseline_version slice within the cohort window
  // matches the read-time strictness ranking (#471 §2). The strictness
  // slider itself is a per-user display filter applied AFTER this
  // ranking, so it has no presence in the payload (per the issue).
  const { rows } = await client.query<{
    event_key: string;
    rank: number;
  }>(
    `WITH cohort AS (
       SELECT event_key,
              cume_dist() OVER (PARTITION BY kind ORDER BY raw_score) AS rank
         FROM baseline_triaged_event
        WHERE event_time >= $1::timestamptz
          AND event_time <= $2::timestamptz
          AND baseline_version = $3
     )
     SELECT event_key::text AS event_key,
            rank::float8    AS rank
       FROM cohort
      WHERE event_key = ANY($4::numeric[])`,
    [
      input.cohortFromIso,
      input.cohortToIso,
      input.baselineVersion,
      input.eventKeys as unknown as string[],
    ],
  );
  for (const row of rows) {
    rankByKey.set(row.event_key, Number(row.rank));
  }
  const { rows: sizeRows } = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM baseline_triaged_event
      WHERE event_time >= $1::timestamptz
        AND event_time <= $2::timestamptz
        AND baseline_version = $3`,
    [input.cohortFromIso, input.cohortToIso, input.baselineVersion],
  );
  const cohortSize = Number(sizeRows[0]?.count ?? "0");
  return { rankByKey, cohortSize };
}

interface WindowSignalsRowKey {
  event_key: string;
  kind: string;
  orig_addr: string | null;
  resp_addr: string | null;
  category: string | null;
}

interface WindowSignalsValue {
  s1_percentile_rank: number | null;
  s3_recurring_count: number;
  s4_correlated_count: number;
  s4_correlated_event_keys: string[];
}

/**
 * Window-level signals (S1 / S3 / S4) computed at push time against
 * `observed_event_meta` per RFC 0001 §8. The same SQL shape the menu
 * uses for window-level signals — kept lean here because the streaming
 * slice is bounded to {@link MAX_ROWS_PER_BATCH} rows per call.
 */
async function loadWindowSignals(
  client: pg.PoolClient,
  rows: readonly WindowSignalsRowKey[],
): Promise<Map<string, WindowSignalsValue>> {
  const result = new Map<string, WindowSignalsValue>();
  if (rows.length === 0) return result;

  // S1 — percentile rank of (kind, confidence) across the 30-day window
  // around `now()`. The cohort window choice mirrors the cadence's
  // longest statistics window (RFC 0001 §7) so push-time and read-time
  // see the same denominator.
  const pageParams: unknown[] = [];
  const placeholderRows: string[] = [];
  for (const row of rows) {
    const baseIdx = pageParams.length;
    pageParams.push(row.event_key, row.kind, row.orig_addr, row.resp_addr);
    placeholderRows.push(
      `($${baseIdx + 1}::numeric, $${baseIdx + 2}::text, $${baseIdx + 3}::inet, $${baseIdx + 4}::inet)`,
    );
  }
  const pageValues = placeholderRows.join(", ");

  // S1 percentile, S3 repeat count, S4 distinct-category count + the
  // correlated event_keys themselves (the §6 payload calls them out
  // explicitly). Single SELECT against `observed_event_meta`.
  const sql = `
    WITH page_rows AS (
      SELECT pr.event_key, pr.kind, pr.orig_addr, pr.resp_addr
        FROM (VALUES ${pageValues}) AS pr(event_key, kind, orig_addr, resp_addr)
    ),
    page_kinds AS (
      SELECT DISTINCT kind FROM page_rows
    ),
    ranked AS (
      SELECT event_key,
             cume_dist() OVER (PARTITION BY kind ORDER BY confidence) AS r
        FROM observed_event_meta
       WHERE event_time >= now() - INTERVAL '30 days'
         AND confidence IS NOT NULL
         AND kind IN (SELECT kind FROM page_kinds)
    ),
    s3_aggr AS (
      SELECT o.kind, o.orig_addr, o.resp_addr,
             COUNT(*) AS c
        FROM observed_event_meta o
        JOIN (
          SELECT DISTINCT kind, orig_addr, resp_addr
            FROM page_rows
           WHERE orig_addr IS NOT NULL AND resp_addr IS NOT NULL
        ) k
          ON k.kind = o.kind
         AND k.orig_addr = o.orig_addr
         AND k.resp_addr = o.resp_addr
       WHERE o.event_time >= now() - INTERVAL '30 days'
       GROUP BY o.kind, o.orig_addr, o.resp_addr
    ),
    s4_aggr AS (
      SELECT o.kind, o.orig_addr,
             COUNT(DISTINCT o.category) AS c,
             array_agg(o.event_key::text ORDER BY o.event_time DESC)
               FILTER (WHERE o.category IS NOT NULL) AS event_keys
        FROM observed_event_meta o
        JOIN (
          SELECT DISTINCT kind, orig_addr
            FROM page_rows
           WHERE orig_addr IS NOT NULL
        ) k
          ON k.kind = o.kind
         AND k.orig_addr = o.orig_addr
       WHERE o.event_time >= now() - INTERVAL '30 days'
       GROUP BY o.kind, o.orig_addr
    )
    SELECT pr.event_key::text                       AS event_key,
           r.r::float8                              AS s1_rank,
           COALESCE(s3a.c, 0)::bigint               AS s3_count,
           COALESCE(s4a.c, 0)::bigint               AS s4_count,
           COALESCE(s4a.event_keys, ARRAY[]::text[]) AS s4_event_keys
      FROM page_rows pr
      LEFT JOIN ranked r ON r.event_key = pr.event_key
      LEFT JOIN s3_aggr s3a
             ON s3a.kind      = pr.kind
            AND s3a.orig_addr = pr.orig_addr
            AND s3a.resp_addr = pr.resp_addr
      LEFT JOIN s4_aggr s4a
             ON s4a.kind      = pr.kind
            AND s4a.orig_addr = pr.orig_addr
  `;

  type Row = {
    event_key: string;
    s1_rank: number | null;
    s3_count: string;
    s4_count: string;
    s4_event_keys: string[];
  };
  const { rows: outRows } = await client.query<Row>(sql, pageParams);
  const categoryByKey = new Map(rows.map((r) => [r.event_key, r.category]));
  for (const row of outRows) {
    const category = categoryByKey.get(row.event_key);
    // S3 self-exclusion: the page row itself is included in the COUNT
    // when its (orig_addr, resp_addr) are non-NULL. The s3_aggr join
    // filters NULL-address keys, so NULL-address page rows already
    // miss the join (COALESCE 0) and the subtraction would underflow
    // — Math.max guards.
    const s3 = Math.max(0, Number(row.s3_count) - 1);
    // S4: subtract 1 only when the page row's `category` is non-NULL,
    // matching `COUNT(DISTINCT category)`'s NULL-ignoring semantics.
    const s4Subtract = category != null ? 1 : 0;
    const s4 = Math.max(0, Number(row.s4_count) - s4Subtract);
    // Filter the page row's own event_key out of the correlated set
    // and cap the array for payload size.
    const filteredKeys = row.s4_event_keys
      .filter((k) => k !== row.event_key)
      .slice(0, S4_EVENT_KEYS_LIMIT);
    result.set(row.event_key, {
      s1_percentile_rank: row.s1_rank === null ? null : Number(row.s1_rank),
      s3_recurring_count: s3,
      s4_correlated_count: s4,
      s4_correlated_event_keys: filteredKeys,
    });
  }
  return result;
}

interface PeerSummary {
  total_peer_count: number;
  top_peer_kinds: Array<{ kind: string; count: number }>;
}

/**
 * Build {@link PeerSummary} per primary asset (host address). Counts
 * other baseline-passing events from the same asset within the cohort
 * window, grouped by kind. Capped at {@link PEER_KIND_TOP_LIMIT}
 * entries to keep the per-event payload contribution under the 2 KB
 * target.
 */
async function loadPeerEventSummaries(
  client: pg.PoolClient,
  input: {
    cohortFromIso: string;
    cohortToIso: string;
    assets: readonly string[];
  },
): Promise<Map<string, PeerSummary>> {
  const map = new Map<string, PeerSummary>();
  if (input.assets.length === 0) return map;
  const { rows } = await client.query<{
    orig_addr: string;
    kind: string;
    count: string;
  }>(
    `SELECT host(orig_addr)::text AS orig_addr,
            kind,
            COUNT(*)::text AS count
       FROM baseline_triaged_event
      WHERE event_time >= $1::timestamptz
        AND event_time <= $2::timestamptz
        AND orig_addr IS NOT NULL
        AND host(orig_addr)::text = ANY($3::text[])
      GROUP BY orig_addr, kind
      ORDER BY orig_addr, COUNT(*) DESC`,
    [
      input.cohortFromIso,
      input.cohortToIso,
      input.assets as unknown as string[],
    ],
  );
  for (const row of rows) {
    const summary = map.get(row.orig_addr) ?? {
      total_peer_count: 0,
      top_peer_kinds: [],
    };
    const count = Number(row.count);
    summary.total_peer_count += count;
    if (summary.top_peer_kinds.length < PEER_KIND_TOP_LIMIT) {
      summary.top_peer_kinds.push({ kind: row.kind, count });
    }
    map.set(row.orig_addr, summary);
  }
  return map;
}

interface EnrichmentInputs {
  cohortFromIso: string;
  cohortToIso: string;
  cohortSize: number;
  rankByKey: Map<string, number>;
  signal: WindowSignalsValue | null;
  peerSummary: PeerSummary | null;
}

function buildStreamingEvent(
  row: BaselineCursorRowSql,
  enrich: EnrichmentInputs,
): BaselineStreamingEvent {
  const rawEvent: Record<string, unknown> = {
    event_key: row.event_key,
    event_time: row.event_time_iso,
    kind: row.kind,
    sensor: row.sensor,
    orig_addr: row.orig_addr,
    orig_port: row.orig_port,
    resp_addr: row.resp_addr,
    resp_port: row.resp_port,
    proto: row.proto,
    host: row.host,
    dns_query: row.dns_query,
    uri: row.uri,
    category: row.category,
    payload_summary: row.payload_summary,
  };
  const signal = enrich.signal ?? {
    s1_percentile_rank: null,
    s3_recurring_count: 0,
    s4_correlated_count: 0,
    s4_correlated_event_keys: [],
  };
  return {
    event_key: row.event_key,
    event_time: row.event_time_iso,
    kind: row.kind,
    sensor: row.sensor,
    orig_addr: row.orig_addr,
    orig_port: row.orig_port,
    resp_addr: row.resp_addr,
    resp_port: row.resp_port,
    proto: row.proto,
    host: row.host,
    dns_query: row.dns_query,
    uri: row.uri,
    category: row.category,
    baseline_version: row.baseline_version,
    exclusions_fp: row.exclusions_fp,
    raw_score: row.raw_score,
    selector_tags: row.selector_tags,
    payload_summary: row.payload_summary,
    raw_event: rawEvent,
    score_window_context: {
      kind_cohort_window: {
        from: enrich.cohortFromIso,
        to: enrich.cohortToIso,
      },
      kind_cohort_size: enrich.cohortSize,
      baseline_rank_snapshot: enrich.rankByKey.get(row.event_key) ?? null,
    },
    window_signals: signal,
    asset_context: {
      primary_asset: row.orig_addr,
      peer_event_summary: enrich.peerSummary ?? {
        total_peer_count: 0,
        top_peer_kinds: [],
      },
    },
    scoring_weights_snapshot: SCORING_WEIGHTS_SNAPSHOT,
  };
}

/**
 * Trim a fully-enriched slice so the inner payload (events + top-level
 * `baseline_version` / future `external_key`) stays under `budget`
 * bytes. The drain loop will pick up the trimmed tail on the next
 * iteration via the unchanged cursor.
 */
function trimToBudget(
  events: BaselineStreamingEvent[],
  baselineVersion: string,
  budget: number,
): BaselineStreamingEvent[] {
  const fitted: BaselineStreamingEvent[] = [];
  // Conservative fixed envelope estimate around the events array.
  // `external_key` is injected by the orchestrator post-validation so
  // we already reserved its bytes upstream; everything else is small.
  const overhead = JSON.stringify({
    baseline_version: baselineVersion,
    events: [],
  }).length;
  let runningBytes = overhead;
  for (const event of events) {
    const eventBytes = JSON.stringify(event).length + 1; // +1 for array comma
    if (fitted.length > 0 && runningBytes + eventBytes > budget) break;
    fitted.push(event);
    runningBytes += eventBytes;
  }
  return fitted;
}

export const _testing = {
  trimToBudget,
  SCORING_WEIGHTS_SNAPSHOT,
};
