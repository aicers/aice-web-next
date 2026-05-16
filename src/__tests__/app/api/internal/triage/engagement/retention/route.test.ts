import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRunDispatch = vi.hoisted(() => vi.fn());
const mockVerifyToken = vi.hoisted(() => vi.fn());

vi.mock("@/lib/triage/engagement/retention", () => ({
  runEngagementRetentionDispatch: mockRunDispatch,
  verifyTriageEngagementRetentionToken: mockVerifyToken,
}));

beforeEach(() => {
  mockRunDispatch.mockReset();
  mockVerifyToken.mockReset();
});

function makeRequest(authHeader?: string): Request {
  const headers = new Headers();
  if (authHeader !== undefined) headers.set("authorization", authHeader);
  return new Request("http://test/api/internal/triage/engagement/retention", {
    method: "POST",
    headers,
  });
}

describe("POST /api/internal/triage/engagement/retention", () => {
  it("returns 401 when the bearer token does not verify", async () => {
    mockVerifyToken.mockReturnValue(false);
    const { POST } = await import(
      "@/app/api/internal/triage/engagement/retention/route"
    );
    const res = await POST(makeRequest("Bearer wrong"));
    expect(res.status).toBe(401);
    expect(mockRunDispatch).not.toHaveBeenCalled();
  });

  it("returns 401 when the Authorization header is missing entirely", async () => {
    mockVerifyToken.mockReturnValue(false);
    const { POST } = await import(
      "@/app/api/internal/triage/engagement/retention/route"
    );
    const res = await POST(makeRequest());
    expect(res.status).toBe(401);
    expect(mockVerifyToken).toHaveBeenCalledWith(null);
  });

  it("returns 200 with dispatcher result on overall=ok", async () => {
    mockVerifyToken.mockReturnValue(true);
    mockRunDispatch.mockResolvedValue({
      overall: "ok",
      perCustomer: [
        {
          customerId: 1,
          status: "ok",
          counts: { engagementImpression: 12, engagementAction: 4 },
        },
      ],
    });
    const { POST } = await import(
      "@/app/api/internal/triage/engagement/retention/route"
    );
    const res = await POST(makeRequest("Bearer right"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.overall).toBe("ok");
    expect(body.perCustomer[0].counts.engagementImpression).toBe(12);
  });

  it("returns 200 with overall=partial when a per-customer sweep fails", async () => {
    mockVerifyToken.mockReturnValue(true);
    mockRunDispatch.mockResolvedValue({
      overall: "partial",
      perCustomer: [
        {
          customerId: 1,
          status: "failed",
          counts: { engagementImpression: 0, engagementAction: 0 },
          error: "boom",
        },
      ],
    });
    const { POST } = await import(
      "@/app/api/internal/triage/engagement/retention/route"
    );
    const res = await POST(makeRequest("Bearer right"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.overall).toBe("partial");
  });

  it("returns 500 when the dispatcher itself throws", async () => {
    mockVerifyToken.mockReturnValue(true);
    mockRunDispatch.mockRejectedValue(new Error("auth_db down"));
    const { POST } = await import(
      "@/app/api/internal/triage/engagement/retention/route"
    );
    const res = await POST(makeRequest("Bearer right"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.overall).toBe("failed");
    expect(body.error).toContain("auth_db down");
  });
});
