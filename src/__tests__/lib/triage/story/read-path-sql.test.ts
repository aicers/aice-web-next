import { describe, expect, it } from "vitest";

import {
  SELECT_BASELINE_EVENTS_BY_KEY_SQL,
  SELECT_STORIES_FOR_PERIOD_SQL,
  SELECT_STORY_MEMBERS_DETAIL_SQL,
  SELECT_STORY_TOP_MEMBERS_SQL,
} from "@/lib/triage/story/read-path-sql.mjs";

/**
 * #490 acceptance: "Stories list period filter uses the overlap
 * predicate (`time_window_start < period.end AND time_window_end >=
 * period.start`). A `time_window_end BETWEEN` predicate would drop
 * [the long-running cluster] fixture and MUST cause the test to fail."
 *
 * This pins the SQL string itself so any future refactor that would
 * regress to a single-bound `BETWEEN` filter is caught at unit-test
 * time rather than via a downstream integration test.
 */
describe("SELECT_STORIES_FOR_PERIOD_SQL — half-open overlap predicate", () => {
  it("uses the overlap shape (start < end-bound AND end >= start-bound)", () => {
    expect(SELECT_STORIES_FOR_PERIOD_SQL).toMatch(
      /time_window_start\s*<\s*\$2/,
    );
    expect(SELECT_STORIES_FOR_PERIOD_SQL).toMatch(/time_window_end\s*>=\s*\$1/);
  });

  it("does not regress to a single-bound BETWEEN predicate", () => {
    // A `time_window_end BETWEEN $1 AND $2` predicate would drop a
    // Story that started before period.start but extends into the
    // period — the long-running R3 case from #490's acceptance.
    expect(SELECT_STORIES_FOR_PERIOD_SQL).not.toMatch(/BETWEEN/i);
  });

  it("orders by time_window_end DESC (default sort) with score DESC and id as tiebreakers", () => {
    expect(SELECT_STORIES_FOR_PERIOD_SQL).toMatch(
      /ORDER BY\s+time_window_end DESC,\s*score DESC NULLS LAST,\s*id DESC/,
    );
  });

  it("LIMITs the page", () => {
    expect(SELECT_STORIES_FOR_PERIOD_SQL).toMatch(/LIMIT\s+\$3/);
  });
});

/**
 * #490 acceptance: "Sort key: `raw_score DESC, event_time DESC` —
 * not `baseline_score`. ... A page rendering N Stories must NOT
 * issue N small joins. The canonical shape: WITH ranked AS (...)
 * ROW_NUMBER() OVER (PARTITION BY em.event_group_id ORDER BY
 * b.raw_score DESC, b.event_time DESC)."
 */
describe("SELECT_STORY_TOP_MEMBERS_SQL — single CTE for all stories on a page", () => {
  it("partitions by event_group_id and orders by raw_score DESC, event_time DESC", () => {
    expect(SELECT_STORY_TOP_MEMBERS_SQL).toMatch(
      /PARTITION BY em\.event_group_id/,
    );
    expect(SELECT_STORY_TOP_MEMBERS_SQL).toMatch(
      /ORDER BY b\.raw_score DESC,\s*b\.event_time DESC/,
    );
  });

  it("filters per-tenant via event_group_id = ANY(::bigint[]) (single round-trip)", () => {
    expect(SELECT_STORY_TOP_MEMBERS_SQL).toMatch(
      /em\.event_group_id\s*=\s*ANY\(\$1::bigint\[\]\)/,
    );
  });

  it("limits to the top-3 (rn <= 3) — does not over-fetch then trim app-side", () => {
    expect(SELECT_STORY_TOP_MEMBERS_SQL).toMatch(/WHERE rn <= 3/);
  });

  it("uses INNER JOIN (the dangling-member contract — aged-out members silently absent)", () => {
    expect(SELECT_STORY_TOP_MEMBERS_SQL).toMatch(/JOIN baseline_triaged_event/);
    expect(SELECT_STORY_TOP_MEMBERS_SQL).not.toMatch(/LEFT JOIN/i);
  });
});

describe("SELECT_STORY_MEMBERS_DETAIL_SQL — read-time baseline_score via cume_dist", () => {
  it("uses cume_dist() with the menu's (kind, baseline_version) cohort", () => {
    expect(SELECT_STORY_MEMBERS_DETAIL_SQL).toMatch(/cume_dist\(\)/);
    expect(SELECT_STORY_MEMBERS_DETAIL_SQL).toMatch(
      /PARTITION BY kind,\s*baseline_version/,
    );
  });

  it("INNER JOINs baseline_triaged_event (dangling-member contract — period-independent)", () => {
    // The dangling-member contract requires that a member still in
    // corpus A appears in the detail panel regardless of whether
    // its `event_time` falls inside the menu period. The INNER JOIN
    // is against `baseline_triaged_event` directly, so a Story that
    // overlaps the period but began before `period.start` still
    // surfaces its earlier members.
    expect(SELECT_STORY_MEMBERS_DETAIL_SQL).toMatch(
      /JOIN baseline_triaged_event b USING \(event_key\)/,
    );
  });

  it("LEFT JOINs the period-scoped scored CTE for baseline_score (out-of-period members get NULL)", () => {
    // The `scored` CTE is filtered to the menu period so the
    // `cume_dist()` cohort matches what the asset list would show
    // for in-period rows. Members outside the period get a NULL
    // `baseline_score`, which the UI renders as `—`. Filtering
    // them out via INNER JOIN scored would mis-classify them as
    // aged past corpus A retention.
    expect(SELECT_STORY_MEMBERS_DETAIL_SQL).toMatch(
      /LEFT JOIN scored s USING \(event_key\)/,
    );
  });
});

describe("SELECT_BASELINE_EVENTS_BY_KEY_SQL — curated-save member lookup", () => {
  it("looks up by event_key = ANY(::numeric[]) (NUMERIC(39, 0) keys)", () => {
    expect(SELECT_BASELINE_EVENTS_BY_KEY_SQL).toMatch(
      /event_key\s*=\s*ANY\(\$1::numeric\[\]\)/,
    );
  });
});
