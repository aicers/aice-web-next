import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthSession } from "@/lib/auth/jwt";

const mockHasPermission = vi.hoisted(() => vi.fn());
const mockResolveEffectiveCustomerIds = vi.hoisted(() => vi.fn());
const mockGetCustomerPool = vi.hoisted(() => vi.fn());
const mockCentralQuery = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/permissions", () => ({
  hasPermission: mockHasPermission,
}));

vi.mock("@/lib/auth/customer-scope", () => ({
  resolveEffectiveCustomerIds: mockResolveEffectiveCustomerIds,
}));

vi.mock("@/lib/triage/policy/customer-db", () => ({
  getCustomerPool: mockGetCustomerPool,
  CustomerNotFoundError: class CustomerNotFoundError extends Error {},
}));

vi.mock("@/lib/db/client", () => ({
  query: mockCentralQuery,
}));

interface QueryResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount: number;
}

interface CustomerSeed {
  customerId: number;
  /** Asset-aggregate rows the per-customer SELECT returns. */
  assetRows: Array<{
    address: string;
    triaged_count: string;
    score: number;
    last_event_time: Date;
  }>;
  /** Per-asset detail rows keyed by address. */
  detailRows?: Record<
    string,
    Array<{
      event_key?: string;
      event_time: Date;
      kind: string;
      sensor: string;
      orig_addr: string | null;
      resp_addr?: string | null;
      orig_port?: number | null;
      resp_port?: number | null;
      host?: string | null;
      dns_query?: string | null;
      uri?: string | null;
      category?: string | null;
      baseline_score?: number | null;
    }>
  >;
  /** Per-address observed-event-meta counts. */
  observedPerAsset?: Array<{ address: string; detected_count: string }>;
  observedTotal?: number;
  triagedTotal?: number;
  /**
   * Corpus events list returned by the per-customer pivot-index read.
   * Defaults to an empty list so tests that do not exercise the pivot
   * scope stay narrow.
   */
  corpusEvents?: Array<{
    event_key: string;
    event_time: Date;
    kind: string;
    sensor: string;
    orig_addr: string | null;
    resp_addr?: string | null;
    orig_port?: number | null;
    resp_port?: number | null;
    host?: string | null;
    dns_query?: string | null;
    uri?: string | null;
    category?: string | null;
    baseline_score?: number | null;
  }>;
  freshness?: {
    last_ingested_at: Date | null;
    last_run_status: "ok" | "running" | "failed" | null;
    last_error: string | null;
  } | null;
}

function makeMockPool(seed: CustomerSeed): {
  pool: { query: ReturnType<typeof vi.fn> };
  queries: Array<{ sql: string; params: unknown[] | undefined }>;
} {
  const queries: Array<{ sql: string; params: unknown[] | undefined }> = [];
  const query = vi.fn(
    async (sql: string, params?: unknown[]): Promise<QueryResult> => {
      queries.push({ sql, params });
      if (sql.includes("FROM baseline_corpus_state")) {
        if (seed.freshness === null) return { rows: [], rowCount: 0 };
        const f = seed.freshness ?? {
          last_ingested_at: new Date("2026-05-09T11:55:00.000Z"),
          last_run_status: "ok" as const,
          last_error: null,
        };
        return { rows: [f], rowCount: 1 };
      }
      if (sql.includes("FROM baseline_triaged_event")) {
        if (sql.includes("GROUP BY b.orig_addr")) {
          return {
            rows: seed.assetRows,
            rowCount: seed.assetRows.length,
          };
        }
        if (
          sql.includes("WHERE event_time >= $1") &&
          sql.includes("orig_addr  =  $3")
        ) {
          const address = params?.[2] as string;
          const rows = seed.detailRows?.[address] ?? [];
          return { rows, rowCount: rows.length };
        }
        if (sql.includes("SELECT COUNT(*)::text")) {
          return {
            rows: [{ count: String(seed.triagedTotal ?? 0) }],
            rowCount: 1,
          };
        }
        if (
          sql.includes("ORDER BY event_time DESC") &&
          sql.includes("LIMIT $3")
        ) {
          // Flat corpus events read for the pivot index — no
          // `orig_addr` predicate, just the event-time range + cap.
          const rows = seed.corpusEvents ?? [];
          return { rows, rowCount: rows.length };
        }
      }
      if (sql.includes("FROM observed_event_meta")) {
        if (sql.includes("GROUP BY o.orig_addr")) {
          return {
            rows: seed.observedPerAsset ?? [],
            rowCount: (seed.observedPerAsset ?? []).length,
          };
        }
        return {
          rows: [{ count: String(seed.observedTotal ?? 0) }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    },
  );
  return { pool: { query }, queries };
}

function makeSession(overrides: Partial<AuthSession> = {}): AuthSession {
  return {
    accountId: "account-1",
    sessionId: "session-1",
    roles: ["Security Monitor"],
    tokenVersion: 1,
    mustChangePassword: false,
    mustEnrollMfa: false,
    iat: 0,
    exp: 0,
    sessionIp: "127.0.0.1",
    sessionUserAgent: "test",
    sessionBrowserFingerprint: "test",
    needsReauth: false,
    sessionCreatedAt: new Date(0),
    sessionLastActiveAt: new Date(0),
    ...overrides,
  } as AuthSession;
}

const PERIOD = {
  startIso: "2026-05-08T12:00:00.000Z",
  endIso: "2026-05-09T12:00:00.000Z",
};

describe("loadTriagePeriod (SQL data source)", () => {
  beforeEach(() => {
    mockHasPermission.mockReset();
    mockResolveEffectiveCustomerIds.mockReset();
    mockGetCustomerPool.mockReset();
    mockCentralQuery.mockReset();
    // Default: every requested id resolves to a synthetic
    // "Customer N" name unless a test overrides the mock.
    mockCentralQuery.mockImplementation(
      async (_sql: string, params?: unknown[]) => {
        const ids = (params?.[0] as number[]) ?? [];
        return {
          rows: ids.map((id) => ({ id, name: `Customer ${id}` })),
          rowCount: ids.length,
        };
      },
    );
  });

  it("rejects callers without triage:read before any tenant-DB connection", async () => {
    mockHasPermission.mockResolvedValue(false);
    const { loadTriagePeriod } = await import("@/lib/triage/server-actions");
    const { TriageUnauthorizedError } = await import("@/lib/triage");
    await expect(
      loadTriagePeriod(makeSession(), PERIOD),
    ).rejects.toBeInstanceOf(TriageUnauthorizedError);
    expect(mockGetCustomerPool).not.toHaveBeenCalled();
  });

  it("rejects a non-admin caller with empty scope before opening a pool", async () => {
    mockHasPermission.mockImplementation(
      async (_roles: string[], permission: string) =>
        permission === "triage:read",
    );
    mockResolveEffectiveCustomerIds.mockResolvedValue([]);
    const { loadTriagePeriod } = await import("@/lib/triage/server-actions");
    const { TriageForbiddenError } = await import("@/lib/triage");
    await expect(
      loadTriagePeriod(makeSession(), PERIOD),
    ).rejects.toBeInstanceOf(TriageForbiddenError);
    expect(mockGetCustomerPool).not.toHaveBeenCalled();
  });

  it("aggregates a single-tenant slice end-to-end", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([1]);
    const { pool } = makeMockPool({
      customerId: 1,
      assetRows: [
        {
          address: "10.0.0.1",
          triaged_count: "3",
          score: 4.5,
          last_event_time: new Date("2026-05-09T11:30:00.000Z"),
        },
      ],
      detailRows: {
        "10.0.0.1": [
          {
            event_key: "1",
            event_time: new Date("2026-05-09T11:30:00.000Z"),
            kind: "HttpThreat",
            sensor: "sensor-a",
            orig_addr: "10.0.0.1",
            category: "COMMAND_AND_CONTROL",
            baseline_score: 1.5,
          },
        ],
      },
      corpusEvents: [
        {
          event_key: "1",
          event_time: new Date("2026-05-09T11:30:00.000Z"),
          kind: "HttpThreat",
          sensor: "sensor-a",
          orig_addr: "10.0.0.1",
          category: "COMMAND_AND_CONTROL",
          baseline_score: 1.5,
        },
      ],
      observedPerAsset: [{ address: "10.0.0.1", detected_count: "10" }],
      observedTotal: 100,
      triagedTotal: 3,
      freshness: {
        last_ingested_at: new Date("2026-05-09T11:55:00.000Z"),
        last_run_status: "ok",
        last_error: null,
      },
    });
    mockGetCustomerPool.mockResolvedValue(pool);

    const { loadTriagePeriod } = await import("@/lib/triage/server-actions");
    const result = await loadTriagePeriod(
      makeSession({ roles: ["System Administrator"] }),
      PERIOD,
    );

    expect(result.assets).toHaveLength(1);
    expect(result.assets[0].customerId).toBe(1);
    expect(result.assets[0].customerName).toBe("Customer 1");
    expect(result.assets[0].address).toBe("10.0.0.1");
    expect(result.assets[0].triagedCount).toBe(3);
    expect(result.assets[0].detectedCount).toBe(10);
    expect(result.assets[0].detectedCountUnavailable).toBe(false);
    expect(result.funnel.detected).toBe(100);
    expect(result.funnel.triaged).toBe(3);
    expect(result.funnel.passThroughRate).toBeCloseTo(3 / 100);
    expect(result.observedDenominatorTruncated).toBe(false);
    expect(result.freshness.worst?.status).toBe("ok");
    expect(result.freshness.customers).toHaveLength(1);
    // Pivot index reads from the flat `selectCorpusEvents` output,
    // not from `assets[*].events`. rowKey is `${customerId}/${event_key}`.
    expect(result.events).toHaveLength(1);
    expect(result.events[0].rowKey).toBe("1/1");
  });

  it("flags observedDenominatorTruncated when the window starts more than 30d ago", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([1]);
    const { pool } = makeMockPool({
      customerId: 1,
      assetRows: [],
    });
    mockGetCustomerPool.mockResolvedValue(pool);
    const farPastPeriod = {
      startIso: "2026-02-01T00:00:00.000Z",
      endIso: "2026-03-01T00:00:00.000Z",
    };
    const { loadTriagePeriod } = await import("@/lib/triage/server-actions");
    const result = await loadTriagePeriod(
      makeSession({ roles: ["System Administrator"] }),
      farPastPeriod,
    );
    expect(result.observedDenominatorTruncated).toBe(true);
  });

  it("does not flag observedDenominatorTruncated for an in-retention window", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([1]);
    const { pool } = makeMockPool({
      customerId: 1,
      assetRows: [],
    });
    mockGetCustomerPool.mockResolvedValue(pool);
    const now = Date.now();
    const recentPeriod = {
      startIso: new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString(),
      endIso: new Date(now).toISOString(),
    };
    const { loadTriagePeriod } = await import("@/lib/triage/server-actions");
    const result = await loadTriagePeriod(
      makeSession({ roles: ["System Administrator"] }),
      recentPeriod,
    );
    expect(result.observedDenominatorTruncated).toBe(false);
  });

  it("sets detectedCountUnavailable only on assets with no in-retention observed row when the window straddles 30d", async () => {
    // 30-day window `now − 45d → now − 15d` — straddles the
    // `observed_event_meta` retention boundary. The result-level flag
    // fires (window start < now − 30d) and the per-asset flag fires
    // only on assets whose in-retention slice produced no observed
    // row. Asset A has 5 observed rows in the [now − 30d, now − 15d]
    // slice → flag stays false; asset B has none → flag is true.
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([1]);
    const now = Date.now();
    const straddlePeriod = {
      startIso: new Date(now - 45 * 24 * 60 * 60 * 1000).toISOString(),
      endIso: new Date(now - 15 * 24 * 60 * 60 * 1000).toISOString(),
    };
    const { pool } = makeMockPool({
      customerId: 1,
      assetRows: [
        {
          address: "10.0.0.1",
          triaged_count: "3",
          score: 6,
          last_event_time: new Date(now - 16 * 24 * 60 * 60 * 1000),
        },
        {
          address: "10.0.0.2",
          triaged_count: "2",
          score: 4,
          last_event_time: new Date(now - 40 * 24 * 60 * 60 * 1000),
        },
      ],
      // Only `10.0.0.1` has an observed row inside the clamped window.
      // `10.0.0.2`'s observed events sit in the out-of-retention slice
      // and never reach `observed_event_meta` — its per-asset flag
      // must fire while keeping `detectedCount` at 0 (no `null`).
      observedPerAsset: [{ address: "10.0.0.1", detected_count: "5" }],
      observedTotal: 5,
      triagedTotal: 5,
    });
    mockGetCustomerPool.mockResolvedValue(pool);
    const { loadTriagePeriod } = await import("@/lib/triage/server-actions");
    const result = await loadTriagePeriod(
      makeSession({ roles: ["System Administrator"] }),
      straddlePeriod,
    );
    expect(result.observedDenominatorTruncated).toBe(true);
    const a = result.assets.find((x) => x.address === "10.0.0.1");
    const b = result.assets.find((x) => x.address === "10.0.0.2");
    expect(a?.detectedCount).toBe(5);
    expect(a?.detectedCountUnavailable).toBe(false);
    expect(b?.detectedCount).toBe(0);
    expect(b?.detectedCountUnavailable).toBe(true);
    // Corpus-side stats stay accurate across the full window.
    expect(b?.triagedCount).toBe(2);
    expect(b?.score).toBe(4);
  });

  it("merges asset pages across customers keyed by (customerId, address)", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([1, 2]);
    const customer1 = makeMockPool({
      customerId: 1,
      assetRows: [
        {
          address: "192.168.1.10",
          triaged_count: "5",
          score: 10,
          last_event_time: new Date("2026-05-09T10:00:00.000Z"),
        },
      ],
      detailRows: { "192.168.1.10": [] },
      observedPerAsset: [{ address: "192.168.1.10", detected_count: "5" }],
      observedTotal: 5,
      triagedTotal: 5,
    });
    const customer2 = makeMockPool({
      customerId: 2,
      assetRows: [
        {
          // Same RFC1918 address as customer 1 — must stay distinct
          // in the merged page (composite key).
          address: "192.168.1.10",
          triaged_count: "2",
          score: 20,
          last_event_time: new Date("2026-05-09T11:00:00.000Z"),
        },
      ],
      detailRows: { "192.168.1.10": [] },
      observedPerAsset: [{ address: "192.168.1.10", detected_count: "8" }],
      observedTotal: 8,
      triagedTotal: 2,
    });
    mockGetCustomerPool.mockImplementation(async (id: number) =>
      id === 1 ? customer1.pool : customer2.pool,
    );
    const { loadTriagePeriod } = await import("@/lib/triage/server-actions");
    const result = await loadTriagePeriod(
      makeSession({ roles: ["System Administrator"] }),
      PERIOD,
    );
    expect(result.assets).toHaveLength(2);
    // Higher score wins: customer 2's same-address row comes first.
    expect(result.assets[0]).toMatchObject({
      customerId: 2,
      address: "192.168.1.10",
      score: 20,
    });
    expect(result.assets[1]).toMatchObject({
      customerId: 1,
      address: "192.168.1.10",
      score: 10,
    });
    // Funnel sums across customers.
    expect(result.funnel.detected).toBe(13);
    expect(result.funnel.triaged).toBe(7);
  });

  it("breaks equal-score ties across customers on last_event_time DESC", async () => {
    // Regression for Round 2 Item 3: per-tenant SQL ORDERs by
    // `score DESC, last_event_time DESC`. The cross-customer merge
    // must preserve that contract — equal-score rows from two
    // tenants order on the newer `last_event_time` first.
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([1, 2]);
    const olderTs = new Date("2026-05-09T08:00:00.000Z");
    const newerTs = new Date("2026-05-09T11:00:00.000Z");
    const customer1 = makeMockPool({
      customerId: 1,
      assetRows: [
        {
          address: "192.168.1.10",
          triaged_count: "5",
          score: 10,
          last_event_time: newerTs,
        },
      ],
      detailRows: { "192.168.1.10": [] },
      observedPerAsset: [{ address: "192.168.1.10", detected_count: "5" }],
      observedTotal: 5,
      triagedTotal: 5,
    });
    const customer2 = makeMockPool({
      customerId: 2,
      assetRows: [
        {
          address: "192.168.1.10",
          triaged_count: "5",
          score: 10,
          last_event_time: olderTs,
        },
      ],
      detailRows: { "192.168.1.10": [] },
      observedPerAsset: [{ address: "192.168.1.10", detected_count: "5" }],
      observedTotal: 5,
      triagedTotal: 5,
    });
    mockGetCustomerPool.mockImplementation(async (id: number) =>
      id === 1 ? customer1.pool : customer2.pool,
    );
    const { loadTriagePeriod } = await import("@/lib/triage/server-actions");
    const result = await loadTriagePeriod(
      makeSession({ roles: ["System Administrator"] }),
      PERIOD,
    );
    expect(result.assets).toHaveLength(2);
    expect(result.assets[0]).toMatchObject({
      customerId: 1,
      lastEventTimeIso: newerTs.toISOString(),
    });
    expect(result.assets[1]).toMatchObject({
      customerId: 2,
      lastEventTimeIso: olderTs.toISOString(),
    });
  });

  it("never issues OFFSET SQL on the multi-customer code path", async () => {
    // #458 acceptance: "Multi-customer code path issues no OFFSET SQL
    // — pagination is keyset-cursor only."
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([1, 2]);
    const c1 = makeMockPool({
      customerId: 1,
      assetRows: [],
    });
    const c2 = makeMockPool({
      customerId: 2,
      assetRows: [],
    });
    mockGetCustomerPool.mockImplementation(async (id: number) =>
      id === 1 ? c1.pool : c2.pool,
    );
    const { loadTriagePeriod } = await import("@/lib/triage/server-actions");
    await loadTriagePeriod(
      makeSession({ roles: ["System Administrator"] }),
      PERIOD,
    );
    for (const { sql } of [...c1.queries, ...c2.queries]) {
      expect(sql).not.toMatch(/\bOFFSET\b/i);
    }
  });

  it("freshness header picks the worst state across customers", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([1, 2]);
    const c1 = makeMockPool({
      customerId: 1,
      assetRows: [],
      freshness: {
        last_ingested_at: new Date("2026-05-09T11:55:00.000Z"),
        last_run_status: "ok",
        last_error: null,
      },
    });
    const c2 = makeMockPool({
      customerId: 2,
      assetRows: [],
      freshness: {
        last_ingested_at: new Date("2026-05-09T10:00:00.000Z"),
        last_run_status: "failed",
        last_error: "boom",
      },
    });
    mockGetCustomerPool.mockImplementation(async (id: number) =>
      id === 1 ? c1.pool : c2.pool,
    );
    const { loadTriagePeriod } = await import("@/lib/triage/server-actions");
    const result = await loadTriagePeriod(
      makeSession({ roles: ["System Administrator"] }),
      PERIOD,
    );
    expect(result.freshness.worst?.customerId).toBe(2);
    expect(result.freshness.worst?.status).toBe("failed");
    expect(result.freshness.customers).toHaveLength(2);
  });

  it("surfaces 'awaiting first ingest' when the corpus-state row is absent", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([1]);
    const { pool } = makeMockPool({
      customerId: 1,
      assetRows: [],
      freshness: null,
    });
    mockGetCustomerPool.mockResolvedValue(pool);
    const { loadTriagePeriod } = await import("@/lib/triage/server-actions");
    const result = await loadTriagePeriod(
      makeSession({ roles: ["System Administrator"] }),
      PERIOD,
    );
    expect(result.freshness.worst?.rowAbsent).toBe(true);
    expect(result.freshness.worst?.status).toBeNull();
  });

  it("never selects orig_addr IS NULL aggregates (acceptance: no synthetic NULL row)", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([1]);
    const { pool, queries } = makeMockPool({
      customerId: 1,
      assetRows: [],
    });
    mockGetCustomerPool.mockResolvedValue(pool);
    const { loadTriagePeriod } = await import("@/lib/triage/server-actions");
    await loadTriagePeriod(
      makeSession({ roles: ["System Administrator"] }),
      PERIOD,
    );
    // Every baseline_triaged_event / observed_event_meta read with a
    // `GROUP BY orig_addr` shape must filter `orig_addr IS NOT NULL`.
    const aggregates = queries.filter(
      (q) =>
        q.sql.includes("GROUP BY") &&
        (q.sql.includes("baseline_triaged_event") ||
          q.sql.includes("observed_event_meta")),
    );
    expect(aggregates.length).toBeGreaterThan(0);
    for (const { sql } of aggregates) {
      expect(sql).toMatch(/orig_addr IS NOT NULL/i);
    }
  });
});

describe("loadTriagePeriod internals", () => {
  it("ranks freshness severity failed > running > rowAbsent > ok", async () => {
    const { _testing } = await import("@/lib/triage/server-actions");
    const customers = [
      {
        customerId: 1,
        status: "ok" as const,
        lastIngestedAtIso: "2026-05-09T11:00:00.000Z",
        rowAbsent: false,
        lastError: null,
      },
      {
        customerId: 2,
        status: null,
        lastIngestedAtIso: null,
        rowAbsent: true,
        lastError: null,
      },
      {
        customerId: 3,
        status: "running" as const,
        lastIngestedAtIso: "2026-05-09T10:00:00.000Z",
        rowAbsent: false,
        lastError: null,
      },
      {
        customerId: 4,
        status: "failed" as const,
        lastIngestedAtIso: "2026-05-09T09:00:00.000Z",
        rowAbsent: false,
        lastError: "x",
      },
    ];
    expect(_testing.pickWorstFreshness(customers)?.customerId).toBe(4);
    expect(_testing.pickWorstFreshness(customers.slice(0, 3))?.customerId).toBe(
      3,
    );
    expect(_testing.pickWorstFreshness(customers.slice(0, 2))?.customerId).toBe(
      2,
    );
    expect(_testing.pickWorstFreshness([customers[0]])?.customerId).toBe(1);
    expect(_testing.pickWorstFreshness([])).toBeNull();
  });
});
