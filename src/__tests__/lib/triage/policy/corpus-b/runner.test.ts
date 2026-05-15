import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetCustomerPool = vi.hoisted(() => vi.fn());
const mockFindActiveRun = vi.hoisted(() => vi.fn());
const mockInsertComputingRun = vi.hoisted(() => vi.fn());
const mockRecomputeRun = vi.hoisted(() => vi.fn());
const mockInsertTriagedEventsBatch = vi.hoisted(() => vi.fn());
const mockMarkRunReadyOnClient = vi.hoisted(() => vi.fn());
const mockMarkRunFailed = vi.hoisted(() => vi.fn());
const mockGetRunById = vi.hoisted(() => vi.fn());

vi.mock("@/lib/triage/policy/customer-db", () => ({
  getCustomerPool: mockGetCustomerPool,
}));

vi.mock("@/lib/triage/policy/corpus-b/repository", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/triage/policy/corpus-b/repository")
  >("@/lib/triage/policy/corpus-b/repository");
  return {
    ...actual,
    findActiveRun: mockFindActiveRun,
    insertComputingRun: mockInsertComputingRun,
    recomputeRun: mockRecomputeRun,
    insertTriagedEventsBatch: mockInsertTriagedEventsBatch,
    markRunReadyOnClient: mockMarkRunReadyOnClient,
    markRunFailed: mockMarkRunFailed,
    getRunById: mockGetRunById,
  };
});

interface FakePoolClient {
  query: ReturnType<typeof vi.fn>;
  release: () => void;
}

function buildFakePool(): {
  pool: {
    connect: () => Promise<FakePoolClient>;
    query: ReturnType<typeof vi.fn>;
  };
  client: FakePoolClient;
} {
  const client: FakePoolClient = {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    release: () => undefined,
  };
  // #472: the corpus B runner records condition snapshots through the
  // pool (not the client) before claiming the run slot, so the fake
  // pool needs a `query` method even for tests that never hand events
  // to the page loop.
  const pool = {
    connect: async () => client,
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  };
  return { pool, client };
}

const buildRun = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: "1",
  ownerAccountId: "00000000-0000-0000-0000-000000000001",
  periodStartIso: "2026-04-01T00:00:00.000Z",
  periodEndIso: "2026-04-30T00:00:00.000Z",
  policiesFingerprint: "fp-policies",
  exclusionsFingerprint: "fp-exclusions",
  baselineVersion: "phase1b-four-selector",
  status: "computing" as const,
  replaces: null,
  supersededBy: null,
  refreshReason: null,
  computationDurationMs: null,
  lastError: null,
  createdAtIso: "2026-05-12T00:00:00.000Z",
  finalizedAtIso: null,
  ...overrides,
});

describe("runCorpusBTriage", () => {
  beforeEach(() => {
    mockGetCustomerPool.mockReset();
    mockFindActiveRun.mockReset();
    mockInsertComputingRun.mockReset();
    mockRecomputeRun.mockReset();
    mockInsertTriagedEventsBatch.mockReset();
    mockMarkRunReadyOnClient.mockReset();
    mockMarkRunFailed.mockReset();
    mockGetRunById.mockReset();
  });

  it("returns the cache hit when an active ready run exists", async () => {
    mockFindActiveRun.mockResolvedValueOnce(buildRun({ status: "ready" }));
    const { runCorpusBTriage } = await import(
      "@/lib/triage/policy/corpus-b/runner"
    );
    const result = await runCorpusBTriage(
      {
        customerId: 1,
        ownerAccountId: "00000000-0000-0000-0000-000000000001",
        periodStartIso: "2026-04-01T00:00:00.000Z",
        periodEndIso: "2026-04-30T00:00:00.000Z",
        policies: [],
        baselineVersion: "phase1b-four-selector",
        refreshReason: null,
      },
      {
        exclusionResolver: {
          async resolve() {
            return { rules: [] };
          },
        },
        fetchPage: async () => ({
          eventListWithTriage: {
            pageInfo: {
              hasPreviousPage: false,
              hasNextPage: false,
              startCursor: null,
              endCursor: null,
            },
            edges: [],
          },
        }),
      },
    );
    expect(result.reusedCache).toBe(true);
    expect(result.run.status).toBe("ready");
    expect(mockInsertComputingRun).not.toHaveBeenCalled();
  });

  it("inserts a fresh run and persists matching events", async () => {
    const fakePool = buildFakePool();
    mockGetCustomerPool.mockResolvedValue(fakePool.pool);
    mockFindActiveRun.mockResolvedValueOnce(null);
    mockInsertComputingRun.mockResolvedValueOnce(buildRun({ id: "42" }));
    mockInsertTriagedEventsBatch.mockResolvedValueOnce(1);
    mockMarkRunReadyOnClient.mockResolvedValueOnce(1);

    const { runCorpusBTriage } = await import(
      "@/lib/triage/policy/corpus-b/runner"
    );

    const result = await runCorpusBTriage(
      {
        customerId: 1,
        ownerAccountId: "00000000-0000-0000-0000-000000000001",
        periodStartIso: "2026-04-01T00:00:00.000Z",
        periodEndIso: "2026-04-30T00:00:00.000Z",
        policies: [],
        baselineVersion: "phase1b-four-selector",
        refreshReason: null,
      },
      {
        exclusionResolver: {
          async resolve() {
            return { rules: [] };
          },
        },
        fetchPage: async () => ({
          eventListWithTriage: {
            pageInfo: {
              hasPreviousPage: false,
              hasNextPage: false,
              startCursor: null,
              endCursor: "1",
            },
            edges: [
              {
                cursor: "12345",
                node: {
                  __typename: "HttpThreat",
                  id: "12345",
                  time: "2026-04-15T00:00:00.000Z",
                  sensor: "sensor-1",
                  category: null,
                  level: null,
                  origAddr: "10.0.0.1",
                  respAddr: "10.0.0.2",
                  host: "evil.example",
                  uri: "/admin",
                  triageScores: [{ policyId: "1", score: 1.5 }],
                },
              },
            ],
          },
        }),
      },
    );

    expect(result.reusedCache).toBe(false);
    expect(result.run.status).toBe("ready");
    expect(result.insertedEventCount).toBe(1);
    expect(mockMarkRunReadyOnClient).toHaveBeenCalledOnce();
    const insertCall = mockInsertTriagedEventsBatch.mock.calls[0];
    const insertedRows = insertCall[2];
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0]).toMatchObject({
      eventKey: "12345",
      kind: "HttpThreat",
      host: "evil.example",
      uri: "/admin",
      snapshot: { scores: [{ policyId: 1, score: 1.5 }] },
    });
  });

  it("drops events that match the active exclusion set (app-side fallback)", async () => {
    const fakePool = buildFakePool();
    mockGetCustomerPool.mockResolvedValue(fakePool.pool);
    mockFindActiveRun.mockResolvedValueOnce(null);
    mockInsertComputingRun.mockResolvedValueOnce(buildRun({ id: "43" }));
    mockInsertTriagedEventsBatch.mockResolvedValue(0);
    mockMarkRunReadyOnClient.mockResolvedValueOnce(1);

    const { runCorpusBTriage } = await import(
      "@/lib/triage/policy/corpus-b/runner"
    );

    const result = await runCorpusBTriage(
      {
        customerId: 1,
        ownerAccountId: "00000000-0000-0000-0000-000000000001",
        periodStartIso: "2026-04-01T00:00:00.000Z",
        periodEndIso: "2026-04-30T00:00:00.000Z",
        policies: [],
        baselineVersion: "phase1b-four-selector",
        refreshReason: null,
      },
      {
        exclusionResolver: {
          async resolve() {
            // TLS host exclusion via Hostname — Stage 1 may not match
            // until #723, but the in-memory re-application here does.
            return {
              rules: [{ hostname: ["evil.example"] }],
            };
          },
        },
        fetchPage: async () => ({
          eventListWithTriage: {
            pageInfo: {
              hasPreviousPage: false,
              hasNextPage: false,
              startCursor: null,
              endCursor: "1",
            },
            edges: [
              {
                cursor: "1",
                node: {
                  __typename: "BlocklistTls",
                  id: "1",
                  time: "2026-04-15T00:00:00.000Z",
                  sensor: "s",
                  category: null,
                  level: null,
                  origAddr: "10.0.0.1",
                  respAddr: "10.0.0.2",
                  serverName: "evil.example",
                  triageScores: [{ policyId: "1", score: 2.0 }],
                },
              },
              {
                cursor: "2",
                node: {
                  __typename: "BlocklistTls",
                  id: "2",
                  time: "2026-04-15T00:00:00.000Z",
                  sensor: "s",
                  category: null,
                  level: null,
                  origAddr: "10.0.0.1",
                  respAddr: "10.0.0.2",
                  serverName: "good.example",
                  triageScores: [{ policyId: "1", score: 1.0 }],
                },
              },
            ],
          },
        }),
      },
    );

    expect(result.run.status).toBe("ready");
    // Exactly one event should have been forwarded to the batch INSERT
    // — the `evil.example` row is dropped by the in-memory rematch.
    expect(mockInsertTriagedEventsBatch).toHaveBeenCalledOnce();
    const insertedRows = mockInsertTriagedEventsBatch.mock.calls[0][2];
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0].host).toBe("good.example");
  });

  it("drops events with no policy match (null/empty triageScores)", async () => {
    // `eventListWithTriage` returns every event passing the standard
    // filter; non-matching events have `triageScores` null or empty.
    // The runner must not persist those — "With my policies" should
    // be a zero-row ready run when nothing matched, not the full
    // standard-filter corpus with empty score lists.
    const fakePool = buildFakePool();
    mockGetCustomerPool.mockResolvedValue(fakePool.pool);
    mockFindActiveRun.mockResolvedValueOnce(null);
    mockInsertComputingRun.mockResolvedValueOnce(buildRun({ id: "45" }));
    mockInsertTriagedEventsBatch.mockResolvedValue(0);
    mockMarkRunReadyOnClient.mockResolvedValueOnce(1);

    const { runCorpusBTriage } = await import(
      "@/lib/triage/policy/corpus-b/runner"
    );

    const result = await runCorpusBTriage(
      {
        customerId: 1,
        ownerAccountId: "00000000-0000-0000-0000-000000000001",
        periodStartIso: "2026-04-01T00:00:00.000Z",
        periodEndIso: "2026-04-30T00:00:00.000Z",
        policies: [],
        baselineVersion: "phase1b-four-selector",
        refreshReason: null,
      },
      {
        exclusionResolver: {
          async resolve() {
            return { rules: [] };
          },
        },
        fetchPage: async () => ({
          eventListWithTriage: {
            pageInfo: {
              hasPreviousPage: false,
              hasNextPage: false,
              startCursor: null,
              endCursor: "2",
            },
            edges: [
              {
                cursor: "1",
                node: {
                  __typename: "HttpThreat",
                  id: "1",
                  time: "2026-04-15T00:00:00.000Z",
                  sensor: "s",
                  category: null,
                  level: null,
                  origAddr: "10.0.0.1",
                  respAddr: "10.0.0.2",
                  host: "a.example",
                  uri: "/x",
                  triageScores: null,
                },
              },
              {
                cursor: "2",
                node: {
                  __typename: "HttpThreat",
                  id: "2",
                  time: "2026-04-15T00:00:00.000Z",
                  sensor: "s",
                  category: null,
                  level: null,
                  origAddr: "10.0.0.1",
                  respAddr: "10.0.0.2",
                  host: "b.example",
                  uri: "/y",
                  triageScores: [],
                },
              },
            ],
          },
        }),
      },
    );

    expect(result.run.status).toBe("ready");
    expect(result.insertedEventCount).toBe(0);
    // The batch INSERT is not called at all when no row survived
    // the exclusion + score filter — preferred over a zero-row call.
    expect(mockInsertTriagedEventsBatch).not.toHaveBeenCalled();
  });

  it("transitions to failed and persists last_error on encoding failure", async () => {
    const fakePool = buildFakePool();
    mockGetCustomerPool.mockResolvedValue(fakePool.pool);
    mockFindActiveRun.mockResolvedValueOnce(null);
    mockInsertComputingRun.mockResolvedValueOnce(buildRun({ id: "44" }));
    mockMarkRunFailed.mockResolvedValueOnce(undefined);

    const { runCorpusBTriage } = await import(
      "@/lib/triage/policy/corpus-b/runner"
    );
    const result = await runCorpusBTriage(
      {
        customerId: 1,
        ownerAccountId: "00000000-0000-0000-0000-000000000001",
        periodStartIso: "2026-04-01T00:00:00.000Z",
        periodEndIso: "2026-04-30T00:00:00.000Z",
        policies: [
          {
            id: 7,
            name: "bad",
            packet_attr: [
              {
                raw_event_kind: "http",
                attr_name: "addr",
                value_kind: "vector",
                cmp_kind: "equal",
                first_value: "[1,2,3]",
                second_value: null,
                weight: null,
              },
            ],
            confidence: [],
            response: [],
            created_at: "2026-01-01T00:00:00.000Z",
            updated_at: "2026-01-01T00:00:00.000Z",
          },
        ],
        baselineVersion: "phase1b-four-selector",
        refreshReason: null,
      },
      {
        exclusionResolver: {
          async resolve() {
            return { rules: [] };
          },
        },
        fetchPage: async () => {
          throw new Error("fetch should not be called when encoding fails");
        },
      },
    );
    // Encoding errors must now persist a real `failed` row so the
    // menu / audit can surface them and 1B-7 retention can clean
    // them up — synthesised pseudo-rows are no longer acceptable.
    expect(result.run.status).toBe("failed");
    expect(result.run.lastError).toContain("vector_unsupported");
    // The persisted `last_error` must identify the offending policy
    // and rule so the menu / audit / 1B-7 retention surfaces can act
    // on it without re-deriving the location from the raw error kind.
    expect(result.run.lastError).toContain("policyId=7");
    expect(result.run.lastError).toContain("packet_attr.0");
    expect(mockInsertComputingRun).toHaveBeenCalledOnce();
    expect(mockMarkRunFailed).toHaveBeenCalledOnce();
    const failCall = mockMarkRunFailed.mock.calls[0];
    expect(failCall[1]).toBe("44");
    const persisted = String(failCall[2]);
    expect(persisted).toContain("vector_unsupported");
    expect(persisted).toContain("policyId=7");
    expect(persisted).toContain("packet_attr.0");
  });

  it("fails the run when the page cap is reached with more pages available", async () => {
    const fakePool = buildFakePool();
    mockGetCustomerPool.mockResolvedValue(fakePool.pool);
    mockFindActiveRun.mockResolvedValueOnce(null);
    mockInsertComputingRun.mockResolvedValueOnce(buildRun({ id: "45" }));
    mockInsertTriagedEventsBatch.mockResolvedValue(0);
    mockMarkRunFailed.mockResolvedValueOnce(undefined);

    const { _testing, runCorpusBTriage } = await import(
      "@/lib/triage/policy/corpus-b/runner"
    );

    let fetchCalls = 0;
    const result = await runCorpusBTriage(
      {
        customerId: 1,
        ownerAccountId: "00000000-0000-0000-0000-000000000001",
        periodStartIso: "2026-04-01T00:00:00.000Z",
        periodEndIso: "2026-04-30T00:00:00.000Z",
        policies: [],
        baselineVersion: "phase1b-four-selector",
        refreshReason: null,
      },
      {
        exclusionResolver: {
          async resolve() {
            return { rules: [] };
          },
        },
        fetchPage: async () => {
          fetchCalls += 1;
          return {
            eventListWithTriage: {
              pageInfo: {
                hasPreviousPage: false,
                hasNextPage: true,
                startCursor: null,
                endCursor: String(fetchCalls),
              },
              edges: [],
            },
          };
        },
      },
    );

    expect(fetchCalls).toBe(_testing.MAX_PAGES_PER_RUN);
    expect(result.run.status).toBe("failed");
    expect(result.run.lastError).toContain("page cap");
    expect(mockMarkRunFailed).toHaveBeenCalledOnce();
  });

  it("fails the run when hasNextPage=true but endCursor is null", async () => {
    // A malformed pagination response — the resolver claims more pages
    // exist but does not give us a cursor to fetch them with. Treating
    // this as a clean exit would materialise an incomplete run as
    // `ready`; instead it must transition to `failed` like the page-cap
    // case.
    const fakePool = buildFakePool();
    mockGetCustomerPool.mockResolvedValue(fakePool.pool);
    mockFindActiveRun.mockResolvedValueOnce(null);
    mockInsertComputingRun.mockResolvedValueOnce(buildRun({ id: "46" }));
    mockInsertTriagedEventsBatch.mockResolvedValue(0);
    mockMarkRunFailed.mockResolvedValueOnce(undefined);

    const { runCorpusBTriage } = await import(
      "@/lib/triage/policy/corpus-b/runner"
    );

    const result = await runCorpusBTriage(
      {
        customerId: 1,
        ownerAccountId: "00000000-0000-0000-0000-000000000001",
        periodStartIso: "2026-04-01T00:00:00.000Z",
        periodEndIso: "2026-04-30T00:00:00.000Z",
        policies: [],
        baselineVersion: "phase1b-four-selector",
        refreshReason: null,
      },
      {
        exclusionResolver: {
          async resolve() {
            return { rules: [] };
          },
        },
        fetchPage: async () => ({
          eventListWithTriage: {
            pageInfo: {
              hasPreviousPage: false,
              hasNextPage: true,
              startCursor: null,
              endCursor: null,
            },
            edges: [],
          },
        }),
      },
    );

    expect(result.run.status).toBe("failed");
    expect(result.run.lastError).toContain("endCursor=null");
    expect(mockMarkRunFailed).toHaveBeenCalledOnce();
    expect(mockMarkRunReadyOnClient).not.toHaveBeenCalled();
  });

  it("does not revive a terminal row when the ready flip finds zero rows", async () => {
    // Simulates 1B-7's reaper transitioning the row to `failed` (or a
    // concurrent recompute marking it `superseded`) while this runner
    // was mid-flight. `markRunReadyOnClient` returns rowCount 0 because
    // of its `AND status = 'computing'` guard, and the runner must
    // surface the terminal row instead of resurrecting it.
    const fakePool = buildFakePool();
    mockGetCustomerPool.mockResolvedValue(fakePool.pool);
    mockFindActiveRun.mockResolvedValueOnce(null);
    mockInsertComputingRun.mockResolvedValueOnce(buildRun({ id: "47" }));
    mockInsertTriagedEventsBatch.mockResolvedValue(0);
    mockMarkRunReadyOnClient.mockResolvedValueOnce(0);
    mockGetRunById.mockResolvedValueOnce(
      buildRun({
        id: "47",
        status: "failed",
        lastError: "timeout: runner did not finalize",
      }),
    );

    const { runCorpusBTriage } = await import(
      "@/lib/triage/policy/corpus-b/runner"
    );
    const result = await runCorpusBTriage(
      {
        customerId: 1,
        ownerAccountId: "00000000-0000-0000-0000-000000000001",
        periodStartIso: "2026-04-01T00:00:00.000Z",
        periodEndIso: "2026-04-30T00:00:00.000Z",
        policies: [],
        baselineVersion: "phase1b-four-selector",
        refreshReason: null,
      },
      {
        exclusionResolver: {
          async resolve() {
            return { rules: [] };
          },
        },
        fetchPage: async () => ({
          eventListWithTriage: {
            pageInfo: {
              hasPreviousPage: false,
              hasNextPage: false,
              startCursor: null,
              endCursor: "1",
            },
            edges: [],
          },
        }),
      },
    );

    expect(result.run.status).toBe("failed");
    expect(result.run.lastError).toBe("timeout: runner did not finalize");
    expect(mockMarkRunFailed).not.toHaveBeenCalled();
    expect(mockGetRunById).toHaveBeenCalledOnce();
  });
});
