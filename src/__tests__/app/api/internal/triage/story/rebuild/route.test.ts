import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRunStoryRebuild = vi.hoisted(() => vi.fn());
const mockVerifyToken = vi.hoisted(() => vi.fn());

class MockCustomerNotFoundError extends Error {
  constructor(customerId: number) {
    super(`Customer ${customerId} not found or not active`);
    this.name = "CustomerNotFoundError";
  }
}

class MockStoryRebuildBusyError extends Error {
  constructor() {
    super("busy");
    this.name = "StoryRebuildBusyError";
  }
}

class MockStoryRebuildInvalidRangeError extends Error {
  constructor() {
    super("invalid range");
    this.name = "StoryRebuildInvalidRangeError";
  }
}

vi.mock("@/lib/triage/story/rebuild", () => ({
  runStoryRebuild: mockRunStoryRebuild,
  verifyTriageStoryRebuildToken: mockVerifyToken,
  StoryRebuildBusyError: MockStoryRebuildBusyError,
  StoryRebuildInvalidRangeError: MockStoryRebuildInvalidRangeError,
}));

vi.mock("@/lib/triage/policy/customer-db", () => ({
  CustomerNotFoundError: MockCustomerNotFoundError,
}));

beforeEach(() => {
  mockRunStoryRebuild.mockReset();
  mockVerifyToken.mockReset();
});

const FROM = "2026-05-01T00:00:00Z";
const TO = "2026-05-08T00:00:00Z";

function makeRequest(authHeader: string | undefined, body: unknown): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (authHeader !== undefined) headers.set("authorization", authHeader);
  return new Request("http://test/api/internal/triage/story/rebuild", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/internal/triage/story/rebuild", () => {
  it("returns 401 when no Authorization header is sent", async () => {
    mockVerifyToken.mockReturnValue(false);
    const { POST } = await import(
      "@/app/api/internal/triage/story/rebuild/route"
    );
    const res = await POST(
      makeRequest(undefined, { customer_id: 1, from: FROM, to: TO }),
    );
    expect(res.status).toBe(401);
    expect(mockVerifyToken).toHaveBeenCalledWith(null);
    expect(mockRunStoryRebuild).not.toHaveBeenCalled();
  });

  it("returns 401 when bearer token does not verify", async () => {
    mockVerifyToken.mockReturnValue(false);
    const { POST } = await import(
      "@/app/api/internal/triage/story/rebuild/route"
    );
    const res = await POST(
      makeRequest("Bearer wrong", { customer_id: 1, from: FROM, to: TO }),
    );
    expect(res.status).toBe(401);
    expect(mockVerifyToken).toHaveBeenCalledWith("wrong");
  });

  it("returns 400 when the body is not valid JSON", async () => {
    mockVerifyToken.mockReturnValue(true);
    const { POST } = await import(
      "@/app/api/internal/triage/story/rebuild/route"
    );
    const res = await POST(makeRequest("Bearer ok", "not json"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid JSON body" });
  });

  it("returns 400 when customer_id is missing or invalid", async () => {
    mockVerifyToken.mockReturnValue(true);
    const { POST } = await import(
      "@/app/api/internal/triage/story/rebuild/route"
    );
    for (const bad of [0, -1, 1.5, "1", null, true]) {
      const res = await POST(
        makeRequest("Bearer ok", { customer_id: bad, from: FROM, to: TO }),
      );
      expect(res.status).toBe(400);
    }
    expect(mockRunStoryRebuild).not.toHaveBeenCalled();
  });

  it("returns 400 when from or to is missing / invalid", async () => {
    mockVerifyToken.mockReturnValue(true);
    const { POST } = await import(
      "@/app/api/internal/triage/story/rebuild/route"
    );
    const bodies: unknown[] = [
      { customer_id: 1, from: FROM },
      { customer_id: 1, to: TO },
      { customer_id: 1, from: "not-a-date", to: TO },
      { customer_id: 1, from: FROM, to: "not-a-date" },
      // from == to (empty range)
      { customer_id: 1, from: FROM, to: FROM },
      // from > to (inverted)
      { customer_id: 1, from: TO, to: FROM },
    ];
    for (const body of bodies) {
      const res = await POST(makeRequest("Bearer ok", body));
      expect(res.status).toBe(400);
    }
    expect(mockRunStoryRebuild).not.toHaveBeenCalled();
  });

  it("returns 200 with the runner result on success", async () => {
    mockVerifyToken.mockReturnValue(true);
    mockRunStoryRebuild.mockResolvedValue({
      deletedAutoStories: 4,
      insertedAutoStories: 5,
      skippedCuratedStories: 2,
      betaCarriedOver: 3,
      durationMs: 42,
      warnings: [],
    });
    const { POST } = await import(
      "@/app/api/internal/triage/story/rebuild/route"
    );
    const res = await POST(
      makeRequest("Bearer ok", { customer_id: 7, from: FROM, to: TO }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      deletedAutoStories: 4,
      insertedAutoStories: 5,
      skippedCuratedStories: 2,
      betaCarriedOver: 3,
      durationMs: 42,
      warnings: [],
    });
    expect(mockRunStoryRebuild).toHaveBeenCalledWith({
      customerId: 7,
      fromIso: FROM,
      toIso: TO,
    });
  });

  it("returns 409 on StoryRebuildBusyError", async () => {
    mockVerifyToken.mockReturnValue(true);
    mockRunStoryRebuild.mockRejectedValue(new MockStoryRebuildBusyError());
    const { POST } = await import(
      "@/app/api/internal/triage/story/rebuild/route"
    );
    const res = await POST(
      makeRequest("Bearer ok", { customer_id: 7, from: FROM, to: TO }),
    );
    expect(res.status).toBe(409);
  });

  it("returns 400 on StoryRebuildInvalidRangeError from the service", async () => {
    mockVerifyToken.mockReturnValue(true);
    mockRunStoryRebuild.mockRejectedValue(
      new MockStoryRebuildInvalidRangeError(),
    );
    const { POST } = await import(
      "@/app/api/internal/triage/story/rebuild/route"
    );
    const res = await POST(
      makeRequest("Bearer ok", { customer_id: 7, from: FROM, to: TO }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 when the customer is not active", async () => {
    mockVerifyToken.mockReturnValue(true);
    mockRunStoryRebuild.mockRejectedValue(new MockCustomerNotFoundError(404));
    const { POST } = await import(
      "@/app/api/internal/triage/story/rebuild/route"
    );
    const res = await POST(
      makeRequest("Bearer ok", { customer_id: 404, from: FROM, to: TO }),
    );
    expect(res.status).toBe(404);
  });

  it("returns 500 on unexpected errors", async () => {
    mockVerifyToken.mockReturnValue(true);
    mockRunStoryRebuild.mockRejectedValue(new Error("DB exploded"));
    const { POST } = await import(
      "@/app/api/internal/triage/story/rebuild/route"
    );
    const res = await POST(
      makeRequest("Bearer ok", { customer_id: 7, from: FROM, to: TO }),
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "DB exploded" });
  });
});
