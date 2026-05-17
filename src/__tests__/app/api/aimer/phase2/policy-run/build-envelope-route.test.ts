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
}));

const mockLoad = vi.hoisted(() => vi.fn());
const mockBuildSlice = vi.hoisted(() => vi.fn());
class PolicyRunLoadError extends Error {
  readonly code: string;
  readonly status?: string;
  constructor(code: string, message: string, status?: string) {
    super(message);
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}
vi.mock("@/lib/aimer/phase2/policy-run-payload", () => ({
  loadPolicyRunForSend: mockLoad,
  buildPolicyRunSlice: mockBuildSlice,
  PolicyRunLoadError,
}));

const mockInsertInflight = vi.hoisted(() => vi.fn());
const mockPrune = vi.hoisted(() => vi.fn());
vi.mock("@/lib/aimer/phase2/policy-run-send", async () => {
  const actual = (await vi.importActual(
    "@/lib/aimer/phase2/policy-run-send",
  )) as Record<string, unknown>;
  return {
    ...actual,
    insertPolicyRunSendInflight: mockInsertInflight,
    pruneExpiredPolicyRunSendInflight: mockPrune,
  };
});

const mockGetSetup = vi.hoisted(() => vi.fn());
vi.mock("@/lib/aimer/setup-status", () => ({
  getAimerIntegrationSetup: mockGetSetup,
}));

const mockClientQuery = vi.hoisted(() => vi.fn());
vi.mock("@/lib/triage/policy/customer-db", () => ({
  getCustomerPool: () =>
    Promise.resolve({
      connect: () =>
        Promise.resolve({
          query: mockClientQuery,
          release: () => {},
        }),
    }),
}));

const now = Math.floor(Date.now() / 1000);

function makeSession(overrides: Partial<AuthSession> = {}): AuthSession {
  return {
    accountId: "11111111-1111-1111-1111-111111111111",
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
    "http://localhost/api/aimer/phase2/policy-run/build-envelope",
    {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    },
  );
}

const ctx = { params: Promise.resolve({}) };
const VALID_SEND_ACTION = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

const RUN_BODY = {
  run_id: "1",
  owner_account_id: "11111111-2222-3333-4444-555555555555",
  period_start: "2026-05-01T00:00:00Z",
  period_end: "2026-05-08T00:00:00Z",
  created_at: "2026-05-10T00:00:00Z",
  finalized_at: "2026-05-10T00:01:33Z",
  baseline_version: "1.B.0",
  policies_fingerprint: "abc",
  exclusions_fingerprint: "def",
  status: "ready" as const,
};

async function importRoute() {
  return await import("@/app/api/aimer/phase2/policy-run/build-envelope/route");
}

describe("POST /api/aimer/phase2/policy-run/build-envelope", () => {
  beforeEach(() => {
    currentSession = makeSession();
    mockHasPermission
      .mockReset()
      .mockImplementation(async (_r, perm) => perm !== "customers:access-all");
    mockResolveScope.mockReset().mockResolvedValue([42]);
    mockBuildPush.mockReset().mockResolvedValue({
      context_token: "ctx",
      events_envelope: "env",
      events_data: '{"run":{},"events":[]}',
      context_jti: "jti-fresh",
    });
    mockLoad.mockReset().mockResolvedValue(RUN_BODY);
    mockBuildSlice.mockReset().mockResolvedValue({
      payload: { run: RUN_BODY, events: [] },
      lastEventKey: null,
      hasMore: false,
      eventCount: 0,
    });
    mockInsertInflight.mockReset().mockResolvedValue(undefined);
    mockPrune.mockReset().mockResolvedValue(0);
    mockGetSetup.mockReset().mockResolvedValue({
      aiceId: "aice.example.com",
      bridgeUrl: "https://aimer.example.com",
      hasActiveSigningKey: true,
    });
    // Default: no prior inflight rows (fresh send_action_id).
    mockClientQuery.mockReset().mockResolvedValue({ rows: [] });
  });

  it("rejects out-of-scope customer with 404", async () => {
    mockResolveScope.mockResolvedValue([99]);
    const { POST } = await importRoute();
    const res = await POST(
      makeRequest({
        customer_id: 42,
        run_id: "1",
        send_action_id: VALID_SEND_ACTION,
      }),
      ctx,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("rejects run_not_found with 404", async () => {
    mockLoad.mockRejectedValueOnce(
      new PolicyRunLoadError("run_not_found", "missing"),
    );
    const { POST } = await importRoute();
    const res = await POST(
      makeRequest({
        customer_id: 42,
        run_id: "9999",
        send_action_id: VALID_SEND_ACTION,
      }),
      ctx,
    );
    expect(res.status).toBe(404);
  });

  it("rejects 'computing' runs with 409 run_not_eligible", async () => {
    mockLoad.mockRejectedValueOnce(
      new PolicyRunLoadError("run_not_eligible", "no", "computing"),
    );
    const { POST } = await importRoute();
    const res = await POST(
      makeRequest({
        customer_id: 42,
        run_id: "1",
        send_action_id: VALID_SEND_ACTION,
      }),
      ctx,
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "run_not_eligible" });
  });

  it("returns last_event_key_in_batch: null + has_more: false for empty terminal run", async () => {
    const { POST } = await importRoute();
    const res = await POST(
      makeRequest({
        customer_id: 42,
        run_id: "1",
        send_action_id: VALID_SEND_ACTION,
      }),
      ctx,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.last_event_key_in_batch).toBeNull();
    expect(body.has_more).toBe(false);
    expect(body.batch_index).toBe(0);
    expect(body.event_count).toBe(0);
    expect(body.schema_version).toBe("phase2.policy_run.v1");
    expect(body.aimer_endpoint_url).toBe(
      "https://aimer.example.com/api/phase2/policy-run",
    );
    // Inflight insert tagged is_terminal: true on the empty terminal slice,
    // and afterEventKey echoed for the cursor-identity partial unique
    // index defense against sequential retries.
    expect(mockInsertInflight).toHaveBeenCalledWith(42, {
      contextJti: "jti-fresh",
      sendActionId: VALID_SEND_ACTION,
      runId: "1",
      actorAccountId: "11111111-1111-1111-1111-111111111111",
      batchIndex: 0,
      isTerminal: true,
      lastEventKey: null,
      afterEventKey: null,
    });
  });

  it("returns has_more: true with a non-null last_event_key when slice is partial", async () => {
    mockBuildSlice.mockResolvedValueOnce({
      payload: {
        run: RUN_BODY,
        events: [{ event_key: "5" }],
      },
      lastEventKey: "5",
      hasMore: true,
      eventCount: 1,
    });
    const { POST } = await importRoute();
    const res = await POST(
      makeRequest({
        customer_id: 42,
        run_id: "1",
        send_action_id: VALID_SEND_ACTION,
      }),
      ctx,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.has_more).toBe(true);
    expect(body.last_event_key_in_batch).toBe("5");
    expect(mockInsertInflight).toHaveBeenCalledWith(
      42,
      expect.objectContaining({
        isTerminal: false,
        lastEventKey: "5",
        afterEventKey: null,
      }),
    );
  });

  it("translates UNIQUE-violation on inflight insert to 409 duplicate_batch_for_send_action", async () => {
    const uniqueErr = Object.assign(new Error("dup"), { code: "23505" });
    mockInsertInflight.mockRejectedValueOnce(uniqueErr);
    const { POST } = await importRoute();
    const res = await POST(
      makeRequest({
        customer_id: 42,
        run_id: "1",
        send_action_id: VALID_SEND_ACTION,
      }),
      ctx,
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "duplicate_batch_for_send_action",
    });
  });

  it("returns 409 on concurrent-race duplicate INSERT — duplicate-index backstop", async () => {
    // Race the route's read-then-insert window: two concurrent calls
    // for {send_action_id, after_event_key="5"} both see priorRows =
    // [batch 0, after_event_key "0", last_event_key "5"] (i.e. neither
    // has minted batch 1 yet, so the duplicate check passes), both
    // pass the chain check at the same prior `last_event_key`, and
    // both attempt to INSERT batch_index 1. The partial unique index
    // on (send_action_id, after_event_key) WHERE after_event_key IS
    // NOT NULL raises 23505 from the loser of the race.
    mockClientQuery.mockResolvedValueOnce({
      rows: [
        {
          batch_index: 0,
          is_terminal: false,
          last_event_key: "5",
          after_event_key: "0",
          actor_account_id: "11111111-1111-1111-1111-111111111111",
          run_id: "1",
        },
      ],
    });
    mockBuildSlice.mockResolvedValueOnce({
      payload: { run: RUN_BODY, events: [{ event_key: "9" }] },
      lastEventKey: "9",
      hasMore: false,
      eventCount: 1,
    });
    const uniqueErr = Object.assign(new Error("dup cursor"), { code: "23505" });
    mockInsertInflight.mockRejectedValueOnce(uniqueErr);
    const { POST } = await importRoute();
    const res = await POST(
      makeRequest({
        customer_id: 42,
        run_id: "1",
        send_action_id: VALID_SEND_ACTION,
        after_event_key: "5",
      }),
      ctx,
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "duplicate_batch_for_send_action",
    });
  });

  it("returns 409 duplicate_batch_for_send_action on a sequential retry of the first batch", async () => {
    // First call already minted batch 0 with after_event_key = null
    // and last_event_key = "5". The browser then loses the response
    // and retries the same request body. The route must detect that
    // the cursor matches an already-minted batch and surface
    // `duplicate_batch_for_send_action`, NOT `cursor_chain_mismatch`,
    // so the client can distinguish a duplicate retry from a real
    // chain violation. Issue #572 contract.
    mockClientQuery.mockResolvedValueOnce({
      rows: [
        {
          batch_index: 0,
          is_terminal: false,
          last_event_key: "5",
          after_event_key: null,
          actor_account_id: "11111111-1111-1111-1111-111111111111",
          run_id: "1",
        },
      ],
    });
    const { POST } = await importRoute();
    const res = await POST(
      makeRequest({
        customer_id: 42,
        run_id: "1",
        send_action_id: VALID_SEND_ACTION,
        // after_event_key omitted: matches the prior batch 0 (null).
      }),
      ctx,
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "duplicate_batch_for_send_action",
    });
    expect(mockBuildSlice).not.toHaveBeenCalled();
    expect(mockInsertInflight).not.toHaveBeenCalled();
  });

  it("returns 409 duplicate_batch_for_send_action on a sequential retry of a subsequent batch", async () => {
    // Send already has batch 0 (after=null, last="5") and batch 1
    // (after="5", last="9"). The browser retries the batch-1 request
    // `{ send_action_id, after_event_key: "5" }` after that batch was
    // inserted. Without the duplicate check the route would compare
    // the cursor "5" to the latest batch's `last_event_key` ("9") and
    // return `cursor_chain_mismatch`; with the duplicate check it
    // returns `duplicate_batch_for_send_action` instead.
    mockClientQuery.mockResolvedValueOnce({
      rows: [
        {
          batch_index: 0,
          is_terminal: false,
          last_event_key: "5",
          after_event_key: null,
          actor_account_id: "11111111-1111-1111-1111-111111111111",
          run_id: "1",
        },
        {
          batch_index: 1,
          is_terminal: false,
          last_event_key: "9",
          after_event_key: "5",
          actor_account_id: "11111111-1111-1111-1111-111111111111",
          run_id: "1",
        },
      ],
    });
    const { POST } = await importRoute();
    const res = await POST(
      makeRequest({
        customer_id: 42,
        run_id: "1",
        send_action_id: VALID_SEND_ACTION,
        after_event_key: "5",
      }),
      ctx,
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "duplicate_batch_for_send_action",
    });
    expect(mockBuildSlice).not.toHaveBeenCalled();
    expect(mockInsertInflight).not.toHaveBeenCalled();
  });

  it("returns 409 duplicate_batch_for_send_action on a sequential retry of the terminal batch", async () => {
    // Send already has batch 0 (after=null, last="5", non-terminal)
    // and batch 1 (after="5", last="9", terminal). The browser
    // retries the terminal request `{ send_action_id,
    // after_event_key: "5" }`. The duplicate check must fire BEFORE
    // the terminal check so the response is
    // `duplicate_batch_for_send_action`, not `send_already_terminal`
    // — the latter would mislead the client into thinking it's
    // missing a finalize step rather than recognizing a normal
    // duplicate retry.
    mockClientQuery.mockResolvedValueOnce({
      rows: [
        {
          batch_index: 0,
          is_terminal: false,
          last_event_key: "5",
          after_event_key: null,
          actor_account_id: "11111111-1111-1111-1111-111111111111",
          run_id: "1",
        },
        {
          batch_index: 1,
          is_terminal: true,
          last_event_key: "9",
          after_event_key: "5",
          actor_account_id: "11111111-1111-1111-1111-111111111111",
          run_id: "1",
        },
      ],
    });
    const { POST } = await importRoute();
    const res = await POST(
      makeRequest({
        customer_id: 42,
        run_id: "1",
        send_action_id: VALID_SEND_ACTION,
        after_event_key: "5",
      }),
      ctx,
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "duplicate_batch_for_send_action",
    });
    expect(mockBuildSlice).not.toHaveBeenCalled();
    expect(mockInsertInflight).not.toHaveBeenCalled();
  });

  it("rejects a first-batch build with a non-null cursor (skipped-first-cursor)", async () => {
    // Fresh send_action_id (priorRows empty). A buggy or tampered
    // client supplies after_event_key = "999" trying to skip earlier
    // events and mint a tail-only batch. The chain check rejects
    // before any slice is built or signed.
    const { POST } = await importRoute();
    const res = await POST(
      makeRequest({
        customer_id: 42,
        run_id: "1",
        send_action_id: VALID_SEND_ACTION,
        after_event_key: "999",
      }),
      ctx,
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "cursor_chain_mismatch" });
    expect(mockBuildSlice).not.toHaveBeenCalled();
    expect(mockInsertInflight).not.toHaveBeenCalled();
  });

  it("rejects a subsequent batch with the wrong cursor (wrong-next-cursor)", async () => {
    // Prior inflight: batch 0 (after=null, last="5"), non-terminal.
    // The chain requires the next call to use after_event_key = "5",
    // but the caller supplies "10". "10" does not match any prior
    // batch's after_event_key, so the duplicate check passes; the
    // chain check fires next.
    mockClientQuery.mockResolvedValueOnce({
      rows: [
        {
          batch_index: 0,
          is_terminal: false,
          last_event_key: "5",
          after_event_key: null,
          actor_account_id: "11111111-1111-1111-1111-111111111111",
          run_id: "1",
        },
      ],
    });
    const { POST } = await importRoute();
    const res = await POST(
      makeRequest({
        customer_id: 42,
        run_id: "1",
        send_action_id: VALID_SEND_ACTION,
        after_event_key: "10",
      }),
      ctx,
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "cursor_chain_mismatch" });
    expect(mockBuildSlice).not.toHaveBeenCalled();
    expect(mockInsertInflight).not.toHaveBeenCalled();
  });

  it("rejects a build after the terminal batch has been minted (build-after-terminal)", async () => {
    // Prior inflight: batch 0 (after=null, last="5", non-terminal) +
    // batch 1 (after="5", last="9", terminal). The Send is fully
    // minted and waiting on finalize; the caller supplies a cursor
    // ("9") that does NOT match any prior batch's after_event_key,
    // so the duplicate check passes and the terminal check fires —
    // distinguishing a build-after-terminal violation from a normal
    // duplicate retry of the terminal batch (covered separately).
    mockClientQuery.mockResolvedValueOnce({
      rows: [
        {
          batch_index: 0,
          is_terminal: false,
          last_event_key: "5",
          after_event_key: null,
          actor_account_id: "11111111-1111-1111-1111-111111111111",
          run_id: "1",
        },
        {
          batch_index: 1,
          is_terminal: true,
          last_event_key: "9",
          after_event_key: "5",
          actor_account_id: "11111111-1111-1111-1111-111111111111",
          run_id: "1",
        },
      ],
    });
    const { POST } = await importRoute();
    const res = await POST(
      makeRequest({
        customer_id: 42,
        run_id: "1",
        send_action_id: VALID_SEND_ACTION,
        after_event_key: "9",
      }),
      ctx,
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "send_already_terminal" });
    expect(mockBuildSlice).not.toHaveBeenCalled();
    expect(mockInsertInflight).not.toHaveBeenCalled();
  });

  it("rejects a build for a send_action_id owned by a different actor (actor_mismatch)", async () => {
    // Prior inflight rows are owned by a different account_id. A
    // session that guesses the send_action_id is rejected before any
    // batch is minted.
    mockClientQuery.mockResolvedValueOnce({
      rows: [
        {
          batch_index: 0,
          is_terminal: false,
          last_event_key: "5",
          after_event_key: null,
          actor_account_id: "99999999-9999-9999-9999-999999999999",
          run_id: "1",
        },
      ],
    });
    const { POST } = await importRoute();
    const res = await POST(
      makeRequest({
        customer_id: 42,
        run_id: "1",
        send_action_id: VALID_SEND_ACTION,
        after_event_key: "5",
      }),
      ctx,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "actor_mismatch" });
    expect(mockBuildSlice).not.toHaveBeenCalled();
    expect(mockInsertInflight).not.toHaveBeenCalled();
  });

  it("rejects malformed after_event_key", async () => {
    const { POST } = await importRoute();
    const res = await POST(
      makeRequest({
        customer_id: 42,
        run_id: "1",
        send_action_id: VALID_SEND_ACTION,
        after_event_key: "not-a-number",
      }),
      ctx,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_after_event_key" });
  });

  it("returns 503 when aimer integration is not configured", async () => {
    mockGetSetup.mockResolvedValueOnce({
      aiceId: null,
      bridgeUrl: null,
      hasActiveSigningKey: false,
    });
    const { POST } = await importRoute();
    const res = await POST(
      makeRequest({
        customer_id: 42,
        run_id: "1",
        send_action_id: VALID_SEND_ACTION,
      }),
      ctx,
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: "aimer_integration_not_configured",
    });
  });

  it("derives batch_index from the chain — last prior batch_index + 1", async () => {
    // Two prior batches; the next batch should be batch_index 2 and
    // its cursor must equal the latest batch's last_event_key ("6").
    // "6" does not match any prior batch's after_event_key (null,
    // "3"), so the duplicate check passes and this is a normal
    // forward step in the chain.
    mockClientQuery.mockResolvedValueOnce({
      rows: [
        {
          batch_index: 0,
          is_terminal: false,
          last_event_key: "3",
          after_event_key: null,
          actor_account_id: "11111111-1111-1111-1111-111111111111",
          run_id: "1",
        },
        {
          batch_index: 1,
          is_terminal: false,
          last_event_key: "6",
          after_event_key: "3",
          actor_account_id: "11111111-1111-1111-1111-111111111111",
          run_id: "1",
        },
      ],
    });
    mockBuildSlice.mockResolvedValueOnce({
      payload: { run: RUN_BODY, events: [{ event_key: "7" }] },
      lastEventKey: "7",
      hasMore: false,
      eventCount: 1,
    });
    const { POST } = await importRoute();
    const res = await POST(
      makeRequest({
        customer_id: 42,
        run_id: "1",
        send_action_id: VALID_SEND_ACTION,
        after_event_key: "6",
      }),
      ctx,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.batch_index).toBe(2);
    expect(mockInsertInflight).toHaveBeenCalledWith(
      42,
      expect.objectContaining({
        batchIndex: 2,
        isTerminal: true,
        afterEventKey: "6",
      }),
    );
  });
});
