import { beforeEach, describe, expect, it, vi } from "vitest";

const mockApplyRecover = vi.hoisted(() => vi.fn());
const mockEmitRecoverAudit = vi.hoisted(() => vi.fn());
const mockVerifyToken = vi.hoisted(() => vi.fn());

vi.mock("@/lib/triage/exclusion/recovery", () => ({
  applyRecover: mockApplyRecover,
  emitRecoverAudit: mockEmitRecoverAudit,
  verifyTriageExclusionRecoveryToken: mockVerifyToken,
}));

beforeEach(() => {
  mockApplyRecover.mockReset();
  mockEmitRecoverAudit.mockReset().mockResolvedValue(undefined);
  mockVerifyToken.mockReset();
});

function makeRequest(body: unknown, authHeader = "Bearer right"): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (authHeader !== undefined) headers.set("authorization", authHeader);
  return new Request("http://test/api/internal/triage/exclusion/recover", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("POST /api/internal/triage/exclusion/recover", () => {
  it("returns 401 when token mismatches", async () => {
    mockVerifyToken.mockReturnValue(false);
    const { POST } = await import(
      "@/app/api/internal/triage/exclusion/recover/route"
    );
    const res = await POST(
      makeRequest({ kind: "global_all_failed", exclusion_id: "x" }),
    );
    expect(res.status).toBe(401);
    expect(mockApplyRecover).not.toHaveBeenCalled();
  });

  it("returns 400 when the body is not valid JSON", async () => {
    mockVerifyToken.mockReturnValue(true);
    const { POST } = await import(
      "@/app/api/internal/triage/exclusion/recover/route"
    );
    const req = new Request(
      "http://test/api/internal/triage/exclusion/recover",
      {
        method: "POST",
        headers: {
          authorization: "Bearer right",
          "content-type": "application/json",
        },
        body: "not-json",
      },
    );
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("returns 400 when kind is missing", async () => {
    mockVerifyToken.mockReturnValue(true);
    const { POST } = await import(
      "@/app/api/internal/triage/exclusion/recover/route"
    );
    const res = await POST(makeRequest({ exclusion_id: "x" }));
    expect(res.status).toBe(400);
    expect(mockApplyRecover).not.toHaveBeenCalled();
  });

  it("returns 400 when exclusion_id is missing or empty", async () => {
    mockVerifyToken.mockReturnValue(true);
    const { POST } = await import(
      "@/app/api/internal/triage/exclusion/recover/route"
    );
    const res = await POST(
      makeRequest({ kind: "global", exclusion_id: "", customer_id: 1 }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when kind='global' is missing customer_id (no implicit sweep)", async () => {
    mockVerifyToken.mockReturnValue(true);
    const { POST } = await import(
      "@/app/api/internal/triage/exclusion/recover/route"
    );
    const res = await POST(makeRequest({ kind: "global", exclusion_id: "x" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/customer_id/);
    expect(mockApplyRecover).not.toHaveBeenCalled();
  });

  it("returns 400 when kind='customer' is missing customer_id", async () => {
    mockVerifyToken.mockReturnValue(true);
    const { POST } = await import(
      "@/app/api/internal/triage/exclusion/recover/route"
    );
    const res = await POST(
      makeRequest({ kind: "customer", exclusion_id: "x" }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when customer_id is not a positive integer", async () => {
    mockVerifyToken.mockReturnValue(true);
    const { POST } = await import(
      "@/app/api/internal/triage/exclusion/recover/route"
    );
    const res = await POST(
      makeRequest({ kind: "global", exclusion_id: "x", customer_id: -1 }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when kind is unknown", async () => {
    mockVerifyToken.mockReturnValue(true);
    const { POST } = await import(
      "@/app/api/internal/triage/exclusion/recover/route"
    );
    const res = await POST(
      makeRequest({ kind: "everything", exclusion_id: "x" }),
    );
    expect(res.status).toBe(400);
  });

  it("dispatches kind='global' with customer_id to applyRecover and audits as system", async () => {
    mockVerifyToken.mockReturnValue(true);
    mockApplyRecover.mockResolvedValue({ reset: 1, kind: "global" });
    const { POST } = await import(
      "@/app/api/internal/triage/exclusion/recover/route"
    );
    const res = await POST(
      makeRequest({ kind: "global", exclusion_id: "g-1", customer_id: 7 }),
    );
    expect(res.status).toBe(200);
    expect(mockApplyRecover).toHaveBeenCalledWith({
      kind: "global",
      exclusionId: "g-1",
      customerId: 7,
    });
    expect(mockEmitRecoverAudit).toHaveBeenCalledWith(
      { kind: "global", exclusionId: "g-1", customerId: 7 },
      "system",
      1,
    );
  });

  it("dispatches kind='global_all_failed' without customer_id", async () => {
    mockVerifyToken.mockReturnValue(true);
    mockApplyRecover.mockResolvedValue({ reset: 5, kind: "global_all_failed" });
    const { POST } = await import(
      "@/app/api/internal/triage/exclusion/recover/route"
    );
    const res = await POST(
      makeRequest({ kind: "global_all_failed", exclusion_id: "g-1" }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reset).toBe(5);
    expect(mockApplyRecover).toHaveBeenCalledWith({
      kind: "global_all_failed",
      exclusionId: "g-1",
    });
  });

  it("returns 500 when applyRecover throws", async () => {
    mockVerifyToken.mockReturnValue(true);
    mockApplyRecover.mockRejectedValue(new Error("queue is down"));
    const { POST } = await import(
      "@/app/api/internal/triage/exclusion/recover/route"
    );
    const res = await POST(
      makeRequest({ kind: "global_all_failed", exclusion_id: "g-1" }),
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain("queue is down");
  });
});
