import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRunCleanup = vi.hoisted(() => vi.fn());
const mockVerifyToken = vi.hoisted(() => vi.fn());

vi.mock("@/lib/node/apply-attempt-cleanup", () => ({
  runApplyAttemptCleanup: mockRunCleanup,
  verifyInternalCleanupToken: mockVerifyToken,
}));

beforeEach(() => {
  mockRunCleanup.mockReset();
  mockVerifyToken.mockReset();
});

function makeRequest(authHeader?: string): Request {
  const headers = new Headers();
  if (authHeader !== undefined) headers.set("authorization", authHeader);
  return new Request("http://test/api/internal/apply-attempts/cleanup", {
    method: "POST",
    headers,
  });
}

describe("POST /api/internal/apply-attempts/cleanup", () => {
  it("rejects with 401 when no Authorization header is sent", async () => {
    mockVerifyToken.mockReturnValue(false);
    const { POST } = await import(
      "@/app/api/internal/apply-attempts/cleanup/route"
    );
    const res = await POST(makeRequest());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
    expect(mockVerifyToken).toHaveBeenCalledWith(null);
    expect(mockRunCleanup).not.toHaveBeenCalled();
  });

  it("rejects with 401 when the Authorization header is not a Bearer token", async () => {
    mockVerifyToken.mockReturnValue(false);
    const { POST } = await import(
      "@/app/api/internal/apply-attempts/cleanup/route"
    );
    const res = await POST(makeRequest("Basic abc"));
    expect(res.status).toBe(401);
    expect(mockVerifyToken).toHaveBeenCalledWith(null);
    expect(mockRunCleanup).not.toHaveBeenCalled();
  });

  it("rejects with 401 when the bearer token does not verify", async () => {
    mockVerifyToken.mockReturnValue(false);
    const { POST } = await import(
      "@/app/api/internal/apply-attempts/cleanup/route"
    );
    const res = await POST(makeRequest("Bearer wrong-token"));
    expect(res.status).toBe(401);
    expect(mockVerifyToken).toHaveBeenCalledWith("wrong-token");
    expect(mockRunCleanup).not.toHaveBeenCalled();
  });

  it("returns 200 with the per-sweep counts when the bearer token verifies", async () => {
    mockVerifyToken.mockReturnValue(true);
    mockRunCleanup.mockResolvedValue({
      recovered: 1,
      expired: 2,
      purged: 3,
      auditsRecovered: 4,
    });
    const { POST } = await import(
      "@/app/api/internal/apply-attempts/cleanup/route"
    );
    const res = await POST(makeRequest("Bearer right-token"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      recovered: 1,
      expired: 2,
      purged: 3,
      auditsRecovered: 4,
    });
    expect(mockVerifyToken).toHaveBeenCalledWith("right-token");
    expect(mockRunCleanup).toHaveBeenCalledTimes(1);
  });

  it("trims whitespace around the bearer value before verifying", async () => {
    mockVerifyToken.mockReturnValue(true);
    mockRunCleanup.mockResolvedValue({
      recovered: 0,
      expired: 0,
      purged: 0,
      auditsRecovered: 0,
    });
    const { POST } = await import(
      "@/app/api/internal/apply-attempts/cleanup/route"
    );
    const res = await POST(makeRequest("Bearer    spaced-token   "));
    expect(res.status).toBe(200);
    expect(mockVerifyToken).toHaveBeenCalledWith("spaced-token");
  });

  it("returns 500 when the helper throws (after auth)", async () => {
    mockVerifyToken.mockReturnValue(true);
    mockRunCleanup.mockRejectedValue(new Error("DB exploded"));
    const { POST } = await import(
      "@/app/api/internal/apply-attempts/cleanup/route"
    );
    const res = await POST(makeRequest("Bearer right-token"));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "DB exploded" });
  });
});
