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
 * the partial unique index
 * `(correlation_rule_id, primary_asset, time_window_start, time_window_end)
 *  WHERE kind = 'auto_correlated' AND primary_asset IS NOT NULL`
 * (migration 0008). A re-evaluated slop-window candidate therefore
 * never produces a duplicate `event_group` row.
 */

import type pg from "pg";

import type { CandidateEvent, StoryDraft, StorySummaryPayload } from "./rules";
import { STORY_VERSION } from "./rules";

export interface ReadCandidatesArgs {
  client: pg.PoolClient;
  /**
   * Inclusive lower bound on `event_time` for the member scan. Per
   * Story RFC §4 the scan window is
   * `[previous_watermark − max_rule_window, new_horizon]` so that an
   * R3 cluster whose `time_window_end` falls just past the previous
   * watermark can still pick up members that sit before the
   * watermark but inside the rule window.
   */
  memberScanStart: Date;
  /** Inclusive upper bound on `event_time` for the member scan. */
  memberScanEnd: Date;
}

/**
 * Pull the candidate events from `baseline_triaged_event` for the
 * member-scan range. The correlator passes the result straight into
 * `detectAllStories`. The scan rides the existing
 * `(event_time DESC)` btree index; no new indexes are required.
 *
 * NULL-`orig_addr` rows are intentionally retained in the result so
 * the rule layer is the single place that filters them out (R1 and
 * R3 both skip them at the predicate level).
 */
export async function readCandidateEventsInRange(
  args: ReadCandidatesArgs,
): Promise<CandidateEvent[]> {
  const { client, memberScanStart, memberScanEnd } = args;
  const result = await client.query<{
    event_key: string;
    event_time: Date;
    kind: string;
    orig_addr: string | null;
    category: string | null;
    selector_tags: string[];
    raw_score: number;
  }>(
    `SELECT event_key::text   AS event_key,
            event_time,
            kind,
            host(orig_addr)   AS orig_addr,
            category,
            selector_tags,
            raw_score
       FROM baseline_triaged_event
      WHERE event_time >= $1
        AND event_time <= $2`,
    [memberScanStart, memberScanEnd],
  );
  return result.rows.map((row) => ({
    eventKey: row.event_key,
    eventTime: row.event_time,
    kind: row.kind,
    origAddr: row.orig_addr,
    category: row.category,
    selectorTags: row.selector_tags ?? [],
    rawScore: Number(row.raw_score),
  }));
}

export interface InsertAutoStoryResult {
  /** Newly-inserted `event_group.id`, or `null` when the partial
   *  unique index suppressed the insert (idempotent replay). */
  groupId: string | null;
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
 */
export async function insertAutoStory(
  client: pg.PoolClient,
  draft: StoryDraft,
): Promise<InsertAutoStoryResult> {
  const insertGroup = await client.query<{ id: string }>(
    `INSERT INTO event_group (
        kind, correlation_rule_id, story_version,
        time_window_start, time_window_end,
        primary_asset, score, summary_payload
      )
      VALUES ('auto_correlated', $1, $2, $3, $4, $5::inet, $6, $7::jsonb)
      ON CONFLICT (correlation_rule_id, primary_asset, time_window_start, time_window_end)
        WHERE kind = 'auto_correlated' AND primary_asset IS NOT NULL
        DO NOTHING
      RETURNING id::text AS id`,
    [
      draft.ruleId,
      STORY_VERSION,
      draft.timeWindowStart,
      draft.timeWindowEnd,
      draft.primaryAsset,
      draft.score,
      JSON.stringify(draft.summary satisfies StorySummaryPayload),
    ],
  );
  if (insertGroup.rows.length === 0) {
    return { groupId: null };
  }
  const groupId = insertGroup.rows[0].id;
  await insertStoryMembers(client, groupId, draft.members, "primary");
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
