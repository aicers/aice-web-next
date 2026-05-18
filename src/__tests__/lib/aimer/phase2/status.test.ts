import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AimerPushStateRow,
  BacklogEstimate,
  Phase2StreamingKind,
} from "@/lib/aimer/phase2/state";

/**
 * Tests for the Phase 2 status DTO builders (#620).
 *
 * The per-customer builder (`buildPhase2StatusDto`) and the
 * cross-customer summary builder (`buildPhase2StatusSummary`) drive
 * the Settings status block and the app-shell login banner; both
 * routes are gated separately, so these tests focus on the
 * data-shape transforms and the summary's caching + concurrency
 * behavior.
 */

interface FakeQueryCall {
  sql: string;
  params: unknown[] | undefined;
}

function makeFakePool() {
  const calls: FakeQueryCall[] = [];
  let router: (sql: string) => { rows: unknown[]; rowCount: number } = () => ({
    rows: [],
    rowCount: 0,
  });
  return {
    pool: {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        return router(sql);
      }),
    },
    calls,
    setRouter(
      fn: (sql: string) => { rows: unknown[]; rowCount: number },
    ): void {
      router = fn;
    },
  };
}

const fake = makeFakePool();
const mockGetCustomerPool = vi.hoisted(() => vi.fn());
vi.mock("@/lib/triage/policy/customer-db", () => ({
  getCustomerPool: mockGetCustomerPool,
}));

const mockEstimate = vi.hoisted(() => vi.fn());
const mockGetState = vi.hoisted(() => vi.fn());
vi.mock("@/lib/aimer/phase2/state", () => ({
  estimateBacklog: mockEstimate,
  getAimerPushState: mockGetState,
}));

const mockAppQuery = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db/client", () => ({
  query: mockAppQuery,
}));

function emptyEstimate(
  bucket: BacklogEstimate["bucket"] = "synced",
  overrides: Partial<BacklogEstimate> = {},
): BacklogEstimate {
  return {
    bucket,
    approximate_count: null,
    cursor_lag_seconds: null,
    newest_unsent_event_time: null,
    pending_notice_count: 0,
    ...overrides,
  };
}

function stateRow(
  kind: Phase2StreamingKind,
  overrides: Partial<AimerPushStateRow> = {},
): AimerPushStateRow {
  return {
    kind,
    last_pushed_event_time: null,
    last_pushed_event_key: null,
    last_synced_at: null,
    last_error: null,
    opportunistic_enabled: true,
    paused_at: null,
    paused_by: null,
    streaming_activated_at: null,
    ...overrides,
  };
}

describe("buildPhase2StatusDto", () => {
  beforeEach(() => {
    fake.calls.length = 0;
    fake.pool.query.mockClear();
    mockEstimate.mockReset();
    mockGetState.mockReset();
    mockGetCustomerPool.mockReset().mockResolvedValue(fake.pool);
    // Default: no policy run, no queue error.
    fake.setRouter(() => ({ rows: [], rowCount: 0 }));
    mockAppQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("assembles a three-track DTO with both streaming kinds, policy_run, and policy_event", async () => {
    mockEstimate.mockImplementation(
      async (
        _id: number,
        kind: "baseline_event" | "story" | "policy_event",
      ) => {
        if (kind === "baseline_event") {
          return emptyEstimate("behind", {
            approximate_count: 25,
            cursor_lag_seconds: 600,
            pending_notice_count: 4,
          });
        }
        if (kind === "story") {
          return emptyEstimate("synced", { cursor_lag_seconds: 30 });
        }
        return emptyEstimate("synced", { pending_notice_count: 0 });
      },
    );
    mockGetState.mockImplementation(
      async (_id: number, kind: Phase2StreamingKind) =>
        stateRow(kind, {
          last_synced_at: new Date("2026-05-18T10:00:00Z"),
          last_error: kind === "baseline_event" ? "boom" : null,
        }),
    );

    const { buildPhase2StatusDto } = await import("@/lib/aimer/phase2/status");
    const dto = await buildPhase2StatusDto(42);

    expect(dto.customer_id).toBe(42);
    expect(dto.streaming.map((s) => s.kind)).toEqual([
      "baseline_event",
      "story",
    ]);
    const baseline = dto.streaming[0];
    expect(baseline.bucket).toBe("behind");
    expect(baseline.approximate_count).toBe(25);
    expect(baseline.cursor_lag_seconds).toBe(600);
    expect(baseline.pending_notice_count).toBe(4);
    expect(baseline.opportunistic_enabled).toBe(true);
    expect(baseline.last_error).toBe("boom");
    expect(baseline.last_synced_at).toBe("2026-05-18T10:00:00.000Z");

    expect(dto.policy_run.kind).toBe("policy_run");
    expect(dto.policy_run.total_runs_sent).toBe(0);
    expect(dto.policy_run.last_sent_at).toBeNull();

    expect(dto.policy_event.kind).toBe("policy_event");
    expect(dto.policy_event.pending_notice_count).toBe(0);
    expect(dto.policy_event.last_error).toBeNull();
  });

  it("defaults opportunistic_enabled to true when no state row exists", async () => {
    mockEstimate.mockResolvedValue(emptyEstimate("synced"));
    mockGetState.mockResolvedValue(null);
    const { buildPhase2StatusDto } = await import("@/lib/aimer/phase2/status");
    const dto = await buildPhase2StatusDto(7);
    for (const track of dto.streaming) {
      expect(track.opportunistic_enabled).toBe(true);
      expect(track.paused_at).toBeNull();
      expect(track.paused_by).toBeNull();
      expect(track.last_synced_at).toBeNull();
    }
  });

  it("threads policy_triage_run β columns and totalRunsSent into the policy_run track", async () => {
    mockEstimate.mockResolvedValue(emptyEstimate("synced"));
    mockGetState.mockResolvedValue(null);
    fake.setRouter((sql) => {
      if (sql.includes("ORDER BY last_sent_at DESC")) {
        return {
          rows: [
            {
              id: "run-abc",
              last_sent_at: new Date("2026-05-18T09:00:00Z"),
              last_sent_by: "operator-1",
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes("SELECT COUNT(*)::text AS count")) {
        return { rows: [{ count: "7" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const { buildPhase2StatusDto } = await import("@/lib/aimer/phase2/status");
    const dto = await buildPhase2StatusDto(11);
    expect(dto.policy_run).toEqual({
      kind: "policy_run",
      last_sent_run_id: "run-abc",
      last_sent_at: "2026-05-18T09:00:00.000Z",
      last_sent_by: "operator-1",
      total_runs_sent: 7,
    });
  });

  it("returns null policy_run + 0 totalRunsSent when the customer DB throws", async () => {
    mockEstimate.mockResolvedValue(emptyEstimate("synced"));
    mockGetState.mockResolvedValue(null);
    fake.setRouter(() => {
      throw new Error("planner timeout");
    });
    const { buildPhase2StatusDto } = await import("@/lib/aimer/phase2/status");
    const dto = await buildPhase2StatusDto(12);
    expect(dto.policy_run.last_sent_run_id).toBeNull();
    expect(dto.policy_run.total_runs_sent).toBe(0);
    // policy_event also fails-soft to null last_error.
    expect(dto.policy_event.last_error).toBeNull();
  });

  it("resolves paused_by UUIDs against accounts.display_name in the app DB", async () => {
    // Round 4 review: the customer DB stores `paused_by` as an account
    // UUID, but operators want the human-readable name in the pause
    // badge. The DTO builder must batch-resolve those UUIDs and fall
    // back to the raw UUID only when the account row is gone.
    mockEstimate.mockResolvedValue(emptyEstimate("paused"));
    mockGetState.mockImplementation(
      async (_id: number, kind: Phase2StreamingKind) =>
        stateRow(kind, {
          opportunistic_enabled: false,
          paused_at: new Date("2026-05-18T09:00:00Z"),
          paused_by:
            kind === "baseline_event"
              ? "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
              : "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        }),
    );
    mockAppQuery.mockResolvedValue({
      rows: [
        {
          id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
          display_name: "alice",
        },
        // The story row's account has been deleted — no row returned
        // for that UUID, so the renderer should fall back to the UUID.
      ],
      rowCount: 1,
    });
    const { buildPhase2StatusDto } = await import("@/lib/aimer/phase2/status");
    const dto = await buildPhase2StatusDto(77);
    const baseline = dto.streaming.find((s) => s.kind === "baseline_event");
    const story = dto.streaming.find((s) => s.kind === "story");
    expect(baseline?.paused_by).toBe("alice");
    expect(story?.paused_by).toBe("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
    // Exactly one batched lookup, both UUIDs in the parameter list.
    expect(mockAppQuery).toHaveBeenCalledTimes(1);
    const params = mockAppQuery.mock.calls[0][1] as string[][];
    expect(new Set(params[0])).toEqual(
      new Set([
        "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      ]),
    );
  });

  it("does not query accounts when no streaming kind is paused", async () => {
    mockEstimate.mockResolvedValue(emptyEstimate("synced"));
    mockGetState.mockResolvedValue(null);
    const { buildPhase2StatusDto } = await import("@/lib/aimer/phase2/status");
    await buildPhase2StatusDto(78);
    expect(mockAppQuery).not.toHaveBeenCalled();
  });

  it("falls back to the raw UUID when the accounts lookup fails", async () => {
    mockEstimate.mockResolvedValue(emptyEstimate("paused"));
    mockGetState.mockImplementation(
      async (_id: number, kind: Phase2StreamingKind) =>
        stateRow(kind, {
          opportunistic_enabled: false,
          paused_at: new Date("2026-05-18T09:00:00Z"),
          paused_by: "cccccccc-cccc-cccc-cccc-cccccccccccc",
        }),
    );
    mockAppQuery.mockRejectedValue(new Error("planner timeout"));
    const { buildPhase2StatusDto } = await import("@/lib/aimer/phase2/status");
    const dto = await buildPhase2StatusDto(79);
    for (const track of dto.streaming) {
      expect(track.paused_by).toBe("cccccccc-cccc-cccc-cccc-cccccccccccc");
    }
  });

  it("surfaces the latest withdraw_policy_event last_error onto the policy_event track", async () => {
    mockEstimate.mockImplementation(
      async (_id: number, kind: "baseline_event" | "story" | "policy_event") =>
        kind === "policy_event"
          ? emptyEstimate("behind", { pending_notice_count: 12 })
          : emptyEstimate("synced"),
    );
    mockGetState.mockResolvedValue(null);
    fake.setRouter((sql) => {
      if (sql.includes("FROM aimer_push_queue")) {
        return { rows: [{ last_error: "503 upstream" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const { buildPhase2StatusDto } = await import("@/lib/aimer/phase2/status");
    const dto = await buildPhase2StatusDto(31);
    expect(dto.policy_event.pending_notice_count).toBe(12);
    expect(dto.policy_event.last_error).toBe("503 upstream");
  });
});

describe("buildPhase2StatusSummary", () => {
  beforeEach(async () => {
    fake.calls.length = 0;
    fake.pool.query.mockClear();
    mockEstimate.mockReset();
    mockGetState.mockReset();
    mockGetCustomerPool.mockReset().mockResolvedValue(fake.pool);
    fake.setRouter(() => ({ rows: [], rowCount: 0 }));
    const mod = await import("@/lib/aimer/phase2/status");
    mod.__resetPhase2SummaryCacheForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns an empty customer list when no tenant is flagged", async () => {
    fake.setRouter(() => ({ rows: [], rowCount: 0 }));
    const { buildPhase2StatusSummary } = await import(
      "@/lib/aimer/phase2/status"
    );
    const dto = await buildPhase2StatusSummary([1, 2, 3]);
    expect(dto.customers).toEqual([]);
  });

  it("short-circuits when given an empty customer-id list", async () => {
    const { buildPhase2StatusSummary } = await import(
      "@/lib/aimer/phase2/status"
    );
    const dto = await buildPhase2StatusSummary([]);
    expect(dto).toEqual({ customers: [] });
    expect(fake.pool.query).not.toHaveBeenCalled();
  });

  it("flags paused streaming kinds with bucket=paused", async () => {
    fake.setRouter((sql) => {
      if (sql.includes("FROM aimer_push_state")) {
        return {
          rows: [
            {
              kind: "baseline_event",
              last_pushed_event_time: null,
              opportunistic_enabled: false,
            },
            {
              kind: "story",
              last_pushed_event_time: null,
              opportunistic_enabled: true,
            },
          ],
          rowCount: 2,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const { buildPhase2StatusSummary } = await import(
      "@/lib/aimer/phase2/status"
    );
    const dto = await buildPhase2StatusSummary([99]);
    expect(dto.customers).toHaveLength(1);
    expect(dto.customers[0]).toEqual({
      customer_id: 99,
      worst_bucket: "paused",
      kinds: ["baseline_event"],
      paused_kinds: ["baseline_event"],
    });
  });

  it("preserves pause info when pause is not the worst bucket", async () => {
    // Mixed-state customer: baseline paused (less severe) AND
    // policy_event way behind (more severe). `worst_bucket` collapses
    // to "way_behind" but `paused_kinds` keeps the pause signal so the
    // banner can still show a "paused kinds" marker.
    fake.setRouter((sql) => {
      if (sql.includes("FROM aimer_push_state")) {
        return {
          rows: [
            {
              kind: "baseline_event",
              last_pushed_event_time: null,
              opportunistic_enabled: false,
            },
            {
              kind: "story",
              last_pushed_event_time: null,
              opportunistic_enabled: true,
            },
          ],
          rowCount: 2,
        };
      }
      if (sql.includes("FROM aimer_push_queue")) {
        return {
          rows: [{ kind: "withdraw_policy_event", pending: "150" }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const { buildPhase2StatusSummary } = await import(
      "@/lib/aimer/phase2/status"
    );
    const dto = await buildPhase2StatusSummary([55]);
    expect(dto.customers).toHaveLength(1);
    expect(dto.customers[0].worst_bucket).toBe("way_behind");
    expect(dto.customers[0].kinds).toEqual(["baseline_event", "policy_event"]);
    expect(dto.customers[0].paused_kinds).toEqual(["baseline_event"]);
  });

  it("chooses the worst bucket across contributing kinds", async () => {
    fake.setRouter((sql) => {
      if (sql.includes("FROM aimer_push_state")) {
        return {
          rows: [
            {
              kind: "baseline_event",
              // 10 minutes old → behind by lag.
              last_pushed_event_time: new Date(Date.now() - 10 * 60_000),
              opportunistic_enabled: true,
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes("FROM aimer_push_queue")) {
        return {
          rows: [{ kind: "withdraw_policy_event", pending: "150" }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const { buildPhase2StatusSummary } = await import(
      "@/lib/aimer/phase2/status"
    );
    const dto = await buildPhase2StatusSummary([7]);
    expect(dto.customers).toHaveLength(1);
    expect(dto.customers[0].worst_bucket).toBe("way_behind");
    expect(dto.customers[0].kinds).toEqual(["baseline_event", "policy_event"]);
  });

  it("memoises identical customer-id lists for the TTL window", async () => {
    fake.setRouter((sql) => {
      if (sql.includes("FROM aimer_push_state")) {
        return {
          rows: [
            {
              kind: "baseline_event",
              last_pushed_event_time: null,
              opportunistic_enabled: false,
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const { buildPhase2StatusSummary } = await import(
      "@/lib/aimer/phase2/status"
    );
    await buildPhase2StatusSummary([5]);
    const callsAfterFirst = fake.pool.query.mock.calls.length;
    await buildPhase2StatusSummary([5]);
    expect(fake.pool.query.mock.calls.length).toBe(callsAfterFirst);
  });

  it("de-duplicates concurrent fetches for the same customer-id key", async () => {
    fake.setRouter(() => ({ rows: [], rowCount: 0 }));
    const { buildPhase2StatusSummary } = await import(
      "@/lib/aimer/phase2/status"
    );
    const [r1, r2] = await Promise.all([
      buildPhase2StatusSummary([13, 14]),
      buildPhase2StatusSummary([13, 14]),
    ]);
    // The second call observes the inflight promise from the first and
    // does not double the DB work.
    expect(r1).toBe(r2);
    // 2 customers * 2 queries (state + queue) = 4 query calls, not 8.
    expect(fake.pool.query.mock.calls.length).toBe(4);
  });

  it("skips customers whose pool throws so a single bad tenant does not 500 the global banner", async () => {
    mockGetCustomerPool.mockReset();
    mockGetCustomerPool.mockImplementation(async (id: number) => {
      if (id === 1) throw new Error("pool boot failed");
      return fake.pool;
    });
    fake.setRouter((sql) => {
      if (sql.includes("FROM aimer_push_state")) {
        return {
          rows: [
            {
              kind: "baseline_event",
              last_pushed_event_time: null,
              opportunistic_enabled: false,
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const { buildPhase2StatusSummary } = await import(
      "@/lib/aimer/phase2/status"
    );
    const dto = await buildPhase2StatusSummary([1, 2]);
    expect(dto.customers).toHaveLength(1);
    expect(dto.customers[0].customer_id).toBe(2);
  });
});
