/**
 * Phase 2 story streaming push payload loader (sub-issue #493).
 *
 * Used by `POST /api/aimer/phase2/story/build-envelope` (manual single-
 * story Send) and `POST /api/aimer/phase2/story/next-batch` (opportunistic
 * new-row Story batches) to assemble the `phase2.story.v1` payload that
 * goes into a Story batch envelope, plus the cursor target for the
 * `aimer_push_state` advance on the next ack.
 *
 * The on-wire item shape (`storyItem`) is produced by
 * {@link toWireStoryItem} so opportunistic, refresh, and backfill
 * Stories all carry identical fields per RFC 0002 §6.
 *
 * ## Late-commit race: two-mechanism defense
 *
 * Stories carry no `event_time` / `event_key`. For the `story`
 * streaming kind the `aimer_push_state.last_pushed_event_time` column
 * stores the Story's `created_at` and `last_pushed_event_key` stores
 * the stringified `event_group.id`. The cursor key is `(created_at,
 * id)` (not `(time_window_end, id)`) — but `created_at` defaults to
 * `now()` (= TRANSACTION-START time in PostgreSQL, not statement or
 * commit time).
 * A correlator transaction can therefore commit AFTER a drain advances
 * the cursor while persisting a row whose `created_at` is BEHIND the
 * just-advanced cursor; the cursor-ordered forward slice
 * `(created_at, id) > $cursor` would never re-select that row.
 *
 * The drain closes the race with two cooperating mechanisms:
 *
 *   1. **Forward cursor on `(created_at, id)`**
 *      ({@link loadStoryStreamingSlice}) — handles the common case
 *      where the inserting transaction's `created_at` is strictly
 *      greater than the previously-advanced cursor (i.e., the
 *      inserting transaction either started after the previous slice
 *      ran, OR its `created_at` was already past the cursor target
 *      that previous slice advanced to). The slice also filters
 *      `last_sent_at IS NULL` so a Story that was manually sent (by
 *      an analyst Send button) before this drain ran is never
 *      re-included in an opportunistic batch — without this filter,
 *      the ack β-update would overwrite the analyst's `last_sent_by`
 *      with the system actor and emit a spurious opportunistic audit
 *      row. Combined with the persisted
 *      `aimer_push_inflight.pushed_stories` set, β/audit only address
 *      the exact rows actually signed into the envelope.
 *
 *   2. **Late-commit straggler scan**
 *      ({@link loadStoryStragglerSlice}) — run by the drain BEFORE the
 *      forward slice on every `next-batch` call. Selects unsent rows
 *      that sit AT OR BEHIND the cursor
 *      (`(created_at, id::numeric) <= cursor AND last_sent_at IS NULL`)
 *      and that were created AT OR AFTER the activation watermark
 *      (`created_at >= streaming_activated_at` from
 *      `aimer_push_state`). Stragglers are delivered as a regular
 *      Story batch with `cursorAdvanceTo* = NULL` on the inflight row
 *      (β/audit address `pushed_stories`; the forward cursor stays
 *      put). Once delivered they get `last_sent_at = NOW()` on ack and
 *      drop out of the scan permanently.
 *
 * The `aimer_push_state.streaming_activated_at` watermark is stamped
 * at the same instant as the NULL-cursor seed in
 * `seedNullCursor`. Rows whose `created_at` is older than activation
 * are pre-existing history; they are NOT eligible for the straggler
 * scan and the drain therefore does not back-flood aimer-web with the
 * entire historical `event_group` corpus on a freshly-opened Stories
 * tab. Rows created AFTER activation but committed late — the race
 * target — are caught and delivered automatically.
 *
 * Curated stories (`event_group.kind = 'analyst_curated'`) are NEVER
 * opportunistically pushed; both the streaming slice and the
 * straggler scan filter to `auto_correlated` only. Manual Send is
 * single-Story and skips both helpers, going through
 * {@link loadSingleStoryWireItem} instead.
 */

import "server-only";

import type pg from "pg";

import {
  type BaselineRefreshEvent,
  PHASE2_BASELINE_AUGMENT_RESERVE_BYTES,
  PHASE2_REFRESH_PAYLOAD_MAX_BYTES,
  type StoryRefreshItem,
  type StoryWireItem,
  toWireStoryItem,
} from "@/lib/aimer/phase2/payload-builders";
import { getCustomerPool } from "@/lib/triage/policy/customer-db";

/**
 * Upper bound on rows pulled per call before the byte budget kicks in.
 * Stories are heavy (members + embedded baseline-event enrichment), so
 * the limit stays modest.
 */
const DEFAULT_ROW_LIMIT = 200;

/**
 * Hard cap on rows actually emitted per call after the byte budget is
 * enforced. The drain loop handles multi-batch progress on its own.
 */
const MAX_ROWS_PER_BATCH = 200;

export interface StoryStreamingSlice {
  stories: StoryWireItem[];
  /**
   * `created_at` of the last Story consumed — the cursor target stored
   * in `aimer_push_state.last_pushed_event_time` on ack. `created_at`
   * (not `time_window_end`) is the cursor key for the `story` streaming
   * kind so a Story inserted after slice-time cannot end up behind the
   * advanced cursor (see the module comment above).
   */
  lastEventTime: Date | null;
  /**
   * Stringified `event_group.id` of the last Story consumed — the
   * cursor target stored in `aimer_push_state.last_pushed_event_key`
   * on ack.
   */
  lastEventKey: string | null;
  /** True when at least one un-consumed row remains past this slice. */
  hasMore: boolean;
}

export interface LoadStoryStreamingSliceInput {
  customerId: number;
  /** Prior cursor `created_at` from `aimer_push_state`. */
  cursorEventTime: Date | null;
  /** Prior cursor stringified `event_group.id` from `aimer_push_state`. */
  cursorEventKey: string | null;
  /**
   * Maximum payload bytes (inner JSON, before envelope). Defaults to
   * {@link PHASE2_REFRESH_PAYLOAD_MAX_BYTES} minus the
   * {@link PHASE2_BASELINE_AUGMENT_RESERVE_BYTES} reserve so the
   * post-augmentation payload — including both `external_key` and
   * `source_aice_id` that `augmentPayload` injects for
   * `phase2.story.v1` — still fits the shared cap.
   */
  maxBytes?: number;
  /** Max rows pulled from PG before the byte budget trims. */
  rowLimit?: number;
}

/**
 * Cheap existence check: are there any auto-correlated `event_group`
 * rows past the given cursor? Reserved for symmetry with the baseline
 * drain, currently unused — the story drain's queue-first branch does
 * not need to flag streaming work behind it because the loop iterates
 * over `has_more: true` until both queue and stream are drained.
 */
export async function hasStoryRowsPastCursor(input: {
  customerId: number;
  cursorEventTime: Date | null;
  cursorEventKey: string | null;
}): Promise<boolean> {
  const pool = await getCustomerPool(input.customerId);
  const params: unknown[] = [];
  let cursorClause = "";
  if (input.cursorEventTime !== null && input.cursorEventKey !== null) {
    params.push(input.cursorEventTime, input.cursorEventKey);
    cursorClause =
      "AND (created_at, id::numeric) > ($1::timestamptz, $2::numeric)";
  }
  const { rows } = await pool.query(
    `SELECT 1
       FROM event_group
      WHERE kind = 'auto_correlated'
        AND last_sent_at IS NULL
        ${cursorClause}
      LIMIT 1`,
    params,
  );
  return rows.length > 0;
}

/**
 * Load the next streaming slice of auto-correlated stories past the
 * cursor. Returns the slice in wire-ready shape (with nested
 * `time_window: { start, end }` and member rows enriched with embedded
 * baseline-event details when the baseline row is still in the 180-day
 * corpus).
 */
export async function loadStoryStreamingSlice(
  input: LoadStoryStreamingSliceInput,
): Promise<StoryStreamingSlice> {
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
  input: LoadStoryStreamingSliceInput,
): Promise<StoryStreamingSlice> {
  const rowLimit = Math.min(
    Math.max(1, input.rowLimit ?? DEFAULT_ROW_LIMIT),
    MAX_ROWS_PER_BATCH,
  );

  // Pull one extra row so `hasMore` can be computed without a second
  // round-trip — the trailing row stays in the cursor for the next
  // call.
  const rows = await selectCursorSlice(client, {
    cursorEventTime: input.cursorEventTime,
    cursorEventKey: input.cursorEventKey,
    limit: rowLimit + 1,
  });

  const overflow = rows.length > rowLimit;
  const considered = rows.slice(0, rowLimit);
  if (considered.length === 0) {
    return {
      stories: [],
      lastEventTime: null,
      lastEventKey: null,
      hasMore: false,
    };
  }

  const ids = considered.map((r) => r.story_id);
  const memberMap = await loadStoryMembers(client, ids);

  const items: StoryRefreshItem[] = considered.map((r) => ({
    story_id: r.story_id,
    story_version: r.story_version,
    kind: r.kind,
    members: memberMap.get(r.story_id) ?? [],
    correlation_rule_id: r.correlation_rule_id,
    primary_asset: r.primary_asset,
    time_window_start: r.time_window_start,
    time_window_end: r.time_window_end,
    score: r.score,
    summary_payload: r.summary_payload,
    created_at: r.created_at,
    last_sent_at: r.last_sent_at,
    last_sent_by: r.last_sent_by,
    send_count: r.send_count,
  }));

  // Trim by serialized byte budget so a heavy slice still fits the
  // shared cap. The reserve subtracts the augment-injected
  // `external_key` + `source_aice_id` fields that
  // `buildPhase2Push` adds at signing time.
  const rawBudget = input.maxBytes ?? PHASE2_REFRESH_PAYLOAD_MAX_BYTES;
  const budget = Math.max(1, rawBudget - PHASE2_BASELINE_AUGMENT_RESERVE_BYTES);

  const wire = items.map(toWireStoryItem);
  const fitted: StoryWireItem[] = [];
  let runningBytes = 0;
  const wrapperBytes = Buffer.byteLength(
    JSON.stringify({ external_key: "_", source_aice_id: "_", stories: [] }),
    "utf8",
  );
  for (const item of wire) {
    const candidate = JSON.stringify(item);
    // +1 for the comma between items once we have more than one.
    const addedBytes =
      Buffer.byteLength(candidate, "utf8") + (fitted.length > 0 ? 1 : 0);
    if (
      fitted.length > 0 &&
      runningBytes + addedBytes + wrapperBytes > budget
    ) {
      break;
    }
    fitted.push(item);
    runningBytes += addedBytes;
  }
  // Emit at least one row even if it alone exceeds the budget — the
  // byte cap is a soft preference, never a deadlock. The next loop
  // iteration advances past it.
  if (fitted.length === 0) {
    fitted.push(wire[0]);
  }
  const trimmed = fitted.length < wire.length;
  const lastIndex = fitted.length - 1;
  const lastConsidered = considered[lastIndex];
  return {
    stories: fitted,
    lastEventTime: lastConsidered.created_at_date,
    lastEventKey: lastConsidered.story_id,
    hasMore: overflow || trimmed,
  };
}

interface StoryCursorRowSql {
  story_id: string;
  story_version: string;
  kind: string;
  correlation_rule_id: string | null;
  primary_asset: string | null;
  time_window_start: string;
  time_window_end: string;
  score: number | null;
  summary_payload: unknown;
  created_at: string;
  /** Native Date — used as the cursor target on ack. */
  created_at_date: Date;
  last_sent_at: string | null;
  last_sent_by: string | null;
  send_count: number;
}

async function selectCursorSlice(
  client: pg.PoolClient,
  input: {
    cursorEventTime: Date | null;
    cursorEventKey: string | null;
    limit: number;
  },
): Promise<StoryCursorRowSql[]> {
  const params: unknown[] = [];
  let cursorClause = "";
  if (input.cursorEventTime !== null && input.cursorEventKey !== null) {
    params.push(input.cursorEventTime, input.cursorEventKey);
    // Cursor on `(created_at, id)` — see the module comment for why
    // this race-eliminates the "Story inserted between mint and ack"
    // case. ORDER BY matches so the cursor advance is monotonic with
    // the rows actually consumed in this slice.
    cursorClause =
      "AND (created_at, id::numeric) > ($1::timestamptz, $2::numeric)";
  }
  params.push(input.limit);
  const limitParamIdx = params.length;
  // `last_sent_at IS NULL` excludes rows that were already delivered by
  // a prior manual Send. Without this filter, an opportunistic batch
  // minted between a manual Send's mint and ack — or against a Story
  // an analyst sent before this drain ran — would re-include the row
  // and the ack β-update (see {@link commitOnAck}) would overwrite the
  // analyst's `last_sent_by` with the system actor. Lines up with the
  // partial-index predicate
  // (`event_group_auto_unsent_created_at_idx` in the tenant schema).
  const { rows } = await client.query<StoryCursorRowSql>(
    `SELECT id::text                                AS story_id,
            story_version,
            kind,
            correlation_rule_id,
            host(primary_asset)::text               AS primary_asset,
            to_char(time_window_start AT TIME ZONE 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS time_window_start,
            to_char(time_window_end   AT TIME ZONE 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS time_window_end,
            score,
            summary_payload,
            to_char(created_at AT TIME ZONE 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
            created_at                               AS created_at_date,
            CASE WHEN last_sent_at IS NULL THEN NULL
                 ELSE to_char(last_sent_at AT TIME ZONE 'UTC',
                              'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
            END                                      AS last_sent_at,
            last_sent_by::text                       AS last_sent_by,
            send_count
       FROM event_group
      WHERE kind = 'auto_correlated'
        AND last_sent_at IS NULL
        ${cursorClause}
      ORDER BY created_at, id
      LIMIT $${limitParamIdx}`,
    params,
  );
  return rows;
}

interface StoryMemberRowSql {
  event_group_id: string;
  event_key: string;
  role: string;
}

interface BaselineRowSql {
  event_key: string;
  event_time: string;
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

async function loadStoryMembers(
  client: pg.PoolClient,
  storyIds: readonly string[],
): Promise<
  Map<
    string,
    Array<{
      event_key: string;
      role: string;
      event?: BaselineRefreshEvent;
    }>
  >
> {
  const out = new Map<
    string,
    Array<{ event_key: string; role: string; event?: BaselineRefreshEvent }>
  >();
  if (storyIds.length === 0) return out;

  const { rows: memberRows } = await client.query<StoryMemberRowSql>(
    `SELECT event_group_id::text AS event_group_id,
            event_key::text      AS event_key,
            role
       FROM event_group_member
      WHERE event_group_id = ANY($1::bigint[])
      ORDER BY event_group_id, event_key`,
    [storyIds],
  );

  const memberKeys = Array.from(new Set(memberRows.map((m) => m.event_key)));
  const baselineByKey = await loadBaselineEventsByKey(client, memberKeys);

  for (const m of memberRows) {
    const event = baselineByKey.get(m.event_key);
    const memberItem: {
      event_key: string;
      role: string;
      event?: BaselineRefreshEvent;
    } = {
      event_key: m.event_key,
      role: m.role,
    };
    if (event !== undefined) memberItem.event = event;
    const arr = out.get(m.event_group_id);
    if (arr) arr.push(memberItem);
    else out.set(m.event_group_id, [memberItem]);
  }

  return out;
}

async function loadBaselineEventsByKey(
  client: pg.PoolClient,
  eventKeys: readonly string[],
): Promise<Map<string, BaselineRefreshEvent>> {
  const map = new Map<string, BaselineRefreshEvent>();
  if (eventKeys.length === 0) return map;
  const { rows } = await client.query<BaselineRowSql>(
    `SELECT event_key::text                  AS event_key,
            to_char(event_time AT TIME ZONE 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS event_time,
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
      WHERE event_key = ANY($1::numeric[])`,
    [eventKeys],
  );
  for (const r of rows) {
    map.set(r.event_key, {
      event_key: r.event_key,
      event_time: r.event_time,
      kind: r.kind,
      sensor: r.sensor,
      orig_addr: r.orig_addr,
      orig_port: r.orig_port,
      resp_addr: r.resp_addr,
      resp_port: r.resp_port,
      proto: r.proto,
      host: r.host,
      dns_query: r.dns_query,
      uri: r.uri,
      category: r.category,
      baseline_version: r.baseline_version,
      exclusions_fp: r.exclusions_fp,
      raw_score: r.raw_score,
      selector_tags: r.selector_tags,
      payload_summary: r.payload_summary,
    });
  }
  return map;
}

// ── Late-commit straggler scan (round-5 follow-up) ────────────────

export interface LoadStoryStragglerSliceInput {
  customerId: number;
  /** Current cursor `created_at` from `aimer_push_state`. */
  cursorEventTime: Date;
  /** Current cursor stringified `event_group.id` from `aimer_push_state`. */
  cursorEventKey: string;
  /**
   * Lower bound on `created_at` — typically the value of
   * `aimer_push_state.streaming_activated_at`. Rows older than this
   * are pre-activation history and are intentionally skipped so a
   * freshly-seeded tenant does not back-flood aimer-web with the
   * entire historical `event_group` corpus on first activation.
   */
  activatedAt: Date;
  /**
   * Maximum payload bytes (inner JSON, before envelope). Defaults to
   * the shared `phase2.story.v1` cap, matching
   * {@link loadStoryStreamingSlice}.
   */
  maxBytes?: number;
  /** Max rows pulled from PG before the byte budget trims. */
  rowLimit?: number;
}

export interface StoryStragglerSlice {
  stories: StoryWireItem[];
  /** True when at least one un-consumed straggler remains past this slice. */
  hasMore: boolean;
}

/**
 * Load the next slice of "straggler" Stories — auto-correlated rows
 * whose insert transaction committed AFTER a previous drain advanced
 * the cursor past their `created_at`. The drain delivers these
 * WITHOUT advancing the forward cursor; β/audit on ack address the
 * persisted `aimer_push_inflight.pushed_stories` set, and the rows
 * drop out of the scan once `last_sent_at` is set.
 *
 * Eligibility:
 *
 *   - `kind = 'auto_correlated'` — curated stories never opportunistic-
 *     push.
 *   - `last_sent_at IS NULL` — already-delivered rows are excluded.
 *     This is the predicate that lets the scan find a stable fix-
 *     point: once a straggler is acked, it stops appearing.
 *   - `created_at >= activatedAt` — pre-activation historical rows are
 *     deliberately skipped per the "no back-flood on first
 *     activation" requirement.
 *   - `(created_at, id::numeric) <= cursor` — strictly at-or-behind
 *     the forward cursor. Rows past the cursor are the forward slice's
 *     job (`loadStoryStreamingSlice`); the straggler scan covers the
 *     orthogonal "committed late, ended up behind cursor" case the
 *     forward slice cannot recover on its own.
 *
 * Backed by the partial index
 * `event_group_auto_unsent_created_at_idx` in the tenant schema.
 */
export async function loadStoryStragglerSlice(
  input: LoadStoryStragglerSliceInput,
): Promise<StoryStragglerSlice> {
  const pool = await getCustomerPool(input.customerId);
  const client = await pool.connect();
  try {
    return await loadStragglerSlice(client, input);
  } finally {
    client.release();
  }
}

async function loadStragglerSlice(
  client: pg.PoolClient,
  input: LoadStoryStragglerSliceInput,
): Promise<StoryStragglerSlice> {
  const rowLimit = Math.min(
    Math.max(1, input.rowLimit ?? DEFAULT_ROW_LIMIT),
    MAX_ROWS_PER_BATCH,
  );

  const { rows } = await client.query<StoryCursorRowSql>(
    // Cursor on `(created_at, id) <= cursor` (note the inclusive
    // inequality) AND `created_at >= activated_at` (open the floor at
    // first activation, never below). `last_sent_at IS NULL` lines
    // up with the partial-index predicate so the scan stays O(unsent
    // rows in window) on tenants with deep auto-correlated history.
    `SELECT id::text                                AS story_id,
            story_version,
            kind,
            correlation_rule_id,
            host(primary_asset)::text               AS primary_asset,
            to_char(time_window_start AT TIME ZONE 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS time_window_start,
            to_char(time_window_end   AT TIME ZONE 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS time_window_end,
            score,
            summary_payload,
            to_char(created_at AT TIME ZONE 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
            created_at                               AS created_at_date,
            CASE WHEN last_sent_at IS NULL THEN NULL
                 ELSE to_char(last_sent_at AT TIME ZONE 'UTC',
                              'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
            END                                      AS last_sent_at,
            last_sent_by::text                       AS last_sent_by,
            send_count
       FROM event_group
      WHERE kind = 'auto_correlated'
        AND last_sent_at IS NULL
        AND created_at >= $1::timestamptz
        AND (created_at, id::numeric) <= ($2::timestamptz, $3::numeric)
      ORDER BY created_at, id
      LIMIT $4`,
    [
      input.activatedAt,
      input.cursorEventTime,
      input.cursorEventKey,
      rowLimit + 1,
    ],
  );

  const overflow = rows.length > rowLimit;
  const considered = rows.slice(0, rowLimit);
  if (considered.length === 0) {
    return { stories: [], hasMore: false };
  }

  const ids = considered.map((r) => r.story_id);
  const memberMap = await loadStoryMembers(client, ids);

  const items: StoryRefreshItem[] = considered.map((r) => ({
    story_id: r.story_id,
    story_version: r.story_version,
    kind: r.kind,
    members: memberMap.get(r.story_id) ?? [],
    correlation_rule_id: r.correlation_rule_id,
    primary_asset: r.primary_asset,
    time_window_start: r.time_window_start,
    time_window_end: r.time_window_end,
    score: r.score,
    summary_payload: r.summary_payload,
    created_at: r.created_at,
    last_sent_at: r.last_sent_at,
    last_sent_by: r.last_sent_by,
    send_count: r.send_count,
  }));

  const rawBudget = input.maxBytes ?? PHASE2_REFRESH_PAYLOAD_MAX_BYTES;
  const budget = Math.max(1, rawBudget - PHASE2_BASELINE_AUGMENT_RESERVE_BYTES);

  const wire = items.map(toWireStoryItem);
  const fitted: StoryWireItem[] = [];
  let runningBytes = 0;
  const wrapperBytes = Buffer.byteLength(
    JSON.stringify({ external_key: "_", source_aice_id: "_", stories: [] }),
    "utf8",
  );
  for (const item of wire) {
    const candidate = JSON.stringify(item);
    const addedBytes =
      Buffer.byteLength(candidate, "utf8") + (fitted.length > 0 ? 1 : 0);
    if (
      fitted.length > 0 &&
      runningBytes + addedBytes + wrapperBytes > budget
    ) {
      break;
    }
    fitted.push(item);
    runningBytes += addedBytes;
  }
  if (fitted.length === 0) {
    fitted.push(wire[0]);
  }
  const trimmed = fitted.length < wire.length;
  return { stories: fitted, hasMore: overflow || trimmed };
}

/**
 * Load a single auto-correlated or analyst-curated Story by id and
 * project it into the on-wire `storyItem` shape. Manual Send uses this
 * to assemble a batch-of-size-1 `phase2.story.v1` payload — auto-
 * correlated stories are never opportunistically pushed *without*
 * cursor-driven streaming, but the manual Send button works for both
 * kinds (analyst can manually send a curated Story).
 *
 * Returns `null` when the Story does not exist for this tenant — the
 * route MAPS this to 404 + `story_not_found` so a `triage:read` user
 * for tenant A cannot probe tenant B's story ids.
 */
export async function loadSingleStoryWireItem(input: {
  customerId: number;
  storyId: string;
  forceRefresh?: boolean;
}): Promise<StoryWireItem | null> {
  const pool = await getCustomerPool(input.customerId);
  const client = await pool.connect();
  try {
    const { rows } = await client.query<StoryCursorRowSql>(
      `SELECT id::text                                AS story_id,
              story_version,
              kind,
              correlation_rule_id,
              host(primary_asset)::text               AS primary_asset,
              to_char(time_window_start AT TIME ZONE 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS time_window_start,
              to_char(time_window_end   AT TIME ZONE 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS time_window_end,
              time_window_end                          AS time_window_end_date,
              score,
              summary_payload,
              to_char(created_at AT TIME ZONE 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
              CASE WHEN last_sent_at IS NULL THEN NULL
                   ELSE to_char(last_sent_at AT TIME ZONE 'UTC',
                                'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
              END                                      AS last_sent_at,
              last_sent_by::text                       AS last_sent_by,
              send_count
         FROM event_group
        WHERE id = $1::numeric`,
      [input.storyId],
    );
    if (rows.length === 0) return null;
    const r = rows[0];
    const members =
      (await loadStoryMembers(client, [r.story_id])).get(r.story_id) ?? [];
    const refreshItem: StoryRefreshItem = {
      story_id: r.story_id,
      story_version: r.story_version,
      kind: r.kind,
      members,
      correlation_rule_id: r.correlation_rule_id,
      primary_asset: r.primary_asset,
      time_window_start: r.time_window_start,
      time_window_end: r.time_window_end,
      score: r.score,
      summary_payload: r.summary_payload,
      created_at: r.created_at,
      last_sent_at: r.last_sent_at,
      last_sent_by: r.last_sent_by,
      send_count: r.send_count,
    };
    const wire = toWireStoryItem(refreshItem);
    if (input.forceRefresh === true) {
      (wire as StoryWireItem & { force_refresh: true }).force_refresh = true;
    }
    return wire;
  } finally {
    client.release();
  }
}
