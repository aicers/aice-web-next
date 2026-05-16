import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface FakeQueryCall {
  sql: string;
  params: unknown[] | undefined;
}

const fakeClientCalls: FakeQueryCall[] = [];
const fakeClient = {
  query: vi.fn(async (sql: string, params?: unknown[]) => {
    fakeClientCalls.push({ sql, params });
    // Return one row for INSERT, empty for SELECTs.
    if (sql.includes("INSERT INTO aimer_push_queue")) {
      return { rows: [{ id: "42" }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }),
  release: vi.fn(),
};

const fakePool = {
  connect: vi.fn(async () => fakeClient),
};

vi.mock("@/lib/triage/policy/customer-db", () => ({
  getCustomerPool: vi.fn(async () => fakePool),
}));

const loadBaselineRefreshRowsMock = vi.hoisted(() => vi.fn());
const loadStoryRefreshRowsMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/aimer/phase2/payload-builders", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/aimer/phase2/payload-builders")
    >();
  return {
    ...actual,
    loadBaselineRefreshRows: loadBaselineRefreshRowsMock,
    loadStoryRefreshRows: loadStoryRefreshRowsMock,
  };
});

beforeEach(() => {
  fakeClientCalls.length = 0;
  fakeClient.query.mockClear();
  fakeClient.release.mockClear();
  fakePool.connect.mockClear();
  loadBaselineRefreshRowsMock.mockReset();
  loadStoryRefreshRowsMock.mockReset();
});

describe("runPhase2Backfill", () => {
  it("enqueues backfill_baseline_window notices inside one transaction", async () => {
    loadBaselineRefreshRowsMock.mockResolvedValue({
      events: [
        {
          event_key: "1",
          event_time: "2026-01-01T00:00:00.000Z",
          kind: "http",
        },
      ],
      baselineVersion: "v1",
      baselineVersions: ["v1"],
    });
    const { runPhase2Backfill } = await import("@/lib/aimer/phase2/backfill");

    const result = await runPhase2Backfill({
      customerId: 7,
      kind: "baseline_event",
      fromIso: "2026-01-01T00:00:00Z",
      toIso: "2026-01-02T00:00:00Z",
    });

    // BEGIN at the start, COMMIT at the end — one txn for all
    // enqueues so the request is atomically all-or-nothing.
    const sqls = fakeClientCalls.map((c) => c.sql);
    expect(sqls[0]).toBe("BEGIN");
    expect(sqls[sqls.length - 1]).toBe("COMMIT");
    const inserts = fakeClientCalls.filter((c) =>
      c.sql.includes("INSERT INTO aimer_push_queue"),
    );
    expect(inserts).toHaveLength(1);
    // Discriminator must be the backfill kind, NOT refresh.
    expect(inserts[0].params?.[0]).toBe("backfill_baseline_window");
    expect(result.enqueuedNoticeIds).toEqual(["42"]);
  });

  it("falls back to PHASE_1B_BASELINE_VERSION on an empty baseline backfill window", async () => {
    // Reviewer Round 2 P3: passing `baseline_version: ""` to the empty
    // notice would fail `phase2.refresh_window.v1` / `phase2.backfill.v1`
    // (nonEmptyString). The backfill path must seed the active version
    // constant so the empty notice is still schema-valid.
    loadBaselineRefreshRowsMock.mockResolvedValue({
      events: [],
      baselineVersion: null,
      baselineVersions: [],
    });
    const { runPhase2Backfill } = await import("@/lib/aimer/phase2/backfill");
    const { PHASE_1B_BASELINE_VERSION } = await import(
      "@/lib/triage/baseline/cadence"
    );

    await runPhase2Backfill({
      customerId: 7,
      kind: "baseline_event",
      fromIso: "2026-01-01T00:00:00Z",
      toIso: "2026-01-02T00:00:00Z",
    });

    const inserts = fakeClientCalls.filter((c) =>
      c.sql.includes("INSERT INTO aimer_push_queue"),
    );
    expect(inserts).toHaveLength(1);
    // state.ts INSERTs `[kind, JSON.stringify(payload)]`, so the
    // payload is the second positional param as a JSON string.
    const payload = JSON.parse(inserts[0].params?.[1] as string) as {
      baseline_version: string;
      events: unknown[];
    };
    expect(payload.events).toEqual([]);
    expect(payload.baseline_version).toBe(PHASE_1B_BASELINE_VERSION);
    expect(payload.baseline_version.length).toBeGreaterThan(0);
  });

  it("uses the story kind discriminator for story backfill", async () => {
    loadStoryRefreshRowsMock.mockResolvedValue([]);
    const { runPhase2Backfill } = await import("@/lib/aimer/phase2/backfill");

    const result = await runPhase2Backfill({
      customerId: 7,
      kind: "story",
      fromIso: "2026-01-01T00:00:00Z",
      toIso: "2026-01-02T00:00:00Z",
    });

    const inserts = fakeClientCalls.filter((c) =>
      c.sql.includes("INSERT INTO aimer_push_queue"),
    );
    expect(inserts).toHaveLength(1);
    expect(inserts[0].params?.[0]).toBe("backfill_story_window");
    expect(result.enqueuedNoticeIds).toEqual(["42"]);
  });

  it("rejects a baseline backfill whose window spans multiple baseline_versions", async () => {
    loadBaselineRefreshRowsMock.mockResolvedValue({
      events: [
        {
          event_key: "1",
          event_time: "2026-01-01T00:00:00.000Z",
          kind: "http",
          baseline_version: "v1",
        },
        {
          event_key: "2",
          event_time: "2026-01-01T00:01:00.000Z",
          kind: "http",
          baseline_version: "v2",
        },
      ],
      baselineVersion: "v1",
      baselineVersions: ["v1", "v2"],
    });
    const { runPhase2Backfill, Phase2BackfillMultiVersionError } = await import(
      "@/lib/aimer/phase2/backfill"
    );
    await expect(
      runPhase2Backfill({
        customerId: 7,
        kind: "baseline_event",
        fromIso: "2026-01-01T00:00:00Z",
        toIso: "2026-01-02T00:00:00Z",
      }),
    ).rejects.toBeInstanceOf(Phase2BackfillMultiVersionError);
    // No queue rows enqueued; the txn rolled back.
    const inserts = fakeClientCalls.filter((c) =>
      c.sql.includes("INSERT INTO aimer_push_queue"),
    );
    expect(inserts).toHaveLength(0);
    const sqls = fakeClient.query.mock.calls.map((c) => c[0] as string);
    expect(sqls).toContain("ROLLBACK");
    expect(sqls).not.toContain("COMMIT");
  });

  it("rolls back the transaction on DB error during enqueue", async () => {
    loadBaselineRefreshRowsMock.mockResolvedValue({
      events: [
        {
          event_key: "1",
          event_time: "2026-01-01T00:00:00.000Z",
          kind: "http",
        },
      ],
      baselineVersion: "v1",
      baselineVersions: ["v1"],
    });
    // Make the INSERT throw on the queue insert specifically.
    fakeClient.query.mockImplementation(async (sql: string) => {
      if (sql.includes("INSERT INTO aimer_push_queue")) {
        throw new Error("insert failed");
      }
      return { rows: [], rowCount: 0 };
    });

    const { runPhase2Backfill } = await import("@/lib/aimer/phase2/backfill");

    await expect(
      runPhase2Backfill({
        customerId: 7,
        kind: "baseline_event",
        fromIso: "2026-01-01T00:00:00Z",
        toIso: "2026-01-02T00:00:00Z",
      }),
    ).rejects.toThrow("insert failed");

    const sqls = fakeClient.query.mock.calls.map((c) => c[0] as string);
    expect(sqls).toContain("BEGIN");
    expect(sqls).toContain("ROLLBACK");
    expect(sqls).not.toContain("COMMIT");
  });
});

describe("verifyPhase2BackfillToken", () => {
  const ORIGINAL_ENV = process.env.AIMER_PHASE2_BACKFILL_INTERNAL_TOKEN;

  beforeEach(() => {
    delete process.env.AIMER_PHASE2_BACKFILL_INTERNAL_TOKEN;
  });

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env.AIMER_PHASE2_BACKFILL_INTERNAL_TOKEN;
    } else {
      process.env.AIMER_PHASE2_BACKFILL_INTERNAL_TOKEN = ORIGINAL_ENV;
    }
  });

  it("refuses every request when the env var is unset", async () => {
    const { verifyPhase2BackfillToken } = await import(
      "@/lib/aimer/phase2/backfill"
    );
    expect(verifyPhase2BackfillToken("any")).toBe(false);
    expect(verifyPhase2BackfillToken(null)).toBe(false);
  });

  it("accepts a matching token via constant-time compare", async () => {
    process.env.AIMER_PHASE2_BACKFILL_INTERNAL_TOKEN = "right-token";
    const { verifyPhase2BackfillToken } = await import(
      "@/lib/aimer/phase2/backfill"
    );
    expect(verifyPhase2BackfillToken("right-token")).toBe(true);
    expect(verifyPhase2BackfillToken("wrong-token")).toBe(false);
    expect(verifyPhase2BackfillToken(null)).toBe(false);
  });
});
