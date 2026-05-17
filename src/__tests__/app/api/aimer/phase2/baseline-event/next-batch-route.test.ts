import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthSession } from "@/lib/auth/jwt";

type HandlerFn = (
  request: NextRequest,
  context: unknown,
  session: AuthSession,
) => Promise<Response>;

// ── Mocks ───────────────────────────────────────────────────

let currentSession: AuthSession;
vi.mock("@/lib/auth/guard", () => ({
  withAuth: (handler: HandlerFn) => async (req: NextRequest, ctx: unknown) =>
    handler(req, ctx, currentSession),
}));

const mockHasPermission = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/permissions", () => ({
  hasPermission: mockHasPermission,
}));

const mockResolveScope = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/customer-scope", () => ({
  resolveEffectiveCustomerIds: mockResolveScope,
}));

const mockBuildPush = vi.hoisted(() => vi.fn());
vi.mock("@/lib/aimer/phase2/orchestrate", () => ({
  buildPhase2Push: mockBuildPush,
}));

const mockState = vi.hoisted(() => ({
  claimPendingNotices: vi.fn(),
  insertInflight: vi.fn(),
  commitOnAck: vi.fn(),
  recordOnFail: vi.fn(),
  pruneExpiredInflight: vi.fn(),
  getAimerPushState: vi.fn(),
  isOpportunisticEnabled: vi.fn(),
  enqueueNotice: vi.fn(),
}));
vi.mock("@/lib/aimer/phase2/state", () => mockState);

const mockGetSetup = vi.hoisted(() => vi.fn());
vi.mock("@/lib/aimer/setup-status", () => ({
  getAimerIntegrationSetup: mockGetSetup,
}));

const mockLoadSlice = vi.hoisted(() => vi.fn());
const mockEnrichRefreshPayload = vi.hoisted(() => vi.fn());
const mockHasStreamingRowsPastCursor = vi.hoisted(() => vi.fn());
vi.mock("@/lib/aimer/phase2/baseline-push", () => ({
  loadBaselineStreamingSlice: mockLoadSlice,
  enrichRefreshPayload: mockEnrichRefreshPayload,
  hasStreamingRowsPastCursor: mockHasStreamingRowsPastCursor,
}));

// ── Helpers ───────────────────────────────────────────────────

const now = Math.floor(Date.now() / 1000);

function makeSession(overrides: Partial<AuthSession> = {}): AuthSession {
  return {
    accountId: "account-1",
    sessionId: "session-1",
    roles: ["Tenant Administrator"],
    tokenVersion: 0,
    mustChangePassword: false,
    mustEnrollMfa: false,
    iat: now,
    exp: now + 900,
    sessionIp: "127.0.0.1",
    sessionUserAgent: "Mozilla/5.0",
    sessionBrowserFingerprint: "Mozilla/5.0",
    needsReauth: false,
    sessionCreatedAt: new Date(),
    sessionLastActiveAt: new Date(),
    ...overrides,
  };
}

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest(
    "http://localhost/api/aimer/phase2/baseline-event/next-batch",
    {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    },
  );
}

const ctx = { params: Promise.resolve({}) };

const EMPTY_SLICE = {
  events: [],
  lastEventTime: null,
  lastEventKey: null,
  hasMore: false,
  baselineVersion: null,
};

function makeStreamingEvent(
  overrides: Partial<{
    event_key: string;
    event_time: string;
  }> = {},
) {
  return {
    event_key: overrides.event_key ?? "100",
    event_time: overrides.event_time ?? "2026-01-01T00:00:00.000Z",
    kind: "HttpThreat",
    sensor: "s1",
    orig_addr: "10.0.0.1",
    orig_port: 443,
    resp_addr: "10.0.0.2",
    resp_port: 443,
    proto: 6,
    host: "example.com",
    dns_query: null,
    uri: "/x",
    category: "Suspicious",
    baseline_version: "phase1b-four-selector",
    exclusions_fp: "fp",
    raw_score: 0.7,
    selector_tags: ["S1-high"],
    payload_summary: {},
    raw_event: {},
    score_window_context: {
      kind_cohort_window: { from: "a", to: "b" },
      kind_cohort_size: 1,
      baseline_rank_snapshot: 0.5,
    },
    window_signals: {
      s1_percentile_rank: 0.5,
      s3_recurring_count: 0,
      s4_correlated_count: 0,
      s4_correlated_event_keys: [],
    },
    asset_context: {
      primary_asset: "10.0.0.1",
      peer_event_summary: { total_peer_count: 0, top_peer_kinds: [] },
    },
    scoring_weights_snapshot: {},
  };
}

// ── Suite ─────────────────────────────────────────────────────

describe("POST /api/aimer/phase2/baseline-event/next-batch", () => {
  beforeEach(() => {
    currentSession = makeSession();

    mockHasPermission.mockReset().mockImplementation(async (_roles, perm) => {
      if (perm === "customers:access-all") return false;
      return true;
    });
    mockResolveScope.mockReset().mockResolvedValue([42]);

    mockBuildPush.mockReset().mockResolvedValue({
      context_token: "ctx-jws",
      events_envelope: "env-jws",
      events_data: '{"events":[]}',
      context_jti: "jti-new",
    });

    mockState.claimPendingNotices.mockReset().mockResolvedValue([]);
    mockState.insertInflight.mockReset().mockResolvedValue(undefined);
    mockState.commitOnAck.mockReset().mockResolvedValue(undefined);
    mockState.recordOnFail.mockReset().mockResolvedValue(undefined);
    mockState.pruneExpiredInflight.mockReset().mockResolvedValue(0);
    mockState.getAimerPushState.mockReset().mockResolvedValue({
      kind: "baseline_event",
      last_pushed_event_time: null,
      last_pushed_event_key: null,
      last_synced_at: null,
      last_error: null,
      opportunistic_enabled: true,
      paused_at: null,
      paused_by: null,
    });
    mockState.isOpportunisticEnabled.mockReset().mockResolvedValue(true);
    mockState.enqueueNotice.mockReset().mockResolvedValue("999");

    mockGetSetup.mockReset().mockResolvedValue({
      aiceId: "aice.example.com",
      bridgeUrl: "https://aimer.example.com",
      hasActiveSigningKey: true,
    });

    mockLoadSlice.mockReset().mockResolvedValue(EMPTY_SLICE);
    mockEnrichRefreshPayload
      .mockReset()
      .mockImplementation(
        async (_customerId: number, payload: unknown) => payload,
      );
    mockHasStreamingRowsPastCursor.mockReset().mockResolvedValue(false);
  });

  // ── Body validation ─────────────────────────────────────────

  it("rejects requests with both acked_context_jti and failed_context_jti", async () => {
    const { POST } = await import(
      "@/app/api/aimer/phase2/baseline-event/next-batch/route"
    );
    const res = await POST(
      makeRequest({
        customerId: 42,
        acked_context_jti: "jti-a",
        failed_context_jti: "jti-b",
      }),
      ctx,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "mutually_exclusive_ack_and_fail",
    });
  });

  it("returns 400 on invalid customerId", async () => {
    const { POST } = await import(
      "@/app/api/aimer/phase2/baseline-event/next-batch/route"
    );
    const res = await POST(makeRequest({ customerId: "nope" }), ctx);
    expect(res.status).toBe(400);
  });

  it("returns 404 when caller cannot access the requested customer", async () => {
    mockResolveScope.mockResolvedValue([99]);
    const { POST } = await import(
      "@/app/api/aimer/phase2/baseline-event/next-batch/route"
    );
    const res = await POST(makeRequest({ customerId: 42 }), ctx);
    expect(res.status).toBe(404);
  });

  // ── Ack / fail flow ─────────────────────────────────────────

  it("calls commitOnAck scoped to baseline_event when acked_context_jti is set", async () => {
    const { POST } = await import(
      "@/app/api/aimer/phase2/baseline-event/next-batch/route"
    );
    await POST(
      makeRequest({ customerId: 42, acked_context_jti: "jti-prev" }),
      ctx,
    );
    expect(mockState.commitOnAck).toHaveBeenCalledWith(
      42,
      "jti-prev",
      "baseline_event",
    );
    expect(mockState.recordOnFail).not.toHaveBeenCalled();
  });

  it("calls recordOnFail scoped to baseline_event when failed_context_jti is set", async () => {
    const { POST } = await import(
      "@/app/api/aimer/phase2/baseline-event/next-batch/route"
    );
    await POST(
      makeRequest({
        customerId: 42,
        failed_context_jti: "jti-prev",
        failure_reason: "aimer 500",
      }),
      ctx,
    );
    expect(mockState.recordOnFail).toHaveBeenCalledWith(
      42,
      "jti-prev",
      "aimer 500",
      "baseline_event",
    );
    expect(mockState.commitOnAck).not.toHaveBeenCalled();
  });

  // ── Pause gate ─────────────────────────────────────────────

  it("returns paused=true and null components when opportunistic push is disabled", async () => {
    mockState.isOpportunisticEnabled.mockResolvedValue(false);
    const { POST } = await import(
      "@/app/api/aimer/phase2/baseline-event/next-batch/route"
    );
    const res = await POST(makeRequest({ customerId: 42 }), ctx);
    const body = await res.json();
    expect(body.paused).toBe(true);
    expect(body.has_more).toBe(false);
    expect(body.context_token).toBeNull();
    expect(mockBuildPush).not.toHaveBeenCalled();
  });

  // ── Empty work ──────────────────────────────────────────────

  it("returns has_more=false with null components when queue + slice are empty", async () => {
    const { POST } = await import(
      "@/app/api/aimer/phase2/baseline-event/next-batch/route"
    );
    const res = await POST(makeRequest({ customerId: 42 }), ctx);
    const body = await res.json();
    expect(body).toEqual({
      has_more: false,
      context_token: null,
      events_envelope: null,
      events_data: null,
      context_jti: null,
      aimer_endpoint_path: null,
      aimer_endpoint_url: null,
      batch_jti: null,
      schema_version: null,
    });
    expect(mockBuildPush).not.toHaveBeenCalled();
    expect(mockState.insertInflight).not.toHaveBeenCalled();
  });

  // ── Queue notices first ─────────────────────────────────────

  it("emits a refresh-window queue notice with the refresh schema_version + path", async () => {
    mockState.claimPendingNotices.mockResolvedValue([
      {
        id: "5",
        enqueued_at: new Date(),
        kind: "refresh_baseline_window",
        payload: {
          window: {
            kind: "baseline_event",
            from: "2026-01-01",
            to: "2026-02-01",
          },
          baseline_version: "phase1b-four-selector",
          events: [],
        },
        attempts: 0,
        last_attempt_at: null,
        last_error: null,
        acked_at: null,
        acked_context_jti: null,
      },
    ]);

    const { POST } = await import(
      "@/app/api/aimer/phase2/baseline-event/next-batch/route"
    );
    const res = await POST(makeRequest({ customerId: 42 }), ctx);
    const body = await res.json();

    expect(mockBuildPush).toHaveBeenCalledTimes(1);
    const args = mockBuildPush.mock.calls[0][0];
    expect(args.schemaVersion).toBe("phase2.refresh_window.v1");
    expect(args.payload.window.kind).toBe("baseline_event");

    expect(body.aimer_endpoint_path).toBe("/api/phase2/refresh-window");
    expect(body.schema_version).toBe("phase2.refresh_window.v1");
    expect(body.aimer_endpoint_url).toBe(
      "https://aimer.example.com/api/phase2/refresh-window",
    );

    // Refresh notice should not advance the streaming cursor.
    expect(mockState.insertInflight).toHaveBeenCalledWith(42, {
      contextJti: "jti-new",
      kind: "baseline_event",
      cursorAdvanceToEventTime: null,
      cursorAdvanceToEventKey: null,
      queueRowIds: ["5"],
    });

    // Streaming slice must NOT be queried — queue notices first.
    expect(mockLoadSlice).not.toHaveBeenCalled();
  });

  it("aggregates consecutive withdraw_baseline_event rows into one withdraw envelope", async () => {
    mockState.claimPendingNotices.mockResolvedValue([
      {
        id: "1",
        enqueued_at: new Date(),
        kind: "withdraw_baseline_event",
        payload: {
          kind: "baseline_event",
          baseline_version: "v1",
          event_keys: ["10"],
        },
        attempts: 0,
        last_attempt_at: null,
        last_error: null,
        acked_at: null,
        acked_context_jti: null,
      },
      {
        id: "2",
        enqueued_at: new Date(),
        kind: "withdraw_baseline_event",
        payload: {
          kind: "baseline_event",
          baseline_version: "v1",
          event_keys: ["11"],
        },
        attempts: 0,
        last_attempt_at: null,
        last_error: null,
        acked_at: null,
        acked_context_jti: null,
      },
    ]);

    const { POST } = await import(
      "@/app/api/aimer/phase2/baseline-event/next-batch/route"
    );
    const res = await POST(makeRequest({ customerId: 42 }), ctx);
    const body = await res.json();

    const args = mockBuildPush.mock.calls[0][0];
    expect(args.schemaVersion).toBe("phase2.withdraw.v1");
    expect(args.payload.withdrawals).toHaveLength(2);
    expect(body.aimer_endpoint_path).toBe("/api/phase2/withdraw");
    expect(mockState.insertInflight.mock.calls[0][1].queueRowIds).toEqual([
      "1",
      "2",
    ]);
  });

  it("enriches refresh_baseline_window queue payload before signing", async () => {
    const queuedPayload = {
      window: {
        kind: "baseline_event",
        from: "2026-01-01T00:00:00.000Z",
        to: "2026-02-01T00:00:00.000Z",
      },
      baseline_version: "phase1b-four-selector",
      events: [
        {
          event_key: "10",
          event_time: "2026-01-15T00:00:00.000Z",
          kind: "HttpThreat",
        },
      ],
    };
    const enrichedPayload = {
      ...queuedPayload,
      events: [
        {
          ...queuedPayload.events[0],
          raw_event: { foo: "bar" },
          score_window_context: {
            kind_cohort_window: {
              from: queuedPayload.window.from,
              to: queuedPayload.window.to,
            },
            kind_cohort_size: 5,
            baseline_rank_snapshot: 0.7,
          },
          window_signals: {
            s1_percentile_rank: 0.9,
            s3_recurring_count: 1,
            s4_correlated_count: 0,
            s4_correlated_event_keys: [],
          },
          asset_context: {
            primary_asset: null,
            peer_event_summary: { total_peer_count: 0, top_peer_kinds: [] },
          },
          scoring_weights_snapshot: {},
        },
      ],
    };
    mockEnrichRefreshPayload.mockResolvedValueOnce(enrichedPayload);
    mockState.claimPendingNotices.mockResolvedValue([
      {
        id: "7",
        enqueued_at: new Date(),
        kind: "refresh_baseline_window",
        payload: queuedPayload,
        attempts: 0,
        last_attempt_at: null,
        last_error: null,
        acked_at: null,
        acked_context_jti: null,
      },
    ]);
    const { POST } = await import(
      "@/app/api/aimer/phase2/baseline-event/next-batch/route"
    );
    await POST(makeRequest({ customerId: 42 }), ctx);
    expect(mockEnrichRefreshPayload).toHaveBeenCalledTimes(1);
    expect(mockEnrichRefreshPayload).toHaveBeenCalledWith(42, queuedPayload);
    // The enriched payload — not the raw queue row — is what gets
    // handed to the orchestrator for envelope signing, so aimer-web
    // sees the §6 fields on refresh / backfill batches too.
    expect(mockBuildPush.mock.calls[0][0].payload).toEqual(enrichedPayload);
  });

  it("caps withdraw aggregation by serialized byte budget", async () => {
    // Each withdraw payload is ~512 KB once the event_keys array is
    // expanded, so two rows already exceed the 1 MiB shared cap minus
    // the external_key reserve. The route must stop at the first row
    // whose inclusion would push the envelope past the budget.
    const big = "x".repeat(512 * 1024);
    const heavyRow = (id: string) => ({
      id,
      enqueued_at: new Date(),
      kind: "withdraw_baseline_event" as const,
      payload: {
        kind: "baseline_event",
        baseline_version: "v1",
        event_keys: [big],
      },
      attempts: 0,
      last_attempt_at: null,
      last_error: null,
      acked_at: null,
      acked_context_jti: null,
    });
    mockState.claimPendingNotices.mockResolvedValue([
      heavyRow("1"),
      heavyRow("2"),
      heavyRow("3"),
    ]);
    const { POST } = await import(
      "@/app/api/aimer/phase2/baseline-event/next-batch/route"
    );
    const res = await POST(makeRequest({ customerId: 42 }), ctx);
    const body = await res.json();
    const args = mockBuildPush.mock.calls[0][0];
    expect(args.payload.withdrawals).toHaveLength(1);
    // Unclaimed tail must surface as `has_more` so the drain loop pulls
    // the remaining rows on the next iteration.
    expect(body.has_more).toBe(true);
    expect(mockState.insertInflight.mock.calls[0][1].queueRowIds).toEqual([
      "1",
    ]);
  });

  it("sets has_more=true when a queue notice is followed by pending streaming rows", async () => {
    // Single refresh notice + streaming work past the cursor: without
    // the streaming-pending probe, the drain loop would terminate
    // after the queue ack and leave the new rows for the next 5-minute
    // tick (queue notices first, new-row batches second within the
    // SAME activation).
    mockState.claimPendingNotices.mockResolvedValue([
      {
        id: "11",
        enqueued_at: new Date(),
        kind: "refresh_baseline_window",
        payload: {
          window: {
            kind: "baseline_event",
            from: "2026-01-01T00:00:00.000Z",
            to: "2026-02-01T00:00:00.000Z",
          },
          baseline_version: "phase1b-four-selector",
          events: [],
        },
        attempts: 0,
        last_attempt_at: null,
        last_error: null,
        acked_at: null,
        acked_context_jti: null,
      },
    ]);
    mockHasStreamingRowsPastCursor.mockResolvedValue(true);

    const { POST } = await import(
      "@/app/api/aimer/phase2/baseline-event/next-batch/route"
    );
    const res = await POST(makeRequest({ customerId: 42 }), ctx);
    const body = await res.json();
    expect(body.has_more).toBe(true);
    expect(mockHasStreamingRowsPastCursor).toHaveBeenCalledWith({
      customerId: 42,
      cursorEventTime: null,
      cursorEventKey: null,
    });
  });

  it("re-enqueues tail sub-payloads when enrichment pushes a refresh notice past the byte cap", async () => {
    // Build an enriched payload whose serialized size exceeds the
    // shared 1 MiB cap, simulating the case where the producer
    // sub-divided the window to the corpus-only size at enqueue time
    // but the §6 enrichment fields (raw_event etc.) added at drain
    // time blow it past the budget.
    const bigFiller = "x".repeat(400 * 1024); // ~400 KB per event
    const queuedPayload = {
      window: {
        kind: "baseline_event",
        from: "2026-01-01T00:00:00.000Z",
        to: "2026-02-01T00:00:00.000Z",
      },
      baseline_version: "phase1b-four-selector",
      events: [
        {
          event_key: "10",
          event_time: "2026-01-01T00:00:00.000Z",
          kind: "HttpThreat",
        },
        {
          event_key: "20",
          event_time: "2026-01-15T00:00:00.000Z",
          kind: "HttpThreat",
        },
        {
          event_key: "30",
          event_time: "2026-01-25T00:00:00.000Z",
          kind: "HttpThreat",
        },
      ],
    };
    const enrichedPayload = {
      ...queuedPayload,
      events: queuedPayload.events.map((ev) => ({
        ...ev,
        // Each enriched event ~400 KB so three events comfortably
        // exceed the 1 MiB shared cap and force the subdivider to
        // split into multiple sub-windows.
        raw_event: { blob: bigFiller },
      })),
    };
    mockEnrichRefreshPayload.mockResolvedValueOnce(enrichedPayload);
    mockState.claimPendingNotices.mockResolvedValue([
      {
        id: "21",
        enqueued_at: new Date(),
        kind: "refresh_baseline_window",
        payload: queuedPayload,
        attempts: 0,
        last_attempt_at: null,
        last_error: null,
        acked_at: null,
        acked_context_jti: null,
      },
    ]);

    const { POST } = await import(
      "@/app/api/aimer/phase2/baseline-event/next-batch/route"
    );
    const res = await POST(makeRequest({ customerId: 42 }), ctx);
    const body = await res.json();

    // The head sub-payload is what reaches the orchestrator — strictly
    // fewer events than the enriched input, so the subdivider must
    // have split it.
    const sentEvents = mockBuildPush.mock.calls[0][0].payload.events;
    expect(sentEvents.length).toBeLessThan(enrichedPayload.events.length);
    // Tail sub-payloads are re-enqueued as fresh notices preserving
    // the `refresh_baseline_window` kind, so the drain loop pulls
    // them on subsequent iterations.
    expect(mockState.enqueueNotice).toHaveBeenCalled();
    for (const call of mockState.enqueueNotice.mock.calls) {
      expect(call[0]).toBe(42);
      expect(call[1]).toBe("refresh_baseline_window");
    }
    expect(body.has_more).toBe(true);
  });

  it("routes backfill_baseline_window to the backfill endpoint", async () => {
    mockState.claimPendingNotices.mockResolvedValue([
      {
        id: "9",
        enqueued_at: new Date(),
        kind: "backfill_baseline_window",
        payload: {
          window: {
            kind: "baseline_event",
            from: "2026-01-01",
            to: "2026-02-01",
          },
          baseline_version: "phase1b-four-selector",
          events: [],
        },
        attempts: 0,
        last_attempt_at: null,
        last_error: null,
        acked_at: null,
        acked_context_jti: null,
      },
    ]);
    const { POST } = await import(
      "@/app/api/aimer/phase2/baseline-event/next-batch/route"
    );
    const res = await POST(makeRequest({ customerId: 42 }), ctx);
    const body = await res.json();
    expect(body.schema_version).toBe("phase2.backfill.v1");
    expect(body.aimer_endpoint_path).toBe("/api/phase2/backfill");
  });

  // ── Streaming slice ──────────────────────────────────────────

  it("emits a phase2.baseline.v1 envelope when queue is empty and slice has rows", async () => {
    mockLoadSlice.mockResolvedValue({
      events: [
        makeStreamingEvent({ event_key: "100" }),
        makeStreamingEvent({ event_key: "101" }),
      ],
      lastEventTime: new Date("2026-01-01T00:00:00.000Z"),
      lastEventKey: "101",
      hasMore: false,
      baselineVersion: "phase1b-four-selector",
    });

    const { POST } = await import(
      "@/app/api/aimer/phase2/baseline-event/next-batch/route"
    );
    const res = await POST(makeRequest({ customerId: 42 }), ctx);
    const body = await res.json();

    expect(mockBuildPush).toHaveBeenCalledTimes(1);
    const args = mockBuildPush.mock.calls[0][0];
    expect(args.schemaVersion).toBe("phase2.baseline.v1");
    expect(args.payload.events).toHaveLength(2);
    expect(args.payload.baseline_version).toBe("phase1b-four-selector");

    expect(body.aimer_endpoint_path).toBe("/api/phase2/baseline/batch");
    expect(body.schema_version).toBe("phase2.baseline.v1");
    expect(body.has_more).toBe(false);

    // The inflight record carries the cursor target for the next ack.
    expect(mockState.insertInflight).toHaveBeenCalledWith(42, {
      contextJti: "jti-new",
      kind: "baseline_event",
      cursorAdvanceToEventTime: new Date("2026-01-01T00:00:00.000Z"),
      cursorAdvanceToEventKey: "101",
      queueRowIds: [],
    });
  });

  it("threads cursor state into loadBaselineStreamingSlice", async () => {
    mockState.getAimerPushState.mockResolvedValue({
      kind: "baseline_event",
      last_pushed_event_time: new Date("2025-12-01T00:00:00Z"),
      last_pushed_event_key: "50",
      last_synced_at: null,
      last_error: null,
      opportunistic_enabled: true,
      paused_at: null,
      paused_by: null,
    });
    const { POST } = await import(
      "@/app/api/aimer/phase2/baseline-event/next-batch/route"
    );
    await POST(makeRequest({ customerId: 42 }), ctx);
    const callArgs = mockLoadSlice.mock.calls[0][0];
    expect(callArgs.cursorEventKey).toBe("50");
    expect(callArgs.cursorEventTime).toEqual(new Date("2025-12-01T00:00:00Z"));
  });

  it("propagates slice.hasMore=true to the response", async () => {
    mockLoadSlice.mockResolvedValue({
      events: [makeStreamingEvent({ event_key: "100" })],
      lastEventTime: new Date("2026-01-01T00:00:00.000Z"),
      lastEventKey: "100",
      hasMore: true,
      baselineVersion: "phase1b-four-selector",
    });
    const { POST } = await import(
      "@/app/api/aimer/phase2/baseline-event/next-batch/route"
    );
    const res = await POST(makeRequest({ customerId: 42 }), ctx);
    const body = await res.json();
    expect(body.has_more).toBe(true);
  });

  // ── TTL prune ───────────────────────────────────────────────

  it("opportunistically prunes expired inflight rows on every call", async () => {
    const { POST } = await import(
      "@/app/api/aimer/phase2/baseline-event/next-batch/route"
    );
    await POST(makeRequest({ customerId: 42 }), ctx);
    expect(mockState.pruneExpiredInflight).toHaveBeenCalledWith(42);
  });

  // ── Attribution ─────────────────────────────────────────────

  it("threads the real session account_id into buildPhase2Push", async () => {
    mockLoadSlice.mockResolvedValue({
      events: [makeStreamingEvent()],
      lastEventTime: new Date("2026-01-01T00:00:00.000Z"),
      lastEventKey: "100",
      hasMore: false,
      baselineVersion: "phase1b-four-selector",
    });
    currentSession = makeSession({ accountId: "real-account-uuid" });
    const { POST } = await import(
      "@/app/api/aimer/phase2/baseline-event/next-batch/route"
    );
    await POST(makeRequest({ customerId: 42 }), ctx);
    expect(mockBuildPush.mock.calls[0][0].accountId).toBe("real-account-uuid");
  });
});
