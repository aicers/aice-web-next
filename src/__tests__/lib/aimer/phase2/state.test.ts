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
      "(l.last_pushed_event_time, l.last_pushed_event_key)",
    );
    expect(call.params).toEqual([
      "baseline_event",
      new Date("2026-05-10T12:00:00Z"),
      "200",
    ]);
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
    expect(call.params).toEqual([
      "jti-1",
      "policy_event",
      null,
      null,
      ["10", "11"],
    ]);
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
    await state.commitOnAck(1, "jti-1");

    const sqls = fake.calls.map((c) => c.sql);
    // BEGIN, SELECT FOR UPDATE, UPDATE queue, DELETE inflight, COMMIT.
    expect(sqls[0]).toBe("BEGIN");
    expect(sqls[1]).toContain("FROM aimer_push_inflight");
    expect(sqls[1]).toContain("FOR UPDATE");
    const updateQueue = sqls.find((s) => s.includes("UPDATE aimer_push_queue"));
    expect(updateQueue).toBeDefined();
    expect(sqls.some((s) => s.includes("UPDATE aimer_push_state"))).toBe(false);
    expect(
      sqls.some((s) => s.startsWith("DELETE FROM aimer_push_inflight")),
    ).toBe(true);
    expect(sqls[sqls.length - 1]).toBe("COMMIT");
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
    await state.commitOnAck(1, "jti-2");

    const sqls = fake.calls.map((c) => c.sql);
    expect(sqls.some((s) => s.includes("UPDATE aimer_push_state"))).toBe(true);
    expect(sqls.some((s) => s.includes("FOR UPDATE"))).toBe(true);
  });

  it("commitOnAck on an unknown jti is a no-op", async () => {
    fake.setResponse(() => ({ rows: [], rowCount: 0 }));
    await state.commitOnAck(1, "unknown-jti");
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
    await state.recordOnFail(1, "jti-3", "aimer 500");

    const sqls = fake.calls.map((c) => c.sql);
    // For policy_event the helper must NOT touch aimer_push_state.
    expect(sqls.some((s) => s.includes("UPDATE aimer_push_state"))).toBe(false);
    expect(sqls.some((s) => s.includes("attempts        = attempts + 1"))).toBe(
      true,
    );
    expect(
      sqls.some((s) => s.startsWith("DELETE FROM aimer_push_inflight")),
    ).toBe(true);
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
    await state.recordOnFail(1, "jti-4", "boom");
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
