import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRunDispatch = vi.hoisted(() => vi.fn());
const mockVerifyToken = vi.hoisted(() => vi.fn());

vi.mock("@/lib/aimer/phase2/manual-mint-retention", () => ({
  runManualMintRetentionDispatch: mockRunDispatch,
  verifyAimerPhase2ManualMintRetentionToken: mockVerifyToken,
}));

beforeEach(() => {
  mockRunDispatch.mockReset();
  mockVerifyToken.mockReset();
});

function makeRequest(authHeader?: string): Request {
  const headers = new Headers();
  if (authHeader !== undefined) headers.set("authorization", authHeader);
  return new Request(
    "http://test/api/internal/aimer/phase2/manual-mint/retention",
    {
      method: "POST",
      headers,
    },
  );
}

describe("POST /api/internal/aimer/phase2/manual-mint/retention", () => {
  it("returns 401 when the bearer token does not verify", async () => {
    mockVerifyToken.mockReturnValue(false);
    const { POST } = await import(
      "@/app/api/internal/aimer/phase2/manual-mint/retention/route"
    );
    const res = await POST(makeRequest("Bearer wrong"));
    expect(res.status).toBe(401);
    expect(mockRunDispatch).not.toHaveBeenCalled();
  });

  it("returns 401 when the authorization header is missing", async () => {
    mockVerifyToken.mockReturnValue(false);
    const { POST } = await import(
      "@/app/api/internal/aimer/phase2/manual-mint/retention/route"
    );
    const res = await POST(makeRequest());
    expect(res.status).toBe(401);
    expect(mockVerifyToken).toHaveBeenCalledWith(null);
  });

  it("returns 200 with the dispatcher result on overall=ok", async () => {
    mockVerifyToken.mockReturnValue(true);
    mockRunDispatch.mockResolvedValue({
      overall: "ok",
      perCustomer: [{ customerId: 1, status: "ok", counts: { pruned: 3 } }],
    });
    const { POST } = await import(
      "@/app/api/internal/aimer/phase2/manual-mint/retention/route"
    );
    const res = await POST(makeRequest("Bearer right"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.overall).toBe("ok");
    expect(body.perCustomer).toHaveLength(1);
    expect(body.perCustomer[0].counts.pruned).toBe(3);
  });

  it("returns 200 with overall=partial when at least one customer failed", async () => {
    mockVerifyToken.mockReturnValue(true);
    mockRunDispatch.mockResolvedValue({
      overall: "partial",
      perCustomer: [
        { customerId: 1, status: "ok", counts: { pruned: 0 } },
        {
          customerId: 2,
          status: "failed",
          counts: { pruned: 0 },
          error: "tenant 2 unreachable",
        },
      ],
    });
    const { POST } = await import(
      "@/app/api/internal/aimer/phase2/manual-mint/retention/route"
    );
    const res = await POST(makeRequest("Bearer right"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.overall).toBe("partial");
  });

  it("returns 500 when the dispatcher itself throws", async () => {
    mockVerifyToken.mockReturnValue(true);
    mockRunDispatch.mockRejectedValue(new Error("auth_db unreachable"));
    const { POST } = await import(
      "@/app/api/internal/aimer/phase2/manual-mint/retention/route"
    );
    const res = await POST(makeRequest("Bearer right"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.overall).toBe("failed");
    expect(body.error).toContain("auth_db unreachable");
  });
});
