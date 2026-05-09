import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRunCadence = vi.hoisted(() => vi.fn());
const mockVerifyToken = vi.hoisted(() => vi.fn());

class MockCustomerNotFoundError extends Error {
  constructor(customerId: number) {
    super(`Customer ${customerId} not found or not active`);
    this.name = "CustomerNotFoundError";
  }
}

vi.mock("@/lib/triage/baseline/cadence", () => ({
  runTriageBaselineCadence: mockRunCadence,
  verifyTriageBaselineCadenceToken: mockVerifyToken,
}));

vi.mock("@/lib/triage/policy/customer-db", () => ({
  CustomerNotFoundError: MockCustomerNotFoundError,
}));

beforeEach(() => {
  mockRunCadence.mockReset();
  mockVerifyToken.mockReset();
});

function makeRequest(authHeader: string | undefined, body: unknown): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (authHeader !== undefined) headers.set("authorization", authHeader);
  return new Request("http://test/api/internal/triage/baseline/cadence", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/internal/triage/baseline/cadence", () => {
  it("returns 401 when no Authorization header is sent", async () => {
    mockVerifyToken.mockReturnValue(false);
    const { POST } = await import(
      "@/app/api/internal/triage/baseline/cadence/route"
    );
    const res = await POST(makeRequest(undefined, { customer_id: 1 }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
    expect(mockVerifyToken).toHaveBeenCalledWith(null);
    expect(mockRunCadence).not.toHaveBeenCalled();
  });

  it("returns 401 when Authorization is not Bearer", async () => {
    mockVerifyToken.mockReturnValue(false);
    const { POST } = await import(
      "@/app/api/internal/triage/baseline/cadence/route"
    );
    const res = await POST(makeRequest("Basic abc", { customer_id: 1 }));
    expect(res.status).toBe(401);
    expect(mockVerifyToken).toHaveBeenCalledWith(null);
  });

  it("returns 401 when bearer token does not verify", async () => {
    mockVerifyToken.mockReturnValue(false);
    const { POST } = await import(
      "@/app/api/internal/triage/baseline/cadence/route"
    );
    const res = await POST(makeRequest("Bearer wrong", { customer_id: 1 }));
    expect(res.status).toBe(401);
    expect(mockVerifyToken).toHaveBeenCalledWith("wrong");
    expect(mockRunCadence).not.toHaveBeenCalled();
  });

  it("returns 400 when body is not valid JSON", async () => {
    mockVerifyToken.mockReturnValue(true);
    const { POST } = await import(
      "@/app/api/internal/triage/baseline/cadence/route"
    );
    const res = await POST(makeRequest("Bearer right", "not json"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid JSON body" });
    expect(mockRunCadence).not.toHaveBeenCalled();
  });

  it("returns 400 when customer_id is missing", async () => {
    mockVerifyToken.mockReturnValue(true);
    const { POST } = await import(
      "@/app/api/internal/triage/baseline/cadence/route"
    );
    const res = await POST(makeRequest("Bearer right", {}));
    expect(res.status).toBe(400);
    expect(mockRunCadence).not.toHaveBeenCalled();
  });

  it("returns 400 when customer_id is not a positive integer", async () => {
    mockVerifyToken.mockReturnValue(true);
    const { POST } = await import(
      "@/app/api/internal/triage/baseline/cadence/route"
    );
    for (const bad of [0, -1, 1.5, "1", null, true]) {
      const res = await POST(makeRequest("Bearer right", { customer_id: bad }));
      expect(res.status).toBe(400);
    }
    expect(mockRunCadence).not.toHaveBeenCalled();
  });

  it("returns 200 with the runner result on success", async () => {
    mockVerifyToken.mockReturnValue(true);
    mockRunCadence.mockResolvedValue({
      customerId: 7,
      status: "ok",
      observedInserted: 0,
      baselineInserted: 0,
      lastEventCursor: null,
    });
    const { POST } = await import(
      "@/app/api/internal/triage/baseline/cadence/route"
    );
    const res = await POST(makeRequest("Bearer right", { customer_id: 7 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      customerId: 7,
      status: "ok",
      observedInserted: 0,
      baselineInserted: 0,
      lastEventCursor: null,
    });
    expect(mockRunCadence).toHaveBeenCalledWith(7);
  });

  it("returns 503 with status=pending when the cadence pager is not yet wired", async () => {
    mockVerifyToken.mockReturnValue(true);
    mockRunCadence.mockResolvedValue({
      customerId: 7,
      status: "pending",
      observedInserted: 0,
      baselineInserted: 0,
      lastEventCursor: null,
    });
    const { POST } = await import(
      "@/app/api/internal/triage/baseline/cadence/route"
    );
    const res = await POST(makeRequest("Bearer right", { customer_id: 7 }));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.status).toBe("pending");
    expect(body.customerId).toBe(7);
  });

  it("returns 200 with status=skipped when the advisory lock was unavailable", async () => {
    mockVerifyToken.mockReturnValue(true);
    mockRunCadence.mockResolvedValue({
      customerId: 7,
      status: "skipped",
      observedInserted: 0,
      baselineInserted: 0,
      lastEventCursor: null,
    });
    const { POST } = await import(
      "@/app/api/internal/triage/baseline/cadence/route"
    );
    const res = await POST(makeRequest("Bearer right", { customer_id: 7 }));
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("skipped");
  });

  it("returns 500 with the structured failure body when the cadence rolls back", async () => {
    mockVerifyToken.mockReturnValue(true);
    mockRunCadence.mockResolvedValue({
      customerId: 7,
      status: "failed",
      observedInserted: 0,
      baselineInserted: 0,
      lastEventCursor: null,
      error: "review unreachable",
    });
    const { POST } = await import(
      "@/app/api/internal/triage/baseline/cadence/route"
    );
    const res = await POST(makeRequest("Bearer right", { customer_id: 7 }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.status).toBe("failed");
    expect(body.error).toBe("review unreachable");
  });

  it("returns 404 when the customer is not active", async () => {
    mockVerifyToken.mockReturnValue(true);
    mockRunCadence.mockRejectedValue(new MockCustomerNotFoundError(404));
    const { POST } = await import(
      "@/app/api/internal/triage/baseline/cadence/route"
    );
    const res = await POST(makeRequest("Bearer right", { customer_id: 404 }));
    expect(res.status).toBe(404);
  });

  it("returns 500 when the runner throws an unexpected error", async () => {
    mockVerifyToken.mockReturnValue(true);
    mockRunCadence.mockRejectedValue(new Error("DB exploded"));
    const { POST } = await import(
      "@/app/api/internal/triage/baseline/cadence/route"
    );
    const res = await POST(makeRequest("Bearer right", { customer_id: 7 }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "DB exploded" });
  });
});
