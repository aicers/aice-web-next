import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetCustomerPool = vi.hoisted(() => vi.fn());
const mockFindActiveRun = vi.hoisted(() => vi.fn());
const mockInsertComputingRun = vi.hoisted(() => vi.fn());
const mockRecomputeRun = vi.hoisted(() => vi.fn());
const mockInsertTriagedEventsBatch = vi.hoisted(() => vi.fn());
const mockMarkRunReadyOnClient = vi.hoisted(() => vi.fn());
const mockMarkRunFailed = vi.hoisted(() => vi.fn());

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
  };
});

interface FakePoolClient {
  query: ReturnType<typeof vi.fn>;
  release: () => void;
}

function buildFakePool(): {
  pool: { connect: () => Promise<FakePoolClient> };
  client: FakePoolClient;
} {
  const client: FakePoolClient = {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    release: () => undefined,
  };
  const pool = { connect: async () => client };
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
    mockMarkRunReadyOnClient.mockResolvedValueOnce(undefined);

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
    mockMarkRunReadyOnClient.mockResolvedValueOnce(undefined);

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
                  triageScores: [],
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
                  triageScores: [],
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
    expect(mockInsertComputingRun).toHaveBeenCalledOnce();
    expect(mockMarkRunFailed).toHaveBeenCalledOnce();
    const failCall = mockMarkRunFailed.mock.calls[0];
    expect(failCall[1]).toBe("44");
    expect(String(failCall[2])).toContain("vector_unsupported");
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
});
