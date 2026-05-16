/**
 * Phase 2 refresh / backfill payload builders (RFC 0002 §6, sub-issue
 * #573).
 *
 * Owns the row-level translation from `baseline_triaged_event` /
 * `event_group` rows into the `events[]` / `stories[]` arrays embedded
 * in `phase2.refresh_window.v1` / `phase2.backfill.v1` payloads — and
 * the budget-aware sub-divider that splits a single rebuild window
 * into N adjacent half-open sub-windows whose individual serialized
 * payloads fit {@link PHASE2_REFRESH_PAYLOAD_MAX_BYTES}.
 *
 * The same builders are reused by the streaming-kind drains (#571
 * baseline, #493 story) so a row that fits a streaming batch also
 * fits a refresh sub-window — the byte budget lives here so all three
 * call sites pin the same value (RFC 0002 §10 item 4).
 *
 * Refresh / backfill share an identical payload shape; only the
 * `aimer_push_queue.kind` discriminator (and the drain-emitted
 * `schema_version`) distinguishes them. One builder serves both.
 */

import "server-only";

import type pg from "pg";

/**
 * Maximum serialized size (UTF-8 bytes) for the inner payload of a
 * `phase2.refresh_window.v1` / `phase2.backfill.v1` queue entry.
 *
 * Provisional 1 MiB; final value converges with the streaming-kind
 * batch budgets in #571 / #493 (RFC 0002 §10 item 4). Well below
 * aimer-web's `BRIDGE_MAX_PAYLOAD_BYTES` default of 50 MB so an
 * envelope-overhead margin is left for the JWS-signed wrapper.
 */
export const PHASE2_REFRESH_PAYLOAD_MAX_BYTES = 1 * 1024 * 1024;

/**
 * Conservative byte reserve subtracted from the budget before
 * sub-division so the post-augmentation payload (with the
 * `external_key` field that `buildPhase2Push` injects at signing
 * time — see `src/lib/aimer/phase2/orchestrate.ts:augmentPayload`)
 * still fits the stated cap. The drain measures the body it actually
 * signs, not the queued JSONB; without a reserve a payload that
 * fits locally can exceed the cap once `,"external_key":"…"` is
 * added. 256 bytes covers any reasonable customer external_key
 * (RFC 0002 §6 keeps it short) plus the surrounding JSON syntax.
 */
export const PHASE2_REFRESH_EXTERNAL_KEY_RESERVE_BYTES = 256;

// ── Payload row shapes ─────────────────────────────────────────────

/**
 * One entry in the `events[]` array of a `phase2.refresh_window.v1` /
 * `phase2.backfill.v1` payload whose `window.kind === "baseline_event"`.
 *
 * Matches the schema's `baselineEvent` shape (decimal-string event_key,
 * ISO event_time, non-empty kind) and carries the additional
 * exclusion-matching columns (host / dns_query / uri / category /
 * baseline_version / etc.) that aimer-web mirrors alongside the
 * primary identity tuple. Passthrough at the schema level keeps
 * extra fields tolerable so the wire format can grow.
 *
 * **Scope note (push-time enrichment is layered on top, not here).**
 * RFC 0002 §6 `phase2.baseline.v1` permits the optional push-time
 * enrichment fields `raw_event`, `score_window_context`,
 * `window_signals`, `asset_context`, and `scoring_weights_snapshot`.
 * Those fields are derived at push time from sources outside the
 * `baseline_triaged_event` corpus (review's RocksDB row store,
 * window-aggregate signals, asset table, in-memory scoring weights)
 * and are intentionally NOT populated here — this builder reads only
 * from the local corpus. The streaming-kind drains in #571 (baseline)
 * and #493 (story) layer enrichment on top of these shared row
 * loaders before signing. The `baselineEvent` Zod schema is
 * `passthrough()` precisely so the same shape is valid both with and
 * without enrichment, and so refresh / backfill emit a schema-valid
 * subset until #571 layers the optional enrichment back in.
 */
export interface BaselineRefreshEvent {
  event_key: string;
  event_time: string;
  kind: string;
  [extra: string]: unknown;
}

/**
 * In-memory Story row produced by {@link loadStoryRefreshRows}. The
 * sub-divider slices on `time_window_end` so that field stays at the
 * top level for grouping; the on-wire shape (nested `time_window`
 * object, members carrying embedded `event` enrichment per RFC 0002
 * §6 baseline-batch shape) is produced by {@link toWireStoryItem}
 * before each sub-payload is serialized. Keeping the slicer's view
 * and the wire view separate avoids leaking `time_window_start` /
 * `time_window_end` into the outbound payload.
 */
export interface StoryRefreshItem {
  story_id: string;
  story_version: string;
  kind: string;
  members: Array<{
    event_key: string;
    role: string;
    event?: BaselineRefreshEvent;
    [extra: string]: unknown;
  }>;
  time_window_start: string;
  time_window_end: string;
  [extra: string]: unknown;
}

/**
 * Wire-shape Story item embedded in `stories[]` of a
 * `phase2.refresh_window.v1` / `phase2.backfill.v1` payload. Matches
 * `storyItem` (RFC 0002 §6 / `phase2.story.v1` schema): nested
 * `time_window: { start, end }` and member rows that may carry an
 * embedded `event` object matching the baseline-event payload shape.
 */
export interface StoryWireItem {
  story_id: string;
  story_version: string;
  kind: string;
  time_window: { start: string; end: string };
  members: Array<{
    event_key: string;
    role: string;
    event?: BaselineRefreshEvent;
  }>;
  [extra: string]: unknown;
}

// ── Sub-payload shapes ─────────────────────────────────────────────

export interface BaselineRefreshSubPayload {
  window: { kind: "baseline_event"; from: string; to: string };
  baseline_version: string;
  events: BaselineRefreshEvent[];
}

export interface StoryRefreshSubPayload {
  window: { kind: "story"; from: string; to: string };
  stories: StoryWireItem[];
}

export interface SubdivideWarning {
  /** Slice-column value the oversize same-timestamp group lives at. */
  sliceValue: string;
  /** Serialized payload size in bytes (cap-exceeding). */
  bytes: number;
  /** Number of rows sharing that slice value. */
  rowCount: number;
}

export interface SubdivideResult<P> {
  payloads: P[];
  warnings: SubdivideWarning[];
}

interface BuiltSubWindow<P> {
  from: string;
  to: string;
  payload: P;
  /** Serialized byte length of the `payload`. */
  bytes: number;
}

interface Group<T> {
  slice: string;
  rows: T[];
}

/**
 * Group consecutive rows by their slice-column value. Input rows MUST
 * already be sorted by `slice` ascending so a same-slice group is a
 * contiguous run.
 */
function groupBySlice<T>(
  rows: readonly T[],
  getSlice: (row: T) => string,
): Group<T>[] {
  const groups: Group<T>[] = [];
  for (const row of rows) {
    const slice = getSlice(row);
    const last = groups[groups.length - 1];
    if (last && last.slice === slice) {
      last.rows.push(row);
    } else {
      groups.push({ slice, rows: [row] });
    }
  }
  return groups;
}

/**
 * Byte-budget-aware sub-divider shared by the baseline and story
 * builders. Splits `[parent.from, parent.to)` into N adjacent half-open
 * sub-windows whose individual serialized payloads each fit
 * `maxBytes`, advancing in same-`slice_column` atomic groups so rows
 * sharing one slice value land in the same sub-window.
 *
 * Algorithm:
 *
 *   - Group rows by slice value (input MUST be sorted by slice asc).
 *   - Greedy left-to-right: try to merge the next group into the
 *     accumulator. If serialized size stays within budget, accept;
 *     otherwise close the current sub-window at the group's slice
 *     value (`to_i = next_group.slice`) and start a new accumulator
 *     with the group.
 *   - If a single group's serialized payload alone exceeds budget,
 *     emit it as its own sub-window with a warning — the atomicity
 *     rule has no smaller unit.
 *   - Empty parent: emit one empty sub-window `[parent.from, parent.to)`.
 *
 * Boundary invariants per acceptance criteria:
 *
 *   - `from_0 === parent.from`
 *   - `to_{N-1} === parent.to`
 *   - `to_i === from_{i+1}` for every adjacent pair (no gaps, no
 *     overlaps).
 */
function subdivide<T, P>(
  parent: { from: string; to: string },
  rows: readonly T[],
  getSlice: (row: T) => string,
  buildPayload: (subWindow: { from: string; to: string }, subRows: T[]) => P,
  maxBytes: number,
): SubdivideResult<P> {
  if (rows.length === 0) {
    const payload = buildPayload(parent, []);
    return {
      payloads: [payload],
      warnings: [],
    };
  }

  const groups = groupBySlice(rows, getSlice);
  const result: BuiltSubWindow<P>[] = [];
  const warnings: SubdivideWarning[] = [];
  let currentFrom = parent.from;
  let currentRows: T[] = [];
  // Slice value of the single oversize group currently sitting in
  // `currentRows`, if any. Populated when we restart the accumulator
  // with a group that alone exceeds `maxBytes`, so the warning is
  // attached to the eventual sub-window emission regardless of whether
  // it closes mid-loop (middle of window) or at the final close (end
  // of window).
  let pendingOversizeSlice: string | null = null;
  let pendingOversizeRowCount = 0;

  function emitClosed(from: string, to: string, rowsForWindow: T[]): void {
    const payload = buildPayload({ from, to }, rowsForWindow);
    const bytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
    result.push({ from, to, payload, bytes });
    if (pendingOversizeSlice !== null) {
      warnings.push({
        sliceValue: pendingOversizeSlice,
        bytes,
        rowCount: pendingOversizeRowCount,
      });
      pendingOversizeSlice = null;
      pendingOversizeRowCount = 0;
    }
  }

  for (let i = 0; i < groups.length; i += 1) {
    const group = groups[i];
    const nextSlice = i + 1 < groups.length ? groups[i + 1].slice : parent.to;
    const tentativeRows = currentRows.concat(group.rows);
    const tentativeWindow = { from: currentFrom, to: nextSlice };
    const tentativePayload = buildPayload(tentativeWindow, tentativeRows);
    const tentativeBytes = Buffer.byteLength(
      JSON.stringify(tentativePayload),
      "utf8",
    );

    if (tentativeBytes <= maxBytes) {
      currentRows = tentativeRows;
      continue;
    }

    if (currentRows.length === 0) {
      // Single group exceeds budget alone — atomicity rule has no
      // smaller unit, so emit it as its own sub-window and warn.
      result.push({
        from: currentFrom,
        to: nextSlice,
        payload: tentativePayload,
        bytes: tentativeBytes,
      });
      warnings.push({
        sliceValue: group.slice,
        bytes: tentativeBytes,
        rowCount: group.rows.length,
      });
      currentFrom = nextSlice;
      currentRows = [];
      continue;
    }

    // Close current sub-window at this group's slice value, then
    // start fresh with the group. If the group alone exceeds budget,
    // remember it so the warning fires when its sub-window emits.
    emitClosed(currentFrom, group.slice, currentRows);
    currentFrom = group.slice;
    currentRows = group.rows.slice();
    const standaloneBytes = Buffer.byteLength(
      JSON.stringify(
        buildPayload({ from: currentFrom, to: nextSlice }, currentRows),
      ),
      "utf8",
    );
    if (standaloneBytes > maxBytes) {
      pendingOversizeSlice = group.slice;
      pendingOversizeRowCount = group.rows.length;
    }
  }

  // Close the final sub-window — even if `currentRows` is empty (which
  // happens when the last iteration just emitted an oversize-single
  // group). Skipping it would leave `to_{N-1} !== parent.to`.
  if (currentFrom !== parent.to || result.length === 0) {
    emitClosed(currentFrom, parent.to, currentRows);
  }

  return {
    payloads: result.map((r) => r.payload),
    warnings,
  };
}

// ── Public builders ────────────────────────────────────────────────

export interface BuildBaselineRefreshInput {
  window: { from: string; to: string };
  baselineVersion: string;
  events: readonly BaselineRefreshEvent[];
  maxBytes?: number;
}

/**
 * Build the `phase2.refresh_window.v1` / `phase2.backfill.v1` payloads
 * for `window.kind === "baseline_event"`. Returns one payload per
 * sub-window (adjacent, non-overlapping, half-open).
 *
 * The caller is responsible for the surrounding enqueue: this builder
 * produces inner sub-payloads only (no `external_key` — the drain
 * augments that field at envelope time, see `orchestrate.ts`).
 *
 * `events` MUST be sorted by `event_time` ascending so same-time rows
 * form contiguous groups per the atomicity rule.
 */
export function buildBaselineRefreshPayloads(
  input: BuildBaselineRefreshInput,
): SubdivideResult<BaselineRefreshSubPayload> {
  const rawBudget = input.maxBytes ?? PHASE2_REFRESH_PAYLOAD_MAX_BYTES;
  const maxBytes = Math.max(
    1,
    rawBudget - PHASE2_REFRESH_EXTERNAL_KEY_RESERVE_BYTES,
  );
  return subdivide<BaselineRefreshEvent, BaselineRefreshSubPayload>(
    input.window,
    input.events,
    (row) => row.event_time,
    (subWindow, subRows) => ({
      window: {
        kind: "baseline_event",
        from: subWindow.from,
        to: subWindow.to,
      },
      baseline_version: input.baselineVersion,
      events: subRows,
    }),
    maxBytes,
  );
}

export interface BuildStoryRefreshInput {
  window: { from: string; to: string };
  stories: readonly StoryRefreshItem[];
  maxBytes?: number;
}

/**
 * Build the `phase2.refresh_window.v1` / `phase2.backfill.v1` payloads
 * for `window.kind === "story"`. Auto-correlated stories only —
 * caller MUST filter analyst-curated rows out before invoking.
 *
 * `stories` MUST be sorted by `time_window_end` ascending so same-end
 * rows form contiguous groups per the atomicity rule.
 */
export function buildStoryRefreshPayloads(
  input: BuildStoryRefreshInput,
): SubdivideResult<StoryRefreshSubPayload> {
  const rawBudget = input.maxBytes ?? PHASE2_REFRESH_PAYLOAD_MAX_BYTES;
  const maxBytes = Math.max(
    1,
    rawBudget - PHASE2_REFRESH_EXTERNAL_KEY_RESERVE_BYTES,
  );
  return subdivide<StoryRefreshItem, StoryRefreshSubPayload>(
    input.window,
    input.stories,
    (row) => row.time_window_end,
    (subWindow, subRows) => ({
      window: {
        kind: "story",
        from: subWindow.from,
        to: subWindow.to,
      },
      stories: subRows.map(toWireStoryItem),
    }),
    maxBytes,
  );
}

/**
 * Project a loader-shaped {@link StoryRefreshItem} into the on-wire
 * `storyItem` shape RFC 0002 §6 specifies (nested `time_window`
 * object; members keep optional `event` enrichment). Flat
 * `time_window_start` / `time_window_end` fields are dropped so the
 * outbound payload matches the schema's `storyItem` shape exactly
 * and the receiver does not see slicer-internal columns.
 */
function toWireStoryItem(row: StoryRefreshItem): StoryWireItem {
  const {
    story_id,
    story_version,
    kind,
    members,
    time_window_start,
    time_window_end,
    ...rest
  } = row;
  return {
    story_id,
    story_version,
    kind,
    time_window: { start: time_window_start, end: time_window_end },
    members,
    ...rest,
  };
}

// ── DB loaders (shared by rebuild + backfill route) ────────────────

/**
 * Load the baseline-event payload rows for a `[from, to)` half-open
 * window, sorted by `(event_time, event_key)` ascending so the
 * sub-divider sees same-time groups contiguously. The returned rows
 * are payload-shaped (decimal-string `event_key`, ISO `event_time`)
 * and carry the exclusion-matching columns aimer-web mirrors, plus the
 * Phase 1.B `raw_score` ranking field so refresh / backfill produce
 * the same per-event shape as the streaming `phase2.baseline.v1`
 * batches.
 *
 * Returns both the resolved single `baseline_version` (top-level for
 * the payload — Force Rebuild is guaranteed single-version since the
 * rebuild writes one version across the new corpus) and the set of
 * distinct versions actually observed in the loaded rows so callers
 * spanning historical windows (admin backfill) can reject mixed-version
 * ranges. RFC 0001 explicitly allows older `baseline_version`s to
 * remain in the 180-day corpus; a single top-level version cannot
 * faithfully represent a mixed-version window.
 */
export async function loadBaselineRefreshRows(
  client: pg.PoolClient,
  window: { fromIso: string; toIso: string },
): Promise<{
  events: BaselineRefreshEvent[];
  baselineVersion: string | null;
  baselineVersions: string[];
}> {
  const { rows } = await client.query<{
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
  }>(
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
      WHERE event_time >= $1 AND event_time < $2
      ORDER BY event_time, event_key`,
    [window.fromIso, window.toIso],
  );

  const events: BaselineRefreshEvent[] = rows.map((row) => ({
    event_key: row.event_key,
    event_time: row.event_time,
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
  }));

  const distinct = new Set<string>();
  for (const row of rows) distinct.add(row.baseline_version);
  const baselineVersions = Array.from(distinct);
  const baselineVersion = events[0]?.baseline_version as string | undefined;
  return {
    events,
    baselineVersion: baselineVersion ?? null,
    baselineVersions,
  };
}

interface StoryRowSql {
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
  last_sent_at: string | null;
  last_sent_by: string | null;
  send_count: number;
}

interface StoryMemberRowSql {
  event_group_id: string;
  event_key: string;
  role: string;
}

/**
 * Load the auto-correlated story payload rows for a `[from, to)`
 * window sliced on `time_window_end`, sorted ascending. Auto-correlated
 * only (`event_group.kind = 'auto_correlated'`); analyst-curated rows
 * are explicitly skipped per acceptance criteria.
 *
 * Each story carries its `members` array in payload shape
 * (decimal-string `event_key`, role, and — when the underlying
 * baseline row is still resident in the 180-day corpus — an embedded
 * `event` object matching the baseline-event payload shape per RFC
 * 0002 §6 `storyItem`). Members whose baseline row has been retention-
 * swept fall back to the schema-minimal `{event_key, role}` pair, since
 * `event_group_member` is intentionally not FK-linked to
 * `baseline_triaged_event` (different retention windows; see
 * `migrations/customer/0008_event_group_story.sql`). The flat
 * `time_window_start` / `time_window_end` fields are kept on the
 * in-memory shape so {@link buildStoryRefreshPayloads} can slice on
 * `time_window_end`; the wire builder ({@link toWireStoryItem}) nests
 * them into a `time_window: { start, end }` object before emission.
 */
export async function loadStoryRefreshRows(
  client: pg.PoolClient,
  window: { fromIso: string; toIso: string },
): Promise<StoryRefreshItem[]> {
  const { rows: storyRows } = await client.query<StoryRowSql>(
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
            CASE WHEN last_sent_at IS NULL THEN NULL
                 ELSE to_char(last_sent_at AT TIME ZONE 'UTC',
                              'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
            END                                     AS last_sent_at,
            last_sent_by::text                      AS last_sent_by,
            send_count
       FROM event_group
      WHERE kind = 'auto_correlated'
        AND time_window_end >= $1 AND time_window_end < $2
      ORDER BY time_window_end, id`,
    [window.fromIso, window.toIso],
  );

  if (storyRows.length === 0) return [];

  const ids = storyRows.map((r) => r.story_id);
  const { rows: memberRows } = await client.query<StoryMemberRowSql>(
    `SELECT event_group_id::text AS event_group_id,
            event_key::text      AS event_key,
            role
       FROM event_group_member
      WHERE event_group_id = ANY($1::bigint[])
      ORDER BY event_group_id, event_key`,
    [ids],
  );

  const memberKeys = Array.from(new Set(memberRows.map((m) => m.event_key)));
  const eventByKey = await loadBaselineEventsByKey(client, memberKeys);

  const membersByStory = new Map<
    string,
    Array<{
      event_key: string;
      role: string;
      event?: BaselineRefreshEvent;
    }>
  >();
  for (const m of memberRows) {
    const event = eventByKey.get(m.event_key);
    const memberItem = {
      event_key: m.event_key,
      role: m.role,
      ...(event !== undefined ? { event } : {}),
    };
    const arr = membersByStory.get(m.event_group_id);
    if (arr) arr.push(memberItem);
    else membersByStory.set(m.event_group_id, [memberItem]);
  }

  return storyRows.map((r) => ({
    story_id: r.story_id,
    story_version: r.story_version,
    kind: r.kind,
    members: membersByStory.get(r.story_id) ?? [],
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
}

/**
 * Look up baseline events for a set of `event_key`s, returning the
 * payload-shaped row keyed by `event_key`. Used by
 * {@link loadStoryRefreshRows} to embed member event details inline
 * per RFC 0002 §6 `storyItem.members[].event`. Keys whose underlying
 * row has been retention-swept (180-day corpus retention; see
 * `migrations/customer/0008_event_group_story.sql`) are absent from
 * the map; the caller treats absence as "schema-minimal member."
 */
async function loadBaselineEventsByKey(
  client: pg.PoolClient,
  eventKeys: readonly string[],
): Promise<Map<string, BaselineRefreshEvent>> {
  const map = new Map<string, BaselineRefreshEvent>();
  if (eventKeys.length === 0) return map;
  const { rows } = await client.query<{
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
  }>(
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
  for (const row of rows) {
    map.set(row.event_key, {
      event_key: row.event_key,
      event_time: row.event_time,
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
    });
  }
  return map;
}

/**
 * Emit a structured `console.warn` for each subdivider warning so the
 * operator gets visibility on oversize-same-slice groups that landed
 * in their own sub-window. The acceptance criteria (#573) call for a
 * warning identifying the timestamp and the group size whenever the
 * atomicity rule forces a sub-window above the byte budget. Callers
 * (force-rebuild + admin backfill) pass the customer / kind so the
 * line is greppable.
 */
export function logSubdivideWarnings(
  customerId: number,
  kind: string,
  warnings: readonly SubdivideWarning[],
): void {
  for (const w of warnings) {
    console.warn(
      `phase2_refresh_oversize_group: customer=${customerId} kind=${kind} ` +
        `slice=${w.sliceValue} rows=${w.rowCount} bytes=${w.bytes}`,
    );
  }
}

export const _testing = {
  subdivide,
  groupBySlice,
};
