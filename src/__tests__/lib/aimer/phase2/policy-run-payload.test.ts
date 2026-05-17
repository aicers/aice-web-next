import { describe, expect, it } from "vitest";

import {
  buildPolicyRunSlice,
  loadPolicyRunForSend,
  type PolicyRunWireBody,
  unwrapPolicyTriageSnapshot,
} from "@/lib/aimer/phase2/policy-run-payload";

// ── Fake PG client ───────────────────────────────────────────────

type FakeQuery = (
  sql: string,
  params: unknown[],
) => Promise<{ rows: unknown[] }>;

function fakeClient(query: FakeQuery): {
  query: <R = unknown>(
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: R[] }>;
  release: () => void;
} {
  return {
    query: (async (sql: string, params: unknown[] = []) => {
      return query(sql, params);
    }) as unknown as <R = unknown>(
      sql: string,
      params?: unknown[],
    ) => Promise<{ rows: R[] }>,
    release: () => {},
  };
}

const READY_RUN_ROW = {
  id: "1234",
  owner_account_id: "11111111-2222-3333-4444-555555555555",
  period_start: "2026-05-01T00:00:00.000Z",
  period_end: "2026-05-08T00:00:00.000Z",
  created_at: "2026-05-10T00:00:00.000Z",
  finalized_at: "2026-05-10T00:01:33.000Z",
  baseline_version: "1.B.0",
  policies_fingerprint: "abc123",
  exclusions_fingerprint: "def456",
  status: "ready" as const,
  replaces: null,
  total_events: "2",
  kinds_represented: "1",
};

const RUN_BODY: PolicyRunWireBody = {
  run_id: "1234",
  owner_account_id: "11111111-2222-3333-4444-555555555555",
  period_start: "2026-05-01T00:00:00.000Z",
  period_end: "2026-05-08T00:00:00.000Z",
  created_at: "2026-05-10T00:00:00.000Z",
  finalized_at: "2026-05-10T00:01:33.000Z",
  baseline_version: "1.B.0",
  policies_fingerprint: "abc123",
  exclusions_fingerprint: "def456",
  status: "ready",
  summary_stats: { total_events: 2, kinds_represented: 1 },
};

function eventRow(overrides: Record<string, unknown> = {}) {
  return {
    event_key: "1",
    event_time: "2026-05-05T00:00:00.000Z",
    kind: "HttpThreat",
    sensor: "edge1",
    orig_addr: "10.0.0.1",
    orig_port: 1234,
    resp_addr: "10.0.0.2",
    resp_port: 80,
    proto: 6,
    host: null,
    dns_query: null,
    uri: "/foo",
    category: "cat",
    policy_triage_snapshot: { scores: [{ policyId: 7, score: 0.5 }] },
    ...overrides,
  };
}

// ── unwrapPolicyTriageSnapshot ────────────────────────────────────

describe("unwrapPolicyTriageSnapshot", () => {
  it("unwraps the canonical { scores: [...] } object form", () => {
    const out = unwrapPolicyTriageSnapshot({
      scores: [{ policyId: 7, score: 0.5 }],
    });
    expect(out).toEqual([{ policyId: 7, score: 0.5 }]);
  });

  it("passes through a legacy flat array", () => {
    const arr = [{ policyId: 8, score: 0.1 }];
    expect(unwrapPolicyTriageSnapshot(arr)).toEqual(arr);
  });

  it("an empty scores list becomes an empty array (not an empty object)", () => {
    expect(unwrapPolicyTriageSnapshot({ scores: [] })).toEqual([]);
  });

  it("an unrecognised shape becomes an empty array", () => {
    expect(unwrapPolicyTriageSnapshot({})).toEqual([]);
    expect(unwrapPolicyTriageSnapshot(null)).toEqual([]);
    expect(unwrapPolicyTriageSnapshot("nope")).toEqual([]);
  });
});

// ── loadPolicyRunForSend ──────────────────────────────────────────

describe("loadPolicyRunForSend", () => {
  it("returns the wire body for a ready run", async () => {
    const client = fakeClient(async () => ({ rows: [READY_RUN_ROW] }));
    const body = await loadPolicyRunForSend(client as never, "1234");
    expect(body).toEqual(RUN_BODY);
  });

  it("includes replaces when set", async () => {
    const client = fakeClient(async () => ({
      rows: [{ ...READY_RUN_ROW, status: "superseded", replaces: "1233" }],
    }));
    const body = await loadPolicyRunForSend(client as never, "1234");
    expect(body.status).toBe("superseded");
    expect(body.replaces).toBe("1233");
  });

  it("throws run_not_found when the run does not exist", async () => {
    const client = fakeClient(async () => ({ rows: [] }));
    await expect(
      loadPolicyRunForSend(client as never, "9999"),
    ).rejects.toMatchObject({ code: "run_not_found" });
  });

  it("rejects computing runs", async () => {
    const client = fakeClient(async () => ({
      rows: [{ ...READY_RUN_ROW, status: "computing" }],
    }));
    await expect(
      loadPolicyRunForSend(client as never, "1234"),
    ).rejects.toMatchObject({ code: "run_not_eligible", status: "computing" });
  });

  it("rejects failed runs", async () => {
    const client = fakeClient(async () => ({
      rows: [{ ...READY_RUN_ROW, status: "failed" }],
    }));
    await expect(
      loadPolicyRunForSend(client as never, "1234"),
    ).rejects.toMatchObject({ code: "run_not_eligible", status: "failed" });
  });
});

// ── buildPolicyRunSlice ───────────────────────────────────────────

describe("buildPolicyRunSlice", () => {
  it("produces events: [] / has_more: false / lastEventKey: null for an empty run", async () => {
    const client = fakeClient(async () => ({ rows: [] }));
    const slice = await buildPolicyRunSlice(client as never, RUN_BODY, null);
    expect(slice.eventCount).toBe(0);
    expect(slice.payload.events).toEqual([]);
    expect(slice.hasMore).toBe(false);
    expect(slice.lastEventKey).toBeNull();
  });

  it("returns all rows when within budget and reports has_more=false", async () => {
    const rows = [eventRow({ event_key: "1" }), eventRow({ event_key: "2" })];
    const client = fakeClient(async () => ({ rows }));
    const slice = await buildPolicyRunSlice(client as never, RUN_BODY, null);
    expect(slice.eventCount).toBe(2);
    expect(slice.hasMore).toBe(false);
    expect(slice.lastEventKey).toBe("2");
    // Snapshot unwrapped on the wire
    expect(slice.payload.events[0].policy_triage_snapshot).toEqual([
      { policyId: 7, score: 0.5 },
    ]);
  });

  it("splits when projected payload exceeds the maxBytes budget", async () => {
    const rows = [
      eventRow({ event_key: "1" }),
      eventRow({ event_key: "2" }),
      eventRow({ event_key: "3" }),
    ];
    const client = fakeClient(async () => ({ rows }));
    // Very tight budget — should accept exactly one row and report has_more.
    const slice = await buildPolicyRunSlice(client as never, RUN_BODY, null, {
      maxBytes: 800,
    });
    expect(slice.eventCount).toBe(1);
    expect(slice.hasMore).toBe(true);
    expect(slice.lastEventKey).toBe("1");
  });

  it("passes the after_event_key cursor to the query", async () => {
    const seen: { sql: string; params: unknown[] }[] = [];
    const client = fakeClient(async (sql, params) => {
      seen.push({ sql, params });
      return { rows: [eventRow({ event_key: "5" })] };
    });
    await buildPolicyRunSlice(client as never, RUN_BODY, "4");
    expect(seen[0].params).toEqual(["1234", "4"]);
  });
});
