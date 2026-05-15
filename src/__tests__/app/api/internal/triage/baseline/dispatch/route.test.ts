import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRunDispatch = vi.hoisted(() => vi.fn());
const mockVerifyToken = vi.hoisted(() => vi.fn());
const mockCreateCadencePager = vi.hoisted(() =>
  vi.fn(() => ({ ingestPage: vi.fn() })),
);
const mockStorageResolver = vi.hoisted(() => ({
  resolve: vi.fn(),
}));

vi.mock("@/lib/triage/baseline/cadence", () => ({
  verifyTriageBaselineCadenceToken: mockVerifyToken,
}));

vi.mock("@/lib/triage/baseline/dispatcher", () => ({
  runTriageBaselineDispatch: mockRunDispatch,
}));

vi.mock("@/lib/triage/baseline/pager", () => ({
  // The route handler instantiates the production pager once per
  // process; the mock observes the options so route tests can assert
  // the storage-backed resolver was forwarded (#472 Round 2).
  createCadencePager: mockCreateCadencePager,
}));

vi.mock("@/lib/triage/exclusion/active-set-storage", () => ({
  STORAGE_EXCLUSION_SET_RESOLVER: mockStorageResolver,
}));

beforeEach(() => {
  mockRunDispatch.mockReset();
  mockVerifyToken.mockReset();
});

function makeRequest(authHeader?: string): Request {
  const headers = new Headers();
  if (authHeader !== undefined) headers.set("authorization", authHeader);
  return new Request("http://test/api/internal/triage/baseline/dispatch", {
    method: "POST",
    headers,
  });
}

describe("POST /api/internal/triage/baseline/dispatch", () => {
  it("returns 401 when the bearer token does not verify", async () => {
    mockVerifyToken.mockReturnValue(false);
    const { POST } = await import(
      "@/app/api/internal/triage/baseline/dispatch/route"
    );
    const res = await POST(makeRequest("Bearer wrong"));
    expect(res.status).toBe(401);
    expect(mockRunDispatch).not.toHaveBeenCalled();
  });

  it("returns 200 with the dispatcher result on overall=ok", async () => {
    mockVerifyToken.mockReturnValue(true);
    mockRunDispatch.mockResolvedValue({
      overall: "ok",
      perCustomer: [
        {
          customerId: 1,
          status: "ok",
          observedInserted: 5,
          baselineInserted: 1,
          lastEventCursor: "c1",
        },
      ],
    });
    const { POST } = await import(
      "@/app/api/internal/triage/baseline/dispatch/route"
    );
    const res = await POST(makeRequest("Bearer right"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.overall).toBe("ok");
    expect(body.perCustomer).toHaveLength(1);
  });

  it("returns 200 with overall=partial when at least one customer failed", async () => {
    mockVerifyToken.mockReturnValue(true);
    mockRunDispatch.mockResolvedValue({
      overall: "partial",
      perCustomer: [
        {
          customerId: 1,
          status: "ok",
          observedInserted: 0,
          baselineInserted: 0,
          lastEventCursor: null,
        },
        {
          customerId: 2,
          status: "failed",
          observedInserted: 0,
          baselineInserted: 0,
          lastEventCursor: null,
          error: "review timeout",
        },
      ],
    });
    const { POST } = await import(
      "@/app/api/internal/triage/baseline/dispatch/route"
    );
    const res = await POST(makeRequest("Bearer right"));
    // Per #487: per-customer failures are reflected in the body, not
    // the HTTP status. Cron retry decisions stay centralised.
    expect(res.status).toBe(200);
    expect((await res.json()).overall).toBe("partial");
  });

  it("returns 500 with overall=failed only on dispatcher self-failure", async () => {
    mockVerifyToken.mockReturnValue(true);
    mockRunDispatch.mockRejectedValue(new Error("enumeration failed"));
    const { POST } = await import(
      "@/app/api/internal/triage/baseline/dispatch/route"
    );
    const res = await POST(makeRequest("Bearer right"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.overall).toBe("failed");
    expect(body.error).toBe("enumeration failed");
  });

  it("constructs the production pager with the storage-backed resolver (#472 Round 2)", async () => {
    // Round-2 review: the dispatched (hourly cron) corpus A path must
    // NOT default to EMPTY_EXCLUSION_SET_RESOLVER. Otherwise the
    // scheduled run records an empty `exclusion_snapshot` and the
    // resulting `baseline_triaged_event.exclusions_fp` references the
    // empty set, breaking #472's audit invariant and admitting events
    // that should have been excluded.
    mockCreateCadencePager.mockClear();
    mockVerifyToken.mockReturnValue(true);
    mockRunDispatch.mockResolvedValue({ overall: "ok", perCustomer: [] });
    // Reset module cache so the lazy `CACHED_PAGER` constructor fires.
    vi.resetModules();
    const { POST } = await import(
      "@/app/api/internal/triage/baseline/dispatch/route"
    );
    await POST(makeRequest("Bearer right"));
    expect(mockCreateCadencePager).toHaveBeenCalledWith(
      expect.objectContaining({ resolver: mockStorageResolver }),
    );
  });
});
