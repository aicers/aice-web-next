import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRunBackfill = vi.hoisted(() => vi.fn());
const mockVerifyToken = vi.hoisted(() => vi.fn());

class MockCustomerNotFoundError extends Error {
  constructor(customerId: number) {
    super(`Customer ${customerId} not found or not active`);
    this.name = "CustomerNotFoundError";
  }
}

class MockPhase2BackfillMultiVersionError extends Error {
  readonly baselineVersions: string[];
  constructor(versions: string[]) {
    super(`Backfill window spans ${versions.length} baseline_versions`);
    this.name = "Phase2BackfillMultiVersionError";
    this.baselineVersions = versions;
  }
}

vi.mock("@/lib/aimer/phase2/backfill", () => ({
  runPhase2Backfill: mockRunBackfill,
  verifyPhase2BackfillToken: mockVerifyToken,
  Phase2BackfillMultiVersionError: MockPhase2BackfillMultiVersionError,
}));

vi.mock("@/lib/triage/policy/customer-db", () => ({
  CustomerNotFoundError: MockCustomerNotFoundError,
}));

beforeEach(() => {
  mockRunBackfill.mockReset();
  mockVerifyToken.mockReset();
});

const FROM = "2026-05-01T00:00:00Z";
const TO = "2026-05-08T00:00:00Z";

function makeRequest(authHeader: string | undefined, body: unknown): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (authHeader !== undefined) headers.set("authorization", authHeader);
  return new Request("http://test/api/internal/aimer/phase2/backfill", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/internal/aimer/phase2/backfill", () => {
  it("returns 401 when no Authorization header is sent", async () => {
    mockVerifyToken.mockReturnValue(false);
    const { POST } = await import(
      "@/app/api/internal/aimer/phase2/backfill/route"
    );
    const res = await POST(
      makeRequest(undefined, {
        customer_id: 1,
        kind: "baseline_event",
        from: FROM,
        to: TO,
      }),
    );
    expect(res.status).toBe(401);
    expect(mockVerifyToken).toHaveBeenCalledWith(null);
    expect(mockRunBackfill).not.toHaveBeenCalled();
  });

  it("returns 401 when bearer token does not verify", async () => {
    mockVerifyToken.mockReturnValue(false);
    const { POST } = await import(
      "@/app/api/internal/aimer/phase2/backfill/route"
    );
    const res = await POST(
      makeRequest("Bearer wrong", {
        customer_id: 1,
        kind: "story",
        from: FROM,
        to: TO,
      }),
    );
    expect(res.status).toBe(401);
    expect(mockVerifyToken).toHaveBeenCalledWith("wrong");
  });

  it("returns 400 on invalid JSON", async () => {
    mockVerifyToken.mockReturnValue(true);
    const { POST } = await import(
      "@/app/api/internal/aimer/phase2/backfill/route"
    );
    const res = await POST(makeRequest("Bearer ok", "not json"));
    expect(res.status).toBe(400);
  });

  it("returns 400 on missing / unknown kind", async () => {
    mockVerifyToken.mockReturnValue(true);
    const { POST } = await import(
      "@/app/api/internal/aimer/phase2/backfill/route"
    );
    for (const bad of [undefined, "", "unknown_kind", 123, null]) {
      const res = await POST(
        makeRequest("Bearer ok", {
          customer_id: 1,
          kind: bad,
          from: FROM,
          to: TO,
        }),
      );
      expect(res.status).toBe(400);
    }
  });

  it("returns 400 on inverted / empty window", async () => {
    mockVerifyToken.mockReturnValue(true);
    const { POST } = await import(
      "@/app/api/internal/aimer/phase2/backfill/route"
    );
    const res = await POST(
      makeRequest("Bearer ok", {
        customer_id: 1,
        kind: "baseline_event",
        from: TO,
        to: FROM,
      }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 200 with the enqueued_notice_ids on success", async () => {
    mockVerifyToken.mockReturnValue(true);
    mockRunBackfill.mockResolvedValue({
      enqueuedNoticeIds: ["1", "2", "3"],
    });
    const { POST } = await import(
      "@/app/api/internal/aimer/phase2/backfill/route"
    );
    const res = await POST(
      makeRequest("Bearer ok", {
        customer_id: 7,
        kind: "baseline_event",
        from: FROM,
        to: TO,
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      enqueued_notice_ids: ["1", "2", "3"],
    });
    expect(mockRunBackfill).toHaveBeenCalledWith({
      customerId: 7,
      kind: "baseline_event",
      fromIso: FROM,
      toIso: TO,
    });
  });

  it("returns 404 when the customer is not active", async () => {
    mockVerifyToken.mockReturnValue(true);
    mockRunBackfill.mockRejectedValue(new MockCustomerNotFoundError(404));
    const { POST } = await import(
      "@/app/api/internal/aimer/phase2/backfill/route"
    );
    const res = await POST(
      makeRequest("Bearer ok", {
        customer_id: 404,
        kind: "story",
        from: FROM,
        to: TO,
      }),
    );
    expect(res.status).toBe(404);
  });

  it("returns 400 when the window extends into the future", async () => {
    mockVerifyToken.mockReturnValue(true);
    const { POST } = await import(
      "@/app/api/internal/aimer/phase2/backfill/route"
    );
    const futureTo = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const res = await POST(
      makeRequest("Bearer ok", {
        customer_id: 1,
        kind: "baseline_event",
        from: FROM,
        to: futureTo,
      }),
    );
    expect(res.status).toBe(400);
    expect(mockRunBackfill).not.toHaveBeenCalled();
  });

  it("returns 400 when from is older than the allowed retention bound", async () => {
    mockVerifyToken.mockReturnValue(true);
    const { POST } = await import(
      "@/app/api/internal/aimer/phase2/backfill/route"
    );
    // Past the 180-day baseline retention bound. A `from` 200 days back
    // is solidly outside the retained corpus, so the route must reject
    // before calling into `runPhase2Backfill`.
    const ancientFrom = new Date(
      Date.now() - 200 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const ancientTo = new Date(
      Date.now() - 199 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const res = await POST(
      makeRequest("Bearer ok", {
        customer_id: 1,
        kind: "baseline_event",
        from: ancientFrom,
        to: ancientTo,
      }),
    );
    expect(res.status).toBe(400);
    expect(mockRunBackfill).not.toHaveBeenCalled();
  });

  it("accepts a from within the 180-day baseline retention bound", async () => {
    mockVerifyToken.mockReturnValue(true);
    mockRunBackfill.mockResolvedValue({ enqueuedNoticeIds: ["1"] });
    const { POST } = await import(
      "@/app/api/internal/aimer/phase2/backfill/route"
    );
    // Just inside the bound (179 days back) — must NOT be rejected.
    const recentFrom = new Date(
      Date.now() - 179 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const recentTo = new Date(
      Date.now() - 178 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const res = await POST(
      makeRequest("Bearer ok", {
        customer_id: 1,
        kind: "baseline_event",
        from: recentFrom,
        to: recentTo,
      }),
    );
    expect(res.status).toBe(200);
    expect(mockRunBackfill).toHaveBeenCalled();
  });

  it("returns 400 when the backfill spans multiple baseline_versions", async () => {
    mockVerifyToken.mockReturnValue(true);
    mockRunBackfill.mockRejectedValue(
      new MockPhase2BackfillMultiVersionError(["v1", "v2"]),
    );
    const { POST } = await import(
      "@/app/api/internal/aimer/phase2/backfill/route"
    );
    const res = await POST(
      makeRequest("Bearer ok", {
        customer_id: 7,
        kind: "baseline_event",
        from: FROM,
        to: TO,
      }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 500 on unexpected errors", async () => {
    mockVerifyToken.mockReturnValue(true);
    mockRunBackfill.mockRejectedValue(new Error("DB exploded"));
    const { POST } = await import(
      "@/app/api/internal/aimer/phase2/backfill/route"
    );
    const res = await POST(
      makeRequest("Bearer ok", {
        customer_id: 7,
        kind: "baseline_event",
        from: FROM,
        to: TO,
      }),
    );
    expect(res.status).toBe(500);
  });
});
