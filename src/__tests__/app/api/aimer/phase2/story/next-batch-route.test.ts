import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthSession } from "@/lib/auth/jwt";

type HandlerFn = (
  request: NextRequest,
  context: unknown,
  session: AuthSession,
) => Promise<Response>;

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
  SYSTEM_ACTOR_ACCOUNT_ID: "00000000-0000-0000-0000-000000000000",
}));

const mockState = vi.hoisted(() => ({
  claimPendingNotices: vi.fn(),
  insertInflight: vi.fn(),
  commitOnAck: vi.fn(),
  recordOnFail: vi.fn(),
  pruneExpiredInflight: vi.fn(),
  getAimerPushState: vi.fn(),
  isOpportunisticEnabled: vi.fn(),
  SYSTEM_ACTOR_ACCOUNT_ID: "00000000-0000-0000-0000-000000000000",
}));
vi.mock("@/lib/aimer/phase2/state", () => mockState);

const mockLoadSlice = vi.hoisted(() => vi.fn());
const mockLoadStraggler = vi.hoisted(() => vi.fn());
vi.mock("@/lib/aimer/phase2/story-push", () => ({
  loadStoryStreamingSlice: mockLoadSlice,
  loadStoryStragglerSlice: mockLoadStraggler,
}));

const mockGetSetup = vi.hoisted(() => vi.fn());
vi.mock("@/lib/aimer/setup-status", () => ({
  getAimerIntegrationSetup: mockGetSetup,
}));

const mockGetCustomerPool = vi.hoisted(() => vi.fn());
vi.mock("@/lib/triage/policy/customer-db", () => ({
  getCustomerPool: mockGetCustomerPool,
}));

const mockAuditRecord = vi.hoisted(() => vi.fn());
vi.mock("@/lib/audit/logger", () => ({
  auditLog: { record: mockAuditRecord },
}));

const now = Math.floor(Date.now() / 1000);
function makeSession(): AuthSession {
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
  };
}

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/aimer/phase2/story/next-batch", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const ctx = { params: Promise.resolve({}) };

const EMPTY_SLICE = {
  stories: [],
  lastEventTime: null,
  lastEventKey: null,
  hasMore: false,
};

describe("POST /api/aimer/phase2/story/next-batch", () => {
  beforeEach(() => {
    currentSession = makeSession();
    mockHasPermission.mockReset().mockImplementation(async (_r, p) => {
      if (p === "customers:access-all") return false;
      return true;
    });
    mockResolveScope.mockReset().mockResolvedValue([42]);
    mockBuildPush.mockReset().mockResolvedValue({
      context_token: "ctx-jws",
      events_envelope: "env-jws",
      events_data: '{"stories":[]}',
      context_jti: "jti-new",
    });
    mockState.claimPendingNotices.mockReset().mockResolvedValue([]);
    mockState.insertInflight.mockReset().mockResolvedValue(undefined);
    mockState.commitOnAck.mockReset().mockResolvedValue({ storyBetaRows: [] });
    mockState.recordOnFail.mockReset().mockResolvedValue(undefined);
    mockState.pruneExpiredInflight.mockReset().mockResolvedValue(0);
    mockState.isOpportunisticEnabled.mockReset().mockResolvedValue(true);
    mockState.getAimerPushState.mockReset().mockResolvedValue({
      kind: "story",
      last_pushed_event_time: new Date("2026-01-01T00:00:00Z"),
      last_pushed_event_key: "0",
      last_synced_at: null,
      last_error: null,
      opportunistic_enabled: true,
      paused_at: null,
      paused_by: null,
      streaming_activated_at: new Date("2025-12-31T00:00:00Z"),
    });
    mockLoadSlice.mockReset().mockResolvedValue(EMPTY_SLICE);
    mockLoadStraggler
      .mockReset()
      .mockResolvedValue({ stories: [], hasMore: false });
    mockGetSetup.mockReset().mockResolvedValue({
      aiceId: "aice.example.com",
      bridgeUrl: "https://aimer.example.com",
      hasActiveSigningKey: true,
    });
    mockGetCustomerPool.mockReset().mockResolvedValue({
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    });
    mockAuditRecord.mockReset().mockResolvedValue(undefined);
  });

  it("rejects mutually exclusive ack + failed jtis", async () => {
    const { POST } = await import(
      "@/app/api/aimer/phase2/story/next-batch/route"
    );
    const res = await POST(
      makeRequest({
        customerId: 42,
        acked_context_jti: "a",
        failed_context_jti: "b",
      }),
      ctx,
    );
    expect(res.status).toBe(400);
  });

  it("scopes commitOnAck / recordOnFail to 'story'", async () => {
    const { POST } = await import(
      "@/app/api/aimer/phase2/story/next-batch/route"
    );
    await POST(
      makeRequest({ customerId: 42, acked_context_jti: "jti-prev" }),
      ctx,
    );
    expect(mockState.commitOnAck).toHaveBeenCalledWith(42, "jti-prev", "story");

    mockState.commitOnAck.mockClear();
    await POST(
      makeRequest({
        customerId: 42,
        failed_context_jti: "jti-fail",
        failure_reason: "aimer 500",
      }),
      ctx,
    );
    expect(mockState.recordOnFail).toHaveBeenCalledWith(
      42,
      "jti-fail",
      "aimer 500",
      "story",
    );
  });

  it("returns paused: true when opportunistic_enabled is false", async () => {
    mockState.isOpportunisticEnabled.mockResolvedValue(false);
    const { POST } = await import(
      "@/app/api/aimer/phase2/story/next-batch/route"
    );
    const res = await POST(makeRequest({ customerId: 42 }), ctx);
    const body = await res.json();
    expect(body.paused).toBe(true);
    expect(body.has_more).toBe(false);
  });

  it("seeds the cursor when NULL and queue is empty, returns empty", async () => {
    mockState.getAimerPushState.mockResolvedValue({
      kind: "story",
      last_pushed_event_time: null,
      last_pushed_event_key: null,
      last_synced_at: null,
      last_error: null,
      opportunistic_enabled: true,
      paused_at: null,
      paused_by: null,
      streaming_activated_at: null,
    });
    const poolMock = {
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    };
    mockGetCustomerPool.mockResolvedValue(poolMock);
    const { POST } = await import(
      "@/app/api/aimer/phase2/story/next-batch/route"
    );
    const res = await POST(makeRequest({ customerId: 42 }), ctx);
    const body = await res.json();
    expect(body.has_more).toBe(false);
    expect(body.context_jti).toBeNull();
    expect(poolMock.query).toHaveBeenCalled();
    const sqlArg = poolMock.query.mock.calls[0][0];
    expect(sqlArg).toContain("last_pushed_event_time   = NOW()");
    // Round-5 regression: seed must also stamp the activation
    // watermark so the straggler scan has a stable lower bound.
    expect(sqlArg).toContain("streaming_activated_at   = NOW()");
    expect(mockBuildPush).not.toHaveBeenCalled();
    // The straggler scan must NOT run on this iteration — the state
    // row has no activation yet, so the route skips straight to the
    // seed step.
    expect(mockLoadStraggler).not.toHaveBeenCalled();
  });

  it("claims withdraw_story first, refresh second, backfill third", async () => {
    // First call to claimPendingNotices (withdraw_story) returns a row.
    mockState.claimPendingNotices.mockImplementationOnce(async () => [
      {
        id: "1",
        enqueued_at: new Date(),
        kind: "withdraw_story",
        payload: { kind: "story", story_id: "1001", story_version: "v1" },
        attempts: 0,
        last_attempt_at: null,
        last_error: null,
        acked_at: null,
        acked_context_jti: null,
      },
    ]);
    const { POST } = await import(
      "@/app/api/aimer/phase2/story/next-batch/route"
    );
    const res = await POST(makeRequest({ customerId: 42 }), ctx);
    const body = await res.json();
    expect(body.schema_version).toBe("phase2.withdraw.v1");
    expect(body.aimer_endpoint_path).toBe("/api/phase2/withdraw");
    // The route stops at the first non-empty kind in priority order.
    expect(mockState.claimPendingNotices).toHaveBeenCalledTimes(1);
    expect(mockState.claimPendingNotices.mock.calls[0][2].kinds).toEqual([
      "withdraw_story",
    ]);
  });

  it("emits new-row Story batch when queue is empty", async () => {
    mockLoadSlice.mockResolvedValue({
      stories: [
        {
          story_id: "1001",
          story_version: "v1",
          kind: "auto_correlated",
          time_window: { start: "a", end: "b" },
          members: [],
        },
      ],
      lastEventTime: new Date("2026-01-02T00:00:00Z"),
      lastEventKey: "1001",
      hasMore: false,
    });
    const { POST } = await import(
      "@/app/api/aimer/phase2/story/next-batch/route"
    );
    const res = await POST(makeRequest({ customerId: 42 }), ctx);
    const body = await res.json();
    expect(body.schema_version).toBe("phase2.story.v1");
    expect(body.aimer_endpoint_path).toBe("/api/phase2/story/batch");
    expect(mockState.insertInflight).toHaveBeenCalledWith(42, {
      contextJti: "jti-new",
      kind: "story",
      cursorAdvanceToEventTime: new Date("2026-01-02T00:00:00Z"),
      cursorAdvanceToEventKey: "1001",
      queueRowIds: [],
      pushedStories: [{ storyId: "1001", storyVersion: "v1" }],
    });
  });

  it("persists the exact pushed Story id+version set on the inflight row so a Story inserted between mint and ack is not β-bumped or audited", async () => {
    // Round-3 / round-4 regression: at mint time the slice contains
    // a specific set of Story rows. The ack path must address that
    // exact set, not whatever currently matches
    // `(prev_cursor, new_cursor]`. If we only persisted the cursor
    // target, a Story inserted between mint and ack would be
    // β-bumped + audited without ever being delivered. Note that
    // the round-4 cursor-key change to `(created_at, id)` also
    // guarantees the late-insert is picked up by a subsequent
    // drain (it has `created_at > slice.lastEventTime`); this test
    // covers the orthogonal "β/audit only address delivered rows"
    // guarantee.
    mockLoadSlice.mockResolvedValue({
      stories: [
        {
          story_id: "1000",
          story_version: "v1",
          kind: "auto_correlated",
          time_window: { start: "a", end: "b" },
          members: [],
        },
        {
          story_id: "1002",
          story_version: "v1",
          kind: "auto_correlated",
          time_window: { start: "a", end: "c" },
          members: [],
        },
      ],
      // Note: id "1001" is NOT in the slice even though it sorts by
      // story_id between 1000 and 1002 — simulating the slice that
      // was actually signed.
      lastEventTime: new Date("2026-01-02T00:00:00Z"),
      lastEventKey: "1002",
      hasMore: false,
    });
    const { POST } = await import(
      "@/app/api/aimer/phase2/story/next-batch/route"
    );
    await POST(makeRequest({ customerId: 42 }), ctx);
    const arg = mockState.insertInflight.mock.calls[0][1];
    expect(arg.pushedStories).toEqual([
      { storyId: "1000", storyVersion: "v1" },
      { storyId: "1002", storyVersion: "v1" },
    ]);
    // The cursor target advances to the last delivered row's
    // `(created_at, id)` so the drain does not re-send these on the
    // next iteration. A late-inserted Story with `created_at` >
    // `slice.lastEventTime` is still selected by a subsequent drain
    // — see the SQL-level cursor test in story-push.test.ts.
    expect(arg.cursorAdvanceToEventKey).toBe("1002");
  });

  it("emits straggler batch BEFORE forward slice, with null cursor advance and pushedStories populated", async () => {
    // Round-5 race fix: a row inserted by a long correlator
    // transaction can commit with `created_at` BEHIND the cursor that
    // a previous drain just advanced (PG `now()` is transaction-start
    // time). The straggler scan recovers these rows, but it MUST NOT
    // advance the forward cursor — only the persisted
    // `pushed_stories` set drives β/audit on ack.
    mockLoadStraggler.mockResolvedValueOnce({
      stories: [
        {
          story_id: "777",
          story_version: "v1",
          kind: "auto_correlated",
          time_window: { start: "a", end: "b" },
          members: [],
        },
      ],
      hasMore: false,
    });
    mockLoadSlice.mockResolvedValueOnce({
      stories: [
        {
          story_id: "888",
          story_version: "v1",
          kind: "auto_correlated",
          time_window: { start: "a", end: "b" },
          members: [],
        },
      ],
      lastEventTime: new Date("2026-03-01T00:00:00Z"),
      lastEventKey: "888",
      hasMore: false,
    });
    const { POST } = await import(
      "@/app/api/aimer/phase2/story/next-batch/route"
    );
    const res = await POST(makeRequest({ customerId: 42 }), ctx);
    const body = await res.json();
    expect(body.schema_version).toBe("phase2.story.v1");
    // Forward-slice loader must NOT have been called this iteration —
    // stragglers are drained first; the forward slice waits for the
    // next iteration of the drain loop.
    expect(mockLoadSlice).not.toHaveBeenCalled();
    expect(body.has_more).toBe(true);
    // inflight: null cursor advance + pushedStories pinned to the
    // straggler set.
    const insertArg = mockState.insertInflight.mock.calls[0][1];
    expect(insertArg.cursorAdvanceToEventTime).toBeNull();
    expect(insertArg.cursorAdvanceToEventKey).toBeNull();
    expect(insertArg.pushedStories).toEqual([
      { storyId: "777", storyVersion: "v1" },
    ]);
  });

  it("skips the straggler scan when streaming_activated_at is NULL (pre-seed state)", async () => {
    // Defense in depth: even if the route is somehow reached with a
    // populated cursor but a NULL activation watermark (e.g., a
    // migration race where the backfill didn't run), the straggler
    // scan must not fire — without a lower bound it would scan the
    // entire historical corpus and back-flood aimer-web.
    mockState.getAimerPushState.mockResolvedValueOnce({
      kind: "story",
      last_pushed_event_time: new Date("2026-01-01T00:00:00Z"),
      last_pushed_event_key: "0",
      last_synced_at: null,
      last_error: null,
      opportunistic_enabled: true,
      paused_at: null,
      paused_by: null,
      streaming_activated_at: null,
    });
    const { POST } = await import(
      "@/app/api/aimer/phase2/story/next-batch/route"
    );
    await POST(makeRequest({ customerId: 42 }), ctx);
    expect(mockLoadStraggler).not.toHaveBeenCalled();
    // Forward slice still runs.
    expect(mockLoadSlice).toHaveBeenCalled();
  });

  // ── Phase 0.5 watermark (#644) ──────────────────────────────

  it("attaches cursor_event_time + cursor_quality=soft on the forward streaming envelope", async () => {
    mockLoadSlice.mockResolvedValue({
      stories: [
        {
          story_id: "1001",
          story_version: "v1",
          kind: "auto_correlated",
          time_window: { start: "a", end: "b" },
          members: [],
        },
      ],
      lastEventTime: new Date("2026-01-02T00:00:00Z"),
      lastEventKey: "1001",
      hasMore: false,
    });
    const { POST } = await import(
      "@/app/api/aimer/phase2/story/next-batch/route"
    );
    await POST(makeRequest({ customerId: 42 }), ctx);
    const args = mockBuildPush.mock.calls[0][0];
    expect(args.cursorWatermark).toEqual({
      eventTime: new Date("2026-01-01T00:00:00Z"),
      quality: "soft",
    });
  });

  it("drops the cursorWatermark on the straggler branch via the helper-level gate", async () => {
    // The route passes a candidate watermark on the straggler path
    // too (`state.last_pushed_event_time` is non-null here), but
    // `emitStreamingBatch` gates on `cursorAdvanceToEventTime !== null`
    // — null on the straggler branch — so the orchestrator must see
    // `cursorWatermark: undefined`. This pins §2's helper-level
    // invariant: forward-cursor advance implies watermark attached.
    mockLoadStraggler.mockResolvedValueOnce({
      stories: [
        {
          story_id: "777",
          story_version: "v1",
          kind: "auto_correlated",
          time_window: { start: "a", end: "b" },
          members: [],
        },
      ],
      hasMore: false,
    });
    const { POST } = await import(
      "@/app/api/aimer/phase2/story/next-batch/route"
    );
    await POST(makeRequest({ customerId: 42 }), ctx);
    const args = mockBuildPush.mock.calls[0][0];
    expect(args.cursorWatermark).toBeUndefined();
    // Sanity: this was the straggler path (no forward-slice load).
    expect(mockLoadSlice).not.toHaveBeenCalled();
  });

  it("omits cursorWatermark on the queue-notice branch", async () => {
    mockState.claimPendingNotices.mockImplementationOnce(async () => [
      {
        id: "1",
        enqueued_at: new Date(),
        kind: "withdraw_story",
        payload: { kind: "story", story_id: "1001", story_version: "v1" },
        attempts: 0,
        last_attempt_at: null,
        last_error: null,
        acked_at: null,
        acked_context_jti: null,
      },
    ]);
    const { POST } = await import(
      "@/app/api/aimer/phase2/story/next-batch/route"
    );
    await POST(makeRequest({ customerId: 42 }), ctx);
    const args = mockBuildPush.mock.calls[0][0];
    expect(args.cursorWatermark).toBeUndefined();
  });

  it("emits one triage.story.send audit per Story acked on prior batch", async () => {
    mockState.commitOnAck.mockResolvedValueOnce({
      storyBetaRows: [
        { storyId: "1001", storyVersion: "v1" },
        { storyId: "1002", storyVersion: "v1" },
      ],
    });
    const { POST } = await import(
      "@/app/api/aimer/phase2/story/next-batch/route"
    );
    await POST(
      makeRequest({ customerId: 42, acked_context_jti: "jti-prev" }),
      ctx,
    );
    expect(mockAuditRecord).toHaveBeenCalledTimes(2);
    const first = mockAuditRecord.mock.calls[0][0];
    expect(first.action).toBe("triage.story.send");
    expect(first.customerId).toBe(42);
    expect(first.actor).toBe("00000000-0000-0000-0000-000000000000");
    expect(first.details.trigger).toBe("opportunistic");
    expect(first.details.forceRefresh).toBe(false);
    expect(first.details.duplicatesSkipped).toBeNull();
  });
});
