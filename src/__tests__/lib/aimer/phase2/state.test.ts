import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AimerPushQueueRow } from "@/lib/aimer/phase2/state";

interface FakeQueryCall {
  sql: string;
  params: unknown[] | undefined;
}

/**
 * Fake `pg` Pool/Client whose `query()` returns whatever the test's
 * router function decides based on the SQL fragment. Tests inspect
 * `calls` after the helper runs to assert the SQL shape + params.
 */
function makeFakePool() {
  const calls: FakeQueryCall[] = [];
  let response: (sql: string) => { rows: unknown[]; rowCount: number } =
    () => ({
      rows: [],
      rowCount: 0,
    });

  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      return response(sql);
    }),
    release: vi.fn(),
  };

  const pool = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      return response(sql);
    }),
    connect: vi.fn(async () => client),
  };

  return {
    pool,
    client,
    calls,
    setResponse: (
      fn: (sql: string) => { rows: unknown[]; rowCount: number },
    ) => {
      response = fn;
    },
  };
}

const fake = makeFakePool();
vi.mock("@/lib/triage/policy/customer-db", () => ({
  getCustomerPool: vi.fn(async () => fake.pool),
}));

describe("Phase 2 state helpers (state.ts)", () => {
  let state: typeof import("@/lib/aimer/phase2/state");

  beforeEach(async () => {
    state = await import("@/lib/aimer/phase2/state");
    fake.calls.length = 0;
    fake.client.query.mockClear();
    fake.pool.query.mockClear();
    fake.pool.connect.mockClear();
    fake.client.release.mockClear();
    fake.setResponse(() => ({ rows: [], rowCount: 0 }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Re-exports ────────────────────────────────────────────────

  it("re-exports SYSTEM_ACTOR_ACCOUNT_ID from orchestrate.ts", () => {
    expect(state.SYSTEM_ACTOR_ACCOUNT_ID).toBe(
      "00000000-0000-0000-0000-000000000000",
    );
  });

  it("exposes the drain → queue-kind mapping per RFC 0002 §7", () => {
    expect(state.PHASE2_QUEUE_KINDS_BY_DRAIN).toEqual({
      baseline_event: [
        "withdraw_baseline_event",
        "refresh_baseline_window",
        "backfill_baseline_window",
      ],
      story: [
        "withdraw_story",
        "refresh_story_window",
        "backfill_story_window",
      ],
      policy_event: ["withdraw_policy_event"],
    });
  });

  // ── State helpers ─────────────────────────────────────────────

  it("getAimerPushState returns the row when present, null otherwise", async () => {
    const activatedAt = new Date("2026-05-09T00:00:00Z");
    fake.setResponse((sql) => {
      if (sql.includes("FROM aimer_push_state")) {
        return {
          rows: [
            {
              kind: "baseline_event",
              last_pushed_event_time: new Date("2026-05-10T00:00:00Z"),
              last_pushed_event_key: "100",
              last_synced_at: null,
              last_error: null,
              opportunistic_enabled: true,
              paused_at: null,
              paused_by: null,
              streaming_activated_at: activatedAt,
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const row = await state.getAimerPushState(1, "baseline_event");
    expect(row?.last_pushed_event_key).toBe("100");
    expect(row?.opportunistic_enabled).toBe(true);
    expect(row?.streaming_activated_at).toEqual(activatedAt);
    // Round-5 regression: the SELECT must include the new column so
    // the story drain's straggler scan has its activation watermark.
    const selectCall = fake.calls.find(
      (c) =>
        typeof c.sql === "string" && c.sql.includes("FROM aimer_push_state"),
    );
    expect(selectCall?.sql).toContain("streaming_activated_at");

    fake.setResponse(() => ({ rows: [], rowCount: 0 }));
    const none = await state.getAimerPushState(1, "story");
    expect(none).toBeNull();
  });

  it("advanceCursor uses a FOR UPDATE lock and only advances monotonically", async () => {
    await state.advanceCursor(
      1,
      "baseline_event",
      new Date("2026-05-10T12:00:00Z"),
      "200",
    );
    const call = fake.calls[0];
    expect(call.sql).toContain("FOR UPDATE");
    // Monotonic guard: WHERE clause compares prior cursor strictly less
    // than the new value.
    expect(call.sql).toContain("(l.last_pushed_event_time IS NULL");
    expect(call.sql).toContain(
      "(l.last_pushed_event_time, l.last_pushed_event_key::numeric)",
    );
    expect(call.params).toEqual([
      "baseline_event",
      new Date("2026-05-10T12:00:00Z"),
      "200",
    ]);
  });

  it("advanceCursor compares event_key numerically (regression: '9' → '10' at same timestamp)", async () => {
    // `aimer_push_state.last_pushed_event_key` is TEXT, but stores the
    // decimal-string form of `NUMERIC(39, 0)` source-table event_keys.
    // Text ordering would say `"9" > "10"` and refuse the advance,
    // leaving the cursor stuck at `"9"` and re-sending the same row
    // forever. The SQL must cast both sides to `NUMERIC` so the
    // monotonic guard matches source-table ordering.
    await state.advanceCursor(
      1,
      "baseline_event",
      new Date("2026-05-10T12:00:00Z"),
      "10",
    );
    const call = fake.calls[0];
    expect(call.sql).toContain("l.last_pushed_event_key::numeric");
    expect(call.sql).toContain("$3::numeric");
    // The text-only comparison must NOT survive (regression guard).
    expect(call.sql).not.toMatch(
      /\(l\.last_pushed_event_time, l\.last_pushed_event_key\)\s*<\s*\(\$2::timestamptz, \$3\)/,
    );
  });

  it("recordSyncError writes last_error without touching the cursor", async () => {
    await state.recordSyncError(1, "story", "boom");
    const call = fake.calls[0];
    expect(call.sql).toContain("UPDATE aimer_push_state");
    expect(call.sql).toContain("last_error = $2");
    expect(call.sql).not.toContain("last_pushed_event_time");
    expect(call.params).toEqual(["story", "boom"]);
  });

  it("clearSyncError nulls last_error", async () => {
    await state.clearSyncError(1, "story");
    expect(fake.calls[0].sql).toContain("last_error = NULL");
  });

  // ── Pause toggle ──────────────────────────────────────────────

  it("setOpportunisticEnabled(false) records paused_at + paused_by", async () => {
    await state.setOpportunisticEnabled(1, "story", false, "acct-1");
    const call = fake.calls[0];
    expect(call.sql).toContain("opportunistic_enabled = FALSE");
    expect(call.sql).toContain("paused_at             = NOW()");
    expect(call.sql).toContain("paused_by             = $2");
    expect(call.params).toEqual(["story", "acct-1"]);
  });

  it("setOpportunisticEnabled(true) clears paused_at + paused_by", async () => {
    await state.setOpportunisticEnabled(1, "story", true, "acct-1");
    const call = fake.calls[0];
    expect(call.sql).toContain("opportunistic_enabled = TRUE");
    expect(call.sql).toContain("paused_at             = NULL");
    expect(call.sql).toContain("paused_by             = NULL");
  });

  it("isOpportunisticEnabled returns the stored flag (defaulting to true)", async () => {
    fake.setResponse(() => ({
      rows: [{ opportunistic_enabled: false }],
      rowCount: 1,
    }));
    expect(await state.isOpportunisticEnabled(1, "story")).toBe(false);

    fake.setResponse(() => ({ rows: [], rowCount: 0 }));
    expect(await state.isOpportunisticEnabled(1, "story")).toBe(true);
  });

  // ── Queue helpers ─────────────────────────────────────────────

  it("enqueueNotice writes the row and returns the id as a string", async () => {
    fake.setResponse(() => ({ rows: [{ id: "42" }], rowCount: 1 }));
    const id = await state.enqueueNotice(1, "withdraw_policy_event", {
      kind: "policy_event",
      run_id: "5",
      event_keys: ["100"],
    });
    expect(id).toBe("42");
    const call = fake.calls[0];
    expect(call.sql).toContain("INSERT INTO aimer_push_queue");
    expect(call.params?.[0]).toBe("withdraw_policy_event");
    expect(JSON.parse(call.params?.[1] as string)).toEqual({
      kind: "policy_event",
      run_id: "5",
      event_keys: ["100"],
    });
  });

  it("enqueueNotice issues the INSERT on the supplied client so the row joins the caller's txn", async () => {
    // Per #573 prerequisite: when `client` is provided the INSERT must
    // run on that connection so a caller's COMMIT/ROLLBACK governs the
    // queue row's durability. The test verifies the pool is NOT used.
    const callerCalls: FakeQueryCall[] = [];
    const callerClient = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        callerCalls.push({ sql, params });
        return { rows: [{ id: "99" }], rowCount: 1 };
      }),
      release: vi.fn(),
    };

    const id = await state.enqueueNotice(
      1,
      "withdraw_baseline_event",
      { baseline_version: "v1", event_keys: ["1", "2"] },
      callerClient as unknown as Parameters<typeof state.enqueueNotice>[3],
    );

    expect(id).toBe("99");
    expect(callerCalls).toHaveLength(1);
    expect(callerCalls[0].sql).toContain("INSERT INTO aimer_push_queue");
    expect(callerCalls[0].params?.[0]).toBe("withdraw_baseline_event");
    expect(JSON.parse(callerCalls[0].params?.[1] as string)).toEqual({
      baseline_version: "v1",
      event_keys: ["1", "2"],
    });
    // Pool must not have been touched at all — proves the helper joined
    // the caller's transaction rather than opening a fresh connection.
    expect(fake.pool.connect).not.toHaveBeenCalled();
    expect(fake.pool.query).not.toHaveBeenCalled();
  });

  it("claimPendingNotices('baseline_event') filters by the baseline queue-kind set only", async () => {
    fake.setResponse(() => ({ rows: [], rowCount: 0 }));
    await state.claimPendingNotices(1, "baseline_event", { limit: 50 });
    const call = fake.calls[0];
    expect(call.sql).toContain("FROM aimer_push_queue");
    expect(call.sql).toContain("acked_at IS NULL");
    expect(call.sql).toContain("kind = ANY($1::text[])");
    // Order is non-exclusive (no FOR UPDATE SKIP LOCKED) so concurrent
    // activations both see the same pending rows.
    expect(call.sql).not.toContain("FOR UPDATE");
    expect(call.params?.[0]).toEqual([
      "withdraw_baseline_event",
      "refresh_baseline_window",
      "backfill_baseline_window",
    ]);
    expect(call.params?.[1]).toBe(50);
  });

  it("claimPendingNotices('story') filters by the story queue-kind set only", async () => {
    await state.claimPendingNotices(1, "story", { limit: 50 });
    expect(fake.calls[0].params?.[0]).toEqual([
      "withdraw_story",
      "refresh_story_window",
      "backfill_story_window",
    ]);
  });

  it("claimPendingNotices('policy_event') filters by withdraw_policy_event only", async () => {
    await state.claimPendingNotices(1, "policy_event", { limit: 50 });
    expect(fake.calls[0].params?.[0]).toEqual(["withdraw_policy_event"]);
  });

  it("markAcked is idempotent (skips rows where acked_at IS NOT NULL)", async () => {
    await state.markAcked(1, ["5", "6"], "jti-1");
    const call = fake.calls[0];
    expect(call.sql).toContain("UPDATE aimer_push_queue");
    expect(call.sql).toContain("acked_at IS NULL");
    expect(call.params).toEqual([["5", "6"], "jti-1"]);
  });

  it("markAcked clears any prior last_error so a later successful ack does not show a stale failure", async () => {
    // Per #570 "success/failure observability": a successful ack on a
    // queue notice must clear `last_error`, otherwise the 30-day audit
    // surface keeps showing the failure string for a row that ultimately
    // succeeded. This test pins the SQL to that contract.
    await state.markAcked(1, ["5"], "jti-1");
    expect(fake.calls[0].sql).toContain("last_error        = NULL");
  });

  it("markAcked with empty rowIds is a no-op", async () => {
    await state.markAcked(1, [], "jti-1");
    expect(fake.calls.length).toBe(0);
  });

  it("recordNoticeError increments attempts and writes last_error + last_attempt_at", async () => {
    await state.recordNoticeError(1, ["5"], "boom");
    const call = fake.calls[0];
    expect(call.sql).toContain("attempts        = attempts + 1");
    expect(call.sql).toContain("last_error      = $2");
    expect(call.sql).toContain("last_attempt_at = NOW()");
    expect(call.params).toEqual([["5"], "boom"]);
  });

  it("recordNoticeError skips rows already acked by a concurrent duplicate drain (#570 'cleared on ack')", async () => {
    // Regression for success-then-duplicate-failure ordering: the queue
    // claim is intentionally non-exclusive, so two activations can
    // include the same `aimer_push_queue.id` in different inflight
    // rows. If one delivery succeeds first, `markAcked` sets
    // `acked_at` and clears `last_error`. If the other duplicate
    // delivery later reports failure, the failure UPDATE must NOT
    // touch the now-acked row — otherwise the audit-retained row
    // shows a stale failure on an ultimately-successful delivery,
    // breaking the #570 "cleared on ack" observability contract.
    await state.recordNoticeError(1, ["5"], "boom");
    const call = fake.calls[0];
    expect(call.sql).toContain("acked_at IS NULL");
  });

  // ── Inflight helpers ──────────────────────────────────────────

  it("insertInflight writes the row keyed on context_jti", async () => {
    await state.insertInflight(1, {
      contextJti: "jti-1",
      kind: "policy_event",
      cursorAdvanceToEventTime: null,
      cursorAdvanceToEventKey: null,
      queueRowIds: ["10", "11"],
    });
    const call = fake.calls[0];
    expect(call.sql).toContain("INSERT INTO aimer_push_inflight");
    // 6th param is the JSONB-serialized pending_tail_notices array,
    // 7th param is the JSONB-serialized pushed_stories array — both
    // default to "[]" when the caller omits them.
    expect(call.params).toEqual([
      "jti-1",
      "policy_event",
      null,
      null,
      ["10", "11"],
      "[]",
      "[]",
    ]);
  });

  it("insertInflight serializes pending tail notices into the JSONB column", async () => {
    // Drain routes that subdivide a queue payload at push time (e.g.
    // refresh/backfill post-enrichment subdivision in the baseline-event
    // drain) record the tail sub-payloads on the inflight row so they
    // ride the head batch's ack/fail outcome. The column is JSONB so we
    // serialize the array here.
    await state.insertInflight(1, {
      contextJti: "jti-1",
      kind: "baseline_event",
      cursorAdvanceToEventTime: null,
      cursorAdvanceToEventKey: null,
      queueRowIds: ["10"],
      pendingTailNotices: [
        {
          kind: "refresh_baseline_window",
          payload: { window: { from: "a", to: "b" } },
        },
      ],
    });
    const call = fake.calls[0];
    expect(call.params?.[5]).toBe(
      JSON.stringify([
        {
          kind: "refresh_baseline_window",
          payload: { window: { from: "a", to: "b" } },
        },
      ]),
    );
  });

  it("commitOnAck for policy_event marks queue rows ack'd and deletes the inflight", async () => {
    fake.setResponse((sql) => {
      if (sql.includes("FROM aimer_push_inflight")) {
        return {
          rows: [
            {
              context_jti: "jti-1",
              kind: "policy_event",
              cursor_advance_to_event_time: null,
              cursor_advance_to_event_key: null,
              queue_row_ids: ["10", "11"],
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    await state.commitOnAck(1, "jti-1", "policy_event");

    const sqls = fake.calls.map((c) => c.sql);
    // BEGIN, SELECT FOR UPDATE, UPDATE queue, DELETE inflight, COMMIT.
    expect(sqls[0]).toBe("BEGIN");
    expect(sqls[1]).toContain("FROM aimer_push_inflight");
    expect(sqls[1]).toContain("FOR UPDATE");
    // The lookup is scoped to the expected drain kind so a JTI minted
    // by another drain (baseline/story) is a no-op rather than
    // accidentally touching `aimer_push_state`.
    expect(sqls[1]).toContain("kind = $2");
    expect(fake.calls[1].params).toEqual(["jti-1", "policy_event"]);
    const updateQueue = sqls.find((s) => s.includes("UPDATE aimer_push_queue"));
    expect(updateQueue).toBeDefined();
    expect(sqls.some((s) => s.includes("UPDATE aimer_push_state"))).toBe(false);
    expect(
      sqls.some((s) => s.startsWith("DELETE FROM aimer_push_inflight")),
    ).toBe(true);
    expect(sqls[sqls.length - 1]).toBe("COMMIT");
  });

  it("commitOnAck with a kind mismatch (cross-route JTI) is a no-op", async () => {
    // Regression for cross-route JTI confusion: if a caller posts an
    // `acked_context_jti` minted by the baseline drain to the
    // policy-event route, the policy_event-scoped SELECT must find no
    // row and the helper must not touch `aimer_push_state` even though
    // a streaming inflight row physically exists in the table.
    //
    // We simulate the kind-scoped SELECT (which the helper passes the
    // expected kind to) by only returning a row when the params include
    // the matching kind.
    fake.setResponse((sql) => {
      if (sql.includes("FROM aimer_push_inflight")) {
        // No row because the policy_event-scoped lookup does not match
        // the baseline_event row that exists in the table.
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    });
    await state.commitOnAck(1, "jti-from-baseline", "policy_event");
    const sqls = fake.calls.map((c) => c.sql);
    // The unknown-jti no-op shape: BEGIN, SELECT, COMMIT — nothing else.
    expect(sqls).toEqual([
      "BEGIN",
      expect.stringContaining("FROM aimer_push_inflight"),
      "COMMIT",
    ]);
    expect(sqls.some((s) => s.includes("UPDATE aimer_push_state"))).toBe(false);
    expect(sqls.some((s) => s.includes("UPDATE aimer_push_queue"))).toBe(false);
    expect(
      sqls.some((s) => s.startsWith("DELETE FROM aimer_push_inflight")),
    ).toBe(false);
  });

  it("commitOnAck enqueues pending tail notices atomically with the ack", async () => {
    // Drain routes that subdivide a payload at push time record the
    // tail sub-payloads on the inflight row. Coupling the enqueue to
    // ack means a failed POST drops the tail with `recordOnFail`'s
    // inflight delete instead of leaving duplicates in the queue
    // across retries.
    fake.setResponse((sql) => {
      if (sql.includes("FROM aimer_push_inflight")) {
        return {
          rows: [
            {
              context_jti: "jti-tail",
              kind: "baseline_event",
              cursor_advance_to_event_time: null,
              cursor_advance_to_event_key: null,
              queue_row_ids: ["50"],
              pending_tail_notices: [
                {
                  kind: "refresh_baseline_window",
                  payload: { window: { from: "a", to: "b" }, events: [] },
                },
                {
                  kind: "refresh_baseline_window",
                  payload: { window: { from: "b", to: "c" }, events: [] },
                },
              ],
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.startsWith("INSERT INTO aimer_push_queue")) {
        return { rows: [{ id: "999" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    await state.commitOnAck(1, "jti-tail", "baseline_event");

    const inserts = fake.calls.filter((c) =>
      c.sql.startsWith("INSERT INTO aimer_push_queue"),
    );
    expect(inserts).toHaveLength(2);
    // Each insert preserves the queue kind so refresh stays refresh.
    expect(inserts[0].params?.[0]).toBe("refresh_baseline_window");
    expect(inserts[1].params?.[0]).toBe("refresh_baseline_window");
    // The inflight DELETE still runs after the tail INSERTs so the
    // whole ack is one atomic unit.
    const sqls = fake.calls.map((c) => c.sql);
    const deleteIdx = sqls.findIndex((s) =>
      s.startsWith("DELETE FROM aimer_push_inflight"),
    );
    const lastInsertIdx = sqls.lastIndexOf(inserts[1].sql);
    expect(deleteIdx).toBeGreaterThan(lastInsertIdx);
  });

  it("commitOnAck for streaming kinds advances the cursor", async () => {
    fake.setResponse((sql) => {
      if (sql.includes("FROM aimer_push_inflight")) {
        return {
          rows: [
            {
              context_jti: "jti-2",
              kind: "baseline_event",
              cursor_advance_to_event_time: new Date("2026-05-10T12:00:00Z"),
              cursor_advance_to_event_key: "200",
              queue_row_ids: [],
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    await state.commitOnAck(1, "jti-2", "baseline_event");

    const sqls = fake.calls.map((c) => c.sql);
    expect(sqls.some((s) => s.includes("UPDATE aimer_push_state"))).toBe(true);
    expect(sqls.some((s) => s.includes("FOR UPDATE"))).toBe(true);
  });

  it("commitOnAck story branch β-bumps + audits the persisted pushed_stories set, not a live cursor-range recomputation", async () => {
    // Regression for the round-3 race: an `auto_correlated` row
    // inserted between mint and ack whose `time_window_end` falls
    // inside the minted (prev_cursor, new_cursor] window must not
    // be marked sent or audited just because it happens to sit in
    // the range now. The ack path uses the persisted pushed_stories
    // set (the rows that were actually in the signed envelope),
    // not the live range.
    fake.setResponse((sql) => {
      if (sql.includes("FROM aimer_push_inflight")) {
        return {
          rows: [
            {
              context_jti: "jti-story",
              kind: "story",
              cursor_advance_to_event_time: new Date("2026-01-02T00:00:00Z"),
              cursor_advance_to_event_key: "1002",
              queue_row_ids: [],
              pending_tail_notices: [],
              pushed_stories: [
                { story_id: "1000", story_version: "v1" },
                { story_id: "1002", story_version: "v1" },
              ],
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes("UPDATE event_group")) {
        // No manual-Send race in this test — both ids are still unsent,
        // RETURNING surfaces them all.
        return {
          rows: [{ id: "1000" }, { id: "1002" }],
          rowCount: 2,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const result = await state.commitOnAck(1, "jti-story", "story");

    // Returned β rows match the persisted set exactly — no id 1001.
    expect(result.storyBetaRows).toEqual([
      { storyId: "1000", storyVersion: "v1" },
      { storyId: "1002", storyVersion: "v1" },
    ]);

    // The UPDATE event_group targets the persisted ids only and gates
    // on `last_sent_at IS NULL` so a racing manual Send wins.
    const updateBeta = fake.calls.find((c) =>
      c.sql.includes("UPDATE event_group"),
    );
    expect(updateBeta).toBeDefined();
    expect(updateBeta?.params?.[0]).toEqual(["1000", "1002"]);
    expect(updateBeta?.sql).toContain("last_sent_at IS NULL");
    expect(updateBeta?.sql).toContain("RETURNING");

    // The ack path must NOT issue a recomputed range SELECT from
    // event_group — that was the bug. The cursor advance still
    // runs, but no live-range membership query is performed.
    const recomputeSelect = fake.calls.find(
      (c) =>
        c.sql.includes("FROM event_group") &&
        c.sql.includes("kind = 'auto_correlated'") &&
        c.sql.includes("time_window_end"),
    );
    expect(recomputeSelect).toBeUndefined();

    // Cursor advance still happens via aimer_push_state UPDATE.
    expect(
      fake.calls.some((c) => c.sql.includes("UPDATE aimer_push_state")),
    ).toBe(true);
  });

  it("commitOnAck story branch with an empty pushed_stories set bumps no β rows (cursor advance still runs)", async () => {
    fake.setResponse((sql) => {
      if (sql.includes("FROM aimer_push_inflight")) {
        return {
          rows: [
            {
              context_jti: "jti-story-empty",
              kind: "story",
              cursor_advance_to_event_time: new Date("2026-01-02T00:00:00Z"),
              cursor_advance_to_event_key: "1002",
              queue_row_ids: [],
              pending_tail_notices: [],
              pushed_stories: [],
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const result = await state.commitOnAck(1, "jti-story-empty", "story");
    expect(result.storyBetaRows).toEqual([]);
    expect(fake.calls.some((c) => c.sql.includes("UPDATE event_group"))).toBe(
      false,
    );
    expect(
      fake.calls.some((c) => c.sql.includes("UPDATE aimer_push_state")),
    ).toBe(true);
  });

  it("commitOnAck story straggler branch β-bumps pushed_stories WITHOUT advancing the cursor", async () => {
    // Regression for the round-6 finding: the late-commit straggler
    // scan emits a `story` inflight row whose
    // `cursor_advance_to_event_time` / `cursor_advance_to_event_key`
    // are NULL (because the rows sit AT OR BEHIND the cursor) but
    // `pushed_stories` is populated. The ack path MUST mark those
    // rows sent on `event_group.last_sent_at` and surface the β rows
    // so per-Story audit emission happens. Previously the β-bump was
    // nested inside the cursor-advance branch, so straggler rows
    // were POSTed to aimer-web but never marked delivered — every
    // subsequent next-batch call re-selected the same rows because
    // `loadStoryStragglerSlice` filters on `last_sent_at IS NULL`.
    fake.setResponse((sql) => {
      if (sql.includes("FROM aimer_push_inflight")) {
        return {
          rows: [
            {
              context_jti: "jti-straggler",
              kind: "story",
              cursor_advance_to_event_time: null,
              cursor_advance_to_event_key: null,
              queue_row_ids: [],
              pending_tail_notices: [],
              pushed_stories: [
                { story_id: "900", story_version: "v1" },
                { story_id: "901", story_version: "v1" },
              ],
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes("UPDATE event_group")) {
        return {
          rows: [{ id: "900" }, { id: "901" }],
          rowCount: 2,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const result = await state.commitOnAck(1, "jti-straggler", "story");

    // β-bump targets the persisted straggler set.
    expect(result.storyBetaRows).toEqual([
      { storyId: "900", storyVersion: "v1" },
      { storyId: "901", storyVersion: "v1" },
    ]);
    const updateBeta = fake.calls.find((c) =>
      c.sql.includes("UPDATE event_group"),
    );
    expect(updateBeta).toBeDefined();
    expect(updateBeta?.params?.[0]).toEqual(["900", "901"]);

    // No forward cursor advance — straggler rows sit BEHIND the
    // cursor, so the cursor must NOT move. The drain still records
    // liveness via `last_synced_at`.
    const stateUpdates = fake.calls.filter((c) =>
      c.sql.includes("UPDATE aimer_push_state"),
    );
    expect(stateUpdates.length).toBeGreaterThan(0);
    expect(
      stateUpdates.every(
        (c) =>
          c.sql.includes("last_synced_at") &&
          !c.sql.includes("last_pushed_event_time"),
      ),
    ).toBe(true);
  });

  it("commitOnAck story branch skips β-bump + audit for rows a racing manual Send already marked sent", async () => {
    // Regression for round-7 finding: an opportunistic batch is
    // minted for Stories [2000, 2001, 2002]; before the ack arrives,
    // an analyst manually Sends 2001. `ack-manual` stamps 2001 with
    // the analyst's account id and `send_count = 1`. The opportunistic
    // ack must NOT overwrite 2001 (preserving manual attribution) and
    // must NOT emit a `triage.story.send` audit row for 2001 (the
    // manual-send audit already covered it). The β-update is gated on
    // `last_sent_at IS NULL`; only 2000 and 2002 are returned, so
    // `storyBetaRows` excludes 2001 and the route's audit emission
    // loop skips it.
    fake.setResponse((sql) => {
      if (sql.includes("FROM aimer_push_inflight")) {
        return {
          rows: [
            {
              context_jti: "jti-race",
              kind: "story",
              cursor_advance_to_event_time: new Date("2026-01-03T00:00:00Z"),
              cursor_advance_to_event_key: "2002",
              queue_row_ids: [],
              pending_tail_notices: [],
              pushed_stories: [
                { story_id: "2000", story_version: "v1" },
                { story_id: "2001", story_version: "v1" },
                { story_id: "2002", story_version: "v1" },
              ],
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes("UPDATE event_group")) {
        // RETURNING omits 2001 — the manual Send already set its
        // `last_sent_at` so the `AND last_sent_at IS NULL` predicate
        // excluded it from this UPDATE.
        return {
          rows: [{ id: "2000" }, { id: "2002" }],
          rowCount: 2,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const result = await state.commitOnAck(1, "jti-race", "story");

    // Only the rows actually bumped surface — 2001 stays attributed
    // to the analyst.
    expect(result.storyBetaRows).toEqual([
      { storyId: "2000", storyVersion: "v1" },
      { storyId: "2002", storyVersion: "v1" },
    ]);

    // The UPDATE itself targets all three persisted ids but is gated
    // by `last_sent_at IS NULL`; PG drops the racing row.
    const updateBeta = fake.calls.find((c) =>
      c.sql.includes("UPDATE event_group"),
    );
    expect(updateBeta).toBeDefined();
    expect(updateBeta?.params?.[0]).toEqual(["2000", "2001", "2002"]);
    expect(updateBeta?.sql).toContain("last_sent_at IS NULL");
    expect(updateBeta?.sql).toContain("RETURNING");
  });

  it("insertInflight persists pushed_stories as JSONB when provided", async () => {
    await state.insertInflight(1, {
      contextJti: "jti-insert",
      kind: "story",
      cursorAdvanceToEventTime: new Date("2026-01-02T00:00:00Z"),
      cursorAdvanceToEventKey: "1002",
      queueRowIds: [],
      pushedStories: [
        { storyId: "1000", storyVersion: "v1" },
        { storyId: "1002", storyVersion: "v1" },
      ],
    });
    const call = fake.calls.find((c) =>
      c.sql.includes("INSERT INTO aimer_push_inflight"),
    );
    expect(call).toBeDefined();
    expect(call?.sql).toContain("pushed_stories");
    // 7th param is the JSONB-encoded pushed_stories payload.
    expect(call?.params?.[6]).toBe(
      JSON.stringify([
        { story_id: "1000", story_version: "v1" },
        { story_id: "1002", story_version: "v1" },
      ]),
    );
  });

  it("insertInflight defaults pushed_stories to '[]' when omitted", async () => {
    await state.insertInflight(1, {
      contextJti: "jti-no-stories",
      kind: "baseline_event",
      cursorAdvanceToEventTime: new Date("2026-01-02T00:00:00Z"),
      cursorAdvanceToEventKey: "200",
      queueRowIds: [],
    });
    const call = fake.calls.find((c) =>
      c.sql.includes("INSERT INTO aimer_push_inflight"),
    );
    expect(call?.params?.[6]).toBe("[]");
  });

  it("commitOnAck on an unknown jti is a no-op", async () => {
    fake.setResponse(() => ({ rows: [], rowCount: 0 }));
    await state.commitOnAck(1, "unknown-jti", "policy_event");
    const sqls = fake.calls.map((c) => c.sql);
    // BEGIN, SELECT, COMMIT only.
    expect(sqls).toEqual([
      "BEGIN",
      expect.stringContaining("FROM aimer_push_inflight"),
      "COMMIT",
    ]);
  });

  it("recordOnFail for policy_event writes queue last_error and skips state", async () => {
    fake.setResponse((sql) => {
      if (sql.includes("FROM aimer_push_inflight")) {
        return {
          rows: [
            {
              context_jti: "jti-3",
              kind: "policy_event",
              cursor_advance_to_event_time: null,
              cursor_advance_to_event_key: null,
              queue_row_ids: ["20"],
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    await state.recordOnFail(1, "jti-3", "aimer 500", "policy_event");

    const sqls = fake.calls.map((c) => c.sql);
    // For policy_event the helper must NOT touch aimer_push_state.
    expect(sqls.some((s) => s.includes("UPDATE aimer_push_state"))).toBe(false);
    expect(sqls.some((s) => s.includes("attempts        = attempts + 1"))).toBe(
      true,
    );
    expect(
      sqls.some((s) => s.startsWith("DELETE FROM aimer_push_inflight")),
    ).toBe(true);
    // The lookup is scoped to the expected drain kind.
    expect(sqls[1]).toContain("kind = $2");
    expect(fake.calls[1].params).toEqual(["jti-3", "policy_event"]);
  });

  it("recordOnFail with a kind mismatch (cross-route JTI) is a no-op", async () => {
    // Regression for cross-route JTI confusion on the failure path:
    // posting a `failed_context_jti` minted by a streaming drain to
    // the policy-event route must not call `recordSyncError` on
    // `aimer_push_state` for that streaming kind.
    fake.setResponse(() => ({ rows: [], rowCount: 0 }));
    await state.recordOnFail(1, "jti-from-story", "boom", "policy_event");
    const sqls = fake.calls.map((c) => c.sql);
    expect(sqls).toEqual([
      "BEGIN",
      expect.stringContaining("FROM aimer_push_inflight"),
      "COMMIT",
    ]);
    expect(sqls.some((s) => s.includes("UPDATE aimer_push_state"))).toBe(false);
    expect(sqls.some((s) => s.includes("UPDATE aimer_push_queue"))).toBe(false);
    expect(
      sqls.some((s) => s.startsWith("DELETE FROM aimer_push_inflight")),
    ).toBe(false);
  });

  it("recordOnFail for streaming kind writes aimer_push_state.last_error", async () => {
    fake.setResponse((sql) => {
      if (sql.includes("FROM aimer_push_inflight")) {
        return {
          rows: [
            {
              context_jti: "jti-4",
              kind: "story",
              cursor_advance_to_event_time: new Date("2026-05-10T12:00:00Z"),
              cursor_advance_to_event_key: "300",
              queue_row_ids: [],
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    await state.recordOnFail(1, "jti-4", "boom", "story");
    const sqls = fake.calls.map((c) => c.sql);
    expect(sqls.some((s) => s.includes("UPDATE aimer_push_state"))).toBe(true);
  });

  it("pruneExpiredInflight deletes by TTL", async () => {
    fake.setResponse(() => ({ rows: [], rowCount: 3 }));
    const deleted = await state.pruneExpiredInflight(1);
    expect(deleted).toBe(3);
    const call = fake.calls[0];
    expect(call.sql).toContain("DELETE FROM aimer_push_inflight");
    expect(call.sql).toContain("minted_at < NOW() - make_interval");
    expect(call.params).toEqual([state.PHASE2_INFLIGHT_TTL_SECONDS]);
  });

  // ── Backlog estimation ──────────────────────────────────────

  it("estimateBacklog('policy_event') stays 'synced' for small pending queues (#570 threshold ≥10 → 'behind')", async () => {
    fake.setResponse(() => ({ rows: [{ count: "7" }], rowCount: 1 }));
    const est = await state.estimateBacklog(1, "policy_event");
    expect(est).toEqual({
      bucket: "synced",
      approximate_count: null,
      cursor_lag_seconds: null,
      newest_unsent_event_time: null,
      pending_notice_count: 7,
    });
  });

  it("estimateBacklog('policy_event') escalates to 'behind' at ≥10 pending and 'way_behind' at ≥100", async () => {
    fake.setResponse(() => ({ rows: [{ count: "12" }], rowCount: 1 }));
    expect((await state.estimateBacklog(1, "policy_event")).bucket).toBe(
      "behind",
    );
    fake.calls.length = 0;
    fake.setResponse(() => ({ rows: [{ count: "150" }], rowCount: 1 }));
    expect((await state.estimateBacklog(1, "policy_event")).bucket).toBe(
      "way_behind",
    );
  });

  it("estimateBacklog returns 'paused' when opportunistic_enabled is false", async () => {
    fake.setResponse((sql) => {
      if (sql.includes("FROM aimer_push_queue")) {
        return { rows: [{ count: "0" }], rowCount: 1 };
      }
      if (sql.includes("FROM aimer_push_state")) {
        return {
          rows: [
            {
              kind: "story",
              last_pushed_event_time: null,
              last_pushed_event_key: null,
              last_synced_at: null,
              last_error: null,
              opportunistic_enabled: false,
              paused_at: new Date(),
              paused_by: "acct-1",
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const est = await state.estimateBacklog(1, "story");
    expect(est.bucket).toBe("paused");
  });

  it("estimateBacklog returns 'way_behind' once cursor lag crosses the 1-hour threshold", async () => {
    const seventyMinutesAgo = new Date(Date.now() - 70 * 60 * 1000);
    fake.setResponse((sql) => {
      if (sql.includes("FROM aimer_push_queue")) {
        return { rows: [{ count: "0" }], rowCount: 1 };
      }
      if (sql.includes("FROM aimer_push_state")) {
        return {
          rows: [
            {
              kind: "story",
              last_pushed_event_time: seventyMinutesAgo,
              last_pushed_event_key: "1",
              last_synced_at: null,
              last_error: null,
              opportunistic_enabled: true,
              paused_at: null,
              paused_by: null,
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const est = await state.estimateBacklog(1, "story");
    expect(est.bucket).toBe("way_behind");
  });

  it("estimateBacklog returns 'behind' between the 5-minute and 1-hour thresholds", async () => {
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    fake.setResponse((sql) => {
      if (sql.includes("FROM aimer_push_queue")) {
        return { rows: [{ count: "0" }], rowCount: 1 };
      }
      if (sql.includes("FROM aimer_push_state")) {
        return {
          rows: [
            {
              kind: "story",
              last_pushed_event_time: tenMinutesAgo,
              last_pushed_event_key: "1",
              last_synced_at: null,
              last_error: null,
              opportunistic_enabled: true,
              paused_at: null,
              paused_by: null,
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const est = await state.estimateBacklog(1, "story");
    expect(est.bucket).toBe("behind");
  });

  it("estimateBacklog stays 'synced' when a small pending count would have flipped the old per-row threshold", async () => {
    // Old behavior: any positive pending_notice_count → behind. New
    // #570 contract: <10 pending notices is still 'synced' as long as
    // the cursor is fresh.
    fake.setResponse((sql) => {
      if (sql.includes("FROM aimer_push_queue")) {
        return { rows: [{ count: "3" }], rowCount: 1 };
      }
      if (sql.includes("FROM aimer_push_state")) {
        return {
          rows: [
            {
              kind: "story",
              last_pushed_event_time: new Date(Date.now() - 60 * 1000),
              last_pushed_event_key: "9",
              last_synced_at: new Date(),
              last_error: null,
              opportunistic_enabled: true,
              paused_at: null,
              paused_by: null,
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const est = await state.estimateBacklog(1, "story");
    expect(est.bucket).toBe("synced");
  });

  it("estimateBacklog returns 'synced' for fresh cursor and empty queue", async () => {
    fake.setResponse((sql) => {
      if (sql.includes("FROM aimer_push_queue")) {
        return { rows: [{ count: "0" }], rowCount: 1 };
      }
      if (sql.includes("FROM aimer_push_state")) {
        return {
          rows: [
            {
              kind: "baseline_event",
              last_pushed_event_time: new Date(Date.now() - 60 * 1000),
              last_pushed_event_key: "9",
              last_synced_at: new Date(),
              last_error: null,
              opportunistic_enabled: true,
              paused_at: null,
              paused_by: null,
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const est = await state.estimateBacklog(1, "baseline_event");
    expect(est.bucket).toBe("synced");
  });

  it("estimateBacklog('baseline_event') runs a fast-path COUNT over baseline_triaged_event past the cursor", async () => {
    fake.setResponse((sql) => {
      if (sql.includes("FROM aimer_push_queue")) {
        return { rows: [{ count: "0" }], rowCount: 1 };
      }
      if (sql.includes("FROM aimer_push_state")) {
        return {
          rows: [
            {
              kind: "baseline_event",
              last_pushed_event_time: new Date("2026-05-10T00:00:00Z"),
              last_pushed_event_key: "100",
              last_synced_at: new Date(),
              last_error: null,
              opportunistic_enabled: true,
              paused_at: null,
              paused_by: null,
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes("FROM baseline_triaged_event")) {
        return {
          rows: [
            {
              count: "237",
              newest_unsent_event_time: "2026-05-10T01:23:45Z",
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const est = await state.estimateBacklog(1, "baseline_event");
    expect(est.approximate_count).toBe(200); // rounded to nearest 100
    expect(est.newest_unsent_event_time).toBe("2026-05-10T01:23:45Z");
    const fastPath = fake.calls.find((c) =>
      c.sql.includes("FROM baseline_triaged_event"),
    );
    expect(fastPath?.sql).toContain("(event_time, event_key)");
    expect(fastPath?.sql).toContain("LIMIT $3");
    expect(fastPath?.params?.[2]).toBe(state.BACKLOG_APPROXIMATE_COUNT_LIMIT);
  });

  it("estimateBacklog('baseline_event') saturates approximate_count at the LIMIT cap (≥1000 → 1000)", async () => {
    fake.setResponse((sql) => {
      if (sql.includes("FROM aimer_push_queue")) {
        return { rows: [{ count: "0" }], rowCount: 1 };
      }
      if (sql.includes("FROM aimer_push_state")) {
        return {
          rows: [
            {
              kind: "baseline_event",
              last_pushed_event_time: new Date("2026-05-10T00:00:00Z"),
              last_pushed_event_key: "100",
              last_synced_at: new Date(),
              last_error: null,
              opportunistic_enabled: true,
              paused_at: null,
              paused_by: null,
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes("FROM baseline_triaged_event")) {
        return {
          rows: [
            {
              count: String(state.BACKLOG_APPROXIMATE_COUNT_LIMIT),
              newest_unsent_event_time: "2026-05-10T05:00:00Z",
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const est = await state.estimateBacklog(1, "baseline_event");
    expect(est.approximate_count).toBe(
      state.BACKLOG_APPROXIMATE_COUNT_LIMIT - 1,
    );
    // Saturated source count escalates the bucket regardless of cursor lag.
    expect(est.bucket).toBe("way_behind");
  });

  it("estimateBacklog('baseline_event') tolerates a missing source table by returning null counts", async () => {
    fake.setResponse((sql) => {
      if (sql.includes("FROM aimer_push_queue")) {
        return { rows: [{ count: "0" }], rowCount: 1 };
      }
      if (sql.includes("FROM aimer_push_state")) {
        return {
          rows: [
            {
              kind: "baseline_event",
              last_pushed_event_time: new Date("2026-05-10T00:00:00Z"),
              last_pushed_event_key: "100",
              last_synced_at: new Date(),
              last_error: null,
              opportunistic_enabled: true,
              paused_at: null,
              paused_by: null,
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes("FROM baseline_triaged_event")) {
        throw new Error('relation "baseline_triaged_event" does not exist');
      }
      return { rows: [], rowCount: 0 };
    });
    const est = await state.estimateBacklog(1, "baseline_event");
    expect(est.approximate_count).toBeNull();
    expect(est.newest_unsent_event_time).toBeNull();
  });

  // ── Type sanity ──────────────────────────────────────────────

  it("AimerPushQueueRow id is a string (BIGSERIAL — no JS bigint truncation)", () => {
    // Compile-time check; runtime asserts via a structurally-typed
    // assignment so the test fails if the type ever drifts.
    const row: AimerPushQueueRow = {
      id: "9007199254740993",
      enqueued_at: new Date(),
      kind: "withdraw_policy_event",
      payload: {},
      attempts: 0,
      last_attempt_at: null,
      last_error: null,
      acked_at: null,
      acked_context_jti: null,
    };
    expect(typeof row.id).toBe("string");
  });
});
