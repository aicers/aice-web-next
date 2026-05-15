import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthSession } from "@/lib/auth/jwt";
import type { ThreatCategory } from "@/lib/detection";

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

/** Row shape returned by `selectMenuCohort` — see server-actions.ts. */
interface MenuCohortRow {
  event_key: string;
  event_time: Date;
  kind: string;
  sensor: string;
  orig_addr: string | null;
  resp_addr: string | null;
  orig_port: number | null;
  resp_port: number | null;
  host: string | null;
  dns_query: string | null;
  uri: string | null;
  category: ThreatCategory | null;
  baseline_version: string;
  raw_score: number;
  selector_tags: string[] | null;
  baseline_score: number;
  is_unlabeled: boolean;
  bucket_count: string;
  bucket_tag_sum: string;
  cohort_count: string;
}

function buildCohortRow(opts: {
  eventKey: string;
  eventTime?: Date;
  kind?: string;
  sensor?: string;
  address: string | null;
  baselineScore: number;
  selectorTags?: string[];
  category?: ThreatCategory | null;
  bucketCount: number;
  bucketTagSum?: number;
  cohortCount: number;
}): MenuCohortRow {
  const selectorTags = opts.selectorTags ?? [];
  return {
    event_key: opts.eventKey,
    event_time: opts.eventTime ?? new Date("2026-05-09T11:30:00.000Z"),
    kind: opts.kind ?? "HttpThreat",
    sensor: opts.sensor ?? "sensor-a",
    orig_addr: opts.address,
    resp_addr: null,
    orig_port: null,
    resp_port: null,
    host: null,
    dns_query: null,
    uri: null,
    category: opts.category ?? null,
    baseline_version: "phase1b-four-selector",
    raw_score: 0,
    selector_tags: selectorTags,
    baseline_score: opts.baselineScore,
    is_unlabeled:
      (opts.kind ?? "HttpThreat") === "HttpThreat" &&
      selectorTags.includes("unlabeled-cluster"),
    bucket_count: String(opts.bucketCount),
    bucket_tag_sum: String(opts.bucketTagSum ?? 0),
    cohort_count: String(opts.cohortCount),
  };
}

interface DetailRow {
  event_key: string;
  event_time: Date;
  kind: string;
  sensor: string;
  orig_addr: string | null;
  resp_addr: string | null;
  orig_port: number | null;
  resp_port: number | null;
  host: string | null;
  dns_query: string | null;
  uri: string | null;
  category: ThreatCategory | null;
  baseline_score: number;
}

interface CustomerSeed {
  customerId: number;
  /** Rows the `selectMenuCohort` SELECT returns. */
  cohortRows?: MenuCohortRow[];
  /** Per-address detail rows returned by the batched detail SELECT. */
  detailRowsByAddress?: Record<string, Partial<DetailRow>[]>;
  /** Per-address observed counts (response of `perAssetObservedCounts`). */
  observedPerAsset?: Array<{ address: string; detected_count: string }>;
  observedTotal?: number;
  triagedTotal?: number;
  freshness?: {
    last_ingested_at: Date | null;
    last_run_status: "ok" | "running" | "failed" | null;
    last_error: string | null;
  } | null;
}

function detailRow(address: string, partial: Partial<DetailRow>): DetailRow {
  return {
    event_key: partial.event_key ?? "0",
    event_time: partial.event_time ?? new Date("2026-05-09T11:30:00.000Z"),
    kind: partial.kind ?? "HttpThreat",
    sensor: partial.sensor ?? "sensor-a",
    orig_addr: address,
    resp_addr: partial.resp_addr ?? null,
    orig_port: partial.orig_port ?? null,
    resp_port: partial.resp_port ?? null,
    host: partial.host ?? null,
    dns_query: partial.dns_query ?? null,
    uri: partial.uri ?? null,
    category: partial.category ?? null,
    baseline_score: partial.baseline_score ?? 1.0,
  };
}

function makeMockPool(seed: CustomerSeed): {
  pool: { query: ReturnType<typeof vi.fn> };
  queries: Array<{ sql: string; params: unknown[] | undefined }>;
} {
  const queries: Array<{ sql: string; params: unknown[] | undefined }> = [];
  const query = vi.fn(
    async (
      sql: string,
      params?: unknown[],
    ): Promise<QueryResult<Record<string, unknown>>> => {
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
        // Order matchers most-specific-to-least so the catch-all
        // `cume_dist()` branch never eats one of the specialized
        // shapes below.
        if (
          sql.includes("cume_dist()") &&
          sql.includes("bucket_count") &&
          sql.includes("cohort_count")
        ) {
          const rows = (seed.cohortRows ?? []) as unknown as Record<
            string,
            unknown
          >[];
          return { rows, rowCount: rows.length };
        }
        if (
          sql.includes("cume_dist()") &&
          sql.includes("ROW_NUMBER()") &&
          sql.includes("PARTITION BY orig_addr")
        ) {
          // Batched per-asset detail SELECT.
          const addresses = (params?.[2] as string[]) ?? [];
          const rows: DetailRow[] = [];
          for (const addr of addresses) {
            const list = seed.detailRowsByAddress?.[addr] ?? [];
            for (const partial of list) rows.push(detailRow(addr, partial));
          }
          return {
            rows: rows as unknown as Record<string, unknown>[],
            rowCount: rows.length,
          };
        }
        if (sql.includes("SELECT COUNT(*)::text")) {
          return {
            rows: [{ count: String(seed.triagedTotal ?? 0) }],
            rowCount: 1,
          };
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

  it("aggregates a single-tenant slice end-to-end from the §4 menu cohort", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([1]);
    const { pool } = makeMockPool({
      customerId: 1,
      cohortRows: [
        buildCohortRow({
          eventKey: "1",
          address: "10.0.0.1",
          baselineScore: 0.9,
          eventTime: new Date("2026-05-09T11:30:00.000Z"),
          bucketCount: 1,
          cohortCount: 1,
          category: "COMMAND_AND_CONTROL",
        }),
      ],
      detailRowsByAddress: {
        "10.0.0.1": [
          {
            event_key: "1",
            baseline_score: 0.9,
            category: "COMMAND_AND_CONTROL",
          },
        ],
      },
      observedPerAsset: [{ address: "10.0.0.1", detected_count: "10" }],
      observedTotal: 100,
      triagedTotal: 1,
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
    // Asset list derives from the §4 final_menu_rows: score is the
    // sum of baseline_score across the asset's menu rows; triagedCount
    // is the count.
    expect(result.assets[0].customerId).toBe(1);
    expect(result.assets[0].customerName).toBe("Customer 1");
    expect(result.assets[0].address).toBe("10.0.0.1");
    expect(result.assets[0].triagedCount).toBe(1);
    expect(result.assets[0].score).toBeCloseTo(0.9);
    expect(result.assets[0].detectedCount).toBe(10);
    expect(result.assets[0].detectedCountUnavailable).toBe(false);
    expect(result.funnel.detected).toBe(100);
    expect(result.funnel.triaged).toBe(1);
    expect(result.funnel.passThroughRate).toBeCloseTo(1 / 100);
    expect(result.observedDenominatorTruncated).toBe(false);
    expect(result.freshness.worst?.status).toBe("ok");
    expect(result.freshness.customers).toHaveLength(1);
    // Pivot corpus is the §4 final_menu_rows.
    expect(result.events).toHaveLength(1);
    expect(result.events[0].rowKey).toBe("1/1");
  });

  it("flags observedDenominatorTruncated when the window starts more than 30d ago", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([1]);
    const { pool } = makeMockPool({ customerId: 1, cohortRows: [] });
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
    const { pool } = makeMockPool({ customerId: 1, cohortRows: [] });
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
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([1]);
    const now = Date.now();
    const straddlePeriod = {
      startIso: new Date(now - 45 * 24 * 60 * 60 * 1000).toISOString(),
      endIso: new Date(now - 15 * 24 * 60 * 60 * 1000).toISOString(),
    };
    const { pool } = makeMockPool({
      customerId: 1,
      cohortRows: [
        buildCohortRow({
          eventKey: "a1",
          address: "10.0.0.1",
          baselineScore: 0.9,
          eventTime: new Date(now - 16 * 24 * 60 * 60 * 1000),
          bucketCount: 2,
          cohortCount: 2,
        }),
        buildCohortRow({
          eventKey: "b1",
          address: "10.0.0.2",
          baselineScore: 0.5,
          eventTime: new Date(now - 40 * 24 * 60 * 60 * 1000),
          bucketCount: 2,
          cohortCount: 2,
        }),
      ],
      detailRowsByAddress: {
        "10.0.0.1": [{ event_key: "a1", baseline_score: 0.9 }],
        "10.0.0.2": [{ event_key: "b1", baseline_score: 0.5 }],
      },
      // Only `10.0.0.1` has an observed row inside the clamped window.
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
    expect(b?.triagedCount).toBe(1);
  });

  it("merges asset pages across customers keyed by (customerId, address) from menu rows", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([1, 2]);
    const customer1 = makeMockPool({
      customerId: 1,
      cohortRows: [
        buildCohortRow({
          eventKey: "c1-e1",
          address: "192.168.1.10",
          baselineScore: 0.5,
          eventTime: new Date("2026-05-09T10:00:00.000Z"),
          bucketCount: 1,
          cohortCount: 1,
        }),
      ],
      detailRowsByAddress: {
        "192.168.1.10": [{ event_key: "c1-e1", baseline_score: 0.5 }],
      },
      observedPerAsset: [{ address: "192.168.1.10", detected_count: "5" }],
      observedTotal: 5,
      triagedTotal: 1,
    });
    const customer2 = makeMockPool({
      customerId: 2,
      cohortRows: [
        buildCohortRow({
          eventKey: "c2-e1",
          address: "192.168.1.10",
          baselineScore: 0.9,
          eventTime: new Date("2026-05-09T11:00:00.000Z"),
          bucketCount: 1,
          cohortCount: 1,
        }),
      ],
      detailRowsByAddress: {
        "192.168.1.10": [{ event_key: "c2-e1", baseline_score: 0.9 }],
      },
      observedPerAsset: [{ address: "192.168.1.10", detected_count: "8" }],
      observedTotal: 8,
      triagedTotal: 1,
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
    // Higher menu score wins: customer 2's row outranks customer 1.
    expect(result.assets[0]).toMatchObject({
      customerId: 2,
      address: "192.168.1.10",
    });
    expect(result.assets[0].score).toBeCloseTo(0.9);
    expect(result.assets[1]).toMatchObject({
      customerId: 1,
      address: "192.168.1.10",
    });
    expect(result.assets[1].score).toBeCloseTo(0.5);
    expect(result.funnel.detected).toBe(13);
    expect(result.funnel.triaged).toBe(2);
  });

  it("breaks equal-score ties across customers on last_event_time DESC", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([1, 2]);
    const olderTs = new Date("2026-05-09T08:00:00.000Z");
    const newerTs = new Date("2026-05-09T11:00:00.000Z");
    const customer1 = makeMockPool({
      customerId: 1,
      cohortRows: [
        buildCohortRow({
          eventKey: "c1-e1",
          address: "192.168.1.10",
          baselineScore: 0.7,
          eventTime: newerTs,
          bucketCount: 1,
          cohortCount: 1,
        }),
      ],
      detailRowsByAddress: { "192.168.1.10": [] },
      observedPerAsset: [{ address: "192.168.1.10", detected_count: "5" }],
      observedTotal: 5,
      triagedTotal: 1,
    });
    const customer2 = makeMockPool({
      customerId: 2,
      cohortRows: [
        buildCohortRow({
          eventKey: "c2-e1",
          address: "192.168.1.10",
          baselineScore: 0.7,
          eventTime: olderTs,
          bucketCount: 1,
          cohortCount: 1,
        }),
      ],
      detailRowsByAddress: { "192.168.1.10": [] },
      observedPerAsset: [{ address: "192.168.1.10", detected_count: "5" }],
      observedTotal: 5,
      triagedTotal: 1,
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
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([1, 2]);
    const c1 = makeMockPool({ customerId: 1, cohortRows: [] });
    const c2 = makeMockPool({ customerId: 2, cohortRows: [] });
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

  it("merges multi-tenant final_menu_rows in §3 priority order before the cross-tenant cap", async () => {
    // Regression for Round 2 Item 1: the cross-tenant cap used to sort
    // the merged `final_menu_rows` by `time` alone before slicing,
    // which meant a multi-tenant scope exceeding the cap could evict a
    // higher `baseline_score` row from one tenant in favor of a newer
    // lower-score row from another, leaving `result.assets` and
    // `result.events` ranked on inconsistent orderings. The merge is
    // now `(score DESC, time DESC, id DESC)` — the same §3 tie-breaker
    // the per-tenant composition uses — so the cap drops the
    // lowest-priority rows first. Exercised below at sub-cap volume;
    // the sort/slice contract is identical at any volume since the cap
    // is `slice(0, TRIAGE_HARD_EVENT_CAP)` on the same ordered list.
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([1, 2]);
    // Customer 1: one HIGH-score row from an OLD time.
    const oldTs = new Date("2026-05-08T13:00:00.000Z");
    const customer1 = makeMockPool({
      customerId: 1,
      cohortRows: [
        buildCohortRow({
          eventKey: "c1-high",
          address: "10.0.0.1",
          baselineScore: 0.99,
          eventTime: oldTs,
          bucketCount: 1,
          cohortCount: 1,
        }),
      ],
      detailRowsByAddress: { "10.0.0.1": [] },
      observedPerAsset: [{ address: "10.0.0.1", detected_count: "1" }],
    });
    // Customer 2: one LOWER-score row from a NEWER time. Under the
    // old time-only sort it would land ahead of the customer-1 row,
    // so under a tight cap it would survive while the high-score row
    // was evicted. The fix puts the high-score row first regardless
    // of age. Both scores stay above the default strictness cutoff
    // (`top50` → 0.50) so the slider's per-tenant filter does not
    // mask the cross-tenant merge ordering this test exercises.
    const newTs = new Date("2026-05-09T11:30:00.000Z");
    const customer2 = makeMockPool({
      customerId: 2,
      cohortRows: [
        buildCohortRow({
          eventKey: "c2-low",
          address: "10.0.0.2",
          baselineScore: 0.55,
          eventTime: newTs,
          bucketCount: 1,
          cohortCount: 1,
        }),
      ],
      detailRowsByAddress: { "10.0.0.2": [] },
      observedPerAsset: [{ address: "10.0.0.2", detected_count: "1" }],
    });
    mockGetCustomerPool.mockImplementation(async (id: number) =>
      id === 1 ? customer1.pool : customer2.pool,
    );
    const { loadTriagePeriod } = await import("@/lib/triage/server-actions");
    const result = await loadTriagePeriod(
      makeSession({ roles: ["System Administrator"] }),
      PERIOD,
    );
    expect(result.events).toHaveLength(2);
    expect(result.events[0]).toMatchObject({
      customerId: 1,
      score: 0.99,
      time: oldTs.toISOString(),
    });
    expect(result.events[1]).toMatchObject({
      customerId: 2,
      score: 0.55,
      time: newTs.toISOString(),
    });
  });

  it("breaks cross-tenant ties on numeric event_key DESC, not lexicographic", async () => {
    // Regression for Round 4 Item 1: the cross-tenant cap used to
    // tie-break on `b.id.localeCompare(a.id)`, which is lexicographic
    // string order. With variable-width numeric event keys like "9"
    // vs "10", lexicographic puts "9" ahead of "10" — the wrong way
    // round for `event_key DESC` and inconsistent with the per-tenant
    // tie-breaker (`compareEventKeyDesc`) and the SQL `ORDER BY
    // event_key DESC` shape. Under a tight cap, that would evict the
    // wrong row at the boundary. The fix reuses
    // `compareEventKeyDesc` from menu.ts.
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([1, 2]);
    const tiedTs = new Date("2026-05-09T11:30:00.000Z");
    const customer1 = makeMockPool({
      customerId: 1,
      cohortRows: [
        buildCohortRow({
          eventKey: "9",
          address: "10.0.0.1",
          baselineScore: 0.5,
          eventTime: tiedTs,
          bucketCount: 1,
          cohortCount: 1,
        }),
      ],
      detailRowsByAddress: { "10.0.0.1": [] },
      observedPerAsset: [{ address: "10.0.0.1", detected_count: "1" }],
    });
    const customer2 = makeMockPool({
      customerId: 2,
      cohortRows: [
        buildCohortRow({
          eventKey: "10",
          address: "10.0.0.2",
          baselineScore: 0.5,
          eventTime: tiedTs,
          bucketCount: 1,
          cohortCount: 1,
        }),
      ],
      detailRowsByAddress: { "10.0.0.2": [] },
      observedPerAsset: [{ address: "10.0.0.2", detected_count: "1" }],
    });
    mockGetCustomerPool.mockImplementation(async (id: number) =>
      id === 1 ? customer1.pool : customer2.pool,
    );
    const { loadTriagePeriod } = await import("@/lib/triage/server-actions");
    const result = await loadTriagePeriod(
      makeSession({ roles: ["System Administrator"] }),
      PERIOD,
    );
    expect(result.events).toHaveLength(2);
    // Numeric DESC: 10 > 9, so the "10" row must come first.
    expect(result.events[0]).toMatchObject({ id: "10", customerId: 2 });
    expect(result.events[1]).toMatchObject({ id: "9", customerId: 1 });
  });

  it("derives the asset list from the capped events when the cross-tenant cap fires", async () => {
    // Regression for Round 13 Item 3: assets used to aggregate from
    // every per-tenant `final_menu_rows` row, but the returned pivot
    // corpus was capped at `TRIAGE_HARD_EVENT_CAP`. With a multi-
    // tenant scope exceeding the cap that drift left an asset visible
    // (or ranked higher than warranted) on the analyst-facing list
    // even when none of its rows survived in `result.events`. The
    // contract is now: the cross-tenant cap is applied first in §3
    // priority order, and `result.assets` is aggregated from the
    // **capped** events. An asset whose menu rows are all evicted
    // disappears; an asset whose rows are partially evicted has
    // `score`/`triagedCount`/`lastEventTimeIso` reflect only the
    // surviving rows.
    //
    // The cap is overridden to a small value via `vi.doMock` so the
    // test can fit in a few cohort rows rather than synthesizing >5k
    // surviving menu rows across many tenants. The aggregation
    // contract under test is independent of the cap value.
    vi.resetModules();
    vi.doMock("@/lib/triage/types", async () => {
      const actual =
        await vi.importActual<typeof import("@/lib/triage/types")>(
          "@/lib/triage/types",
        );
      return { ...actual, TRIAGE_HARD_EVENT_CAP: 2 };
    });
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([1, 2]);

    // Tenant 1: one high-score row that should fill the first cap slot.
    const c1 = makeMockPool({
      customerId: 1,
      cohortRows: [
        buildCohortRow({
          eventKey: "c1-h-1",
          address: "10.0.0.1",
          baselineScore: 0.9,
          eventTime: new Date("2026-05-09T11:00:00.000Z"),
          bucketCount: 1,
          cohortCount: 1,
        }),
      ],
      detailRowsByAddress: { "10.0.0.1": [] },
      observedPerAsset: [{ address: "10.0.0.1", detected_count: "1" }],
    });

    // Tenant 2: two mid-score rows on `10.0.0.2` (only the newer-
    // time one survives the cap) and one low-score row on
    // `10.0.0.99` (evicted entirely — the asset must disappear from
    // `result.assets`). Distinct event_time values pin the §3 tie-
    // breaker so the cap boundary is deterministic.
    const c2 = makeMockPool({
      customerId: 2,
      cohortRows: [
        buildCohortRow({
          eventKey: "c2-m-1",
          address: "10.0.0.2",
          baselineScore: 0.5,
          eventTime: new Date("2026-05-09T11:30:01.000Z"),
          bucketCount: 2,
          cohortCount: 3,
        }),
        buildCohortRow({
          eventKey: "c2-m-2",
          address: "10.0.0.2",
          baselineScore: 0.5,
          eventTime: new Date("2026-05-09T11:30:00.000Z"),
          bucketCount: 2,
          cohortCount: 3,
        }),
        buildCohortRow({
          eventKey: "c2-l-1",
          address: "10.0.0.99",
          baselineScore: 0.01,
          eventTime: new Date("2026-05-09T11:30:00.000Z"),
          bucketCount: 1,
          cohortCount: 3,
        }),
      ],
      detailRowsByAddress: {
        "10.0.0.2": [],
        "10.0.0.99": [],
      },
      observedPerAsset: [
        { address: "10.0.0.2", detected_count: "2" },
        { address: "10.0.0.99", detected_count: "1" },
      ],
    });
    mockGetCustomerPool.mockImplementation(async (id: number) =>
      id === 1 ? c1.pool : c2.pool,
    );
    const { loadTriagePeriod } = await import("@/lib/triage/server-actions");
    const result = await loadTriagePeriod(
      makeSession({ roles: ["System Administrator"] }),
      PERIOD,
    );
    expect(result.truncated).toBe(true);
    // Cap = 2: keeps the 0.9 row (10.0.0.1) and the newer 0.5 row
    // (10.0.0.2 / `c2-m-1`); evicts the older 0.5 row and the 0.01
    // row.
    expect(result.events).toHaveLength(2);
    const addresses = result.assets.map((a) => a.address);
    // `10.0.0.99` is gone — its only row was evicted by the cap.
    expect(addresses).not.toContain("10.0.0.99");
    expect(addresses).toContain("10.0.0.1");
    expect(addresses).toContain("10.0.0.2");
    const a1 = result.assets.find((a) => a.address === "10.0.0.1");
    expect(a1?.triagedCount).toBe(1);
    expect(a1?.score).toBeCloseTo(0.9);
    // `10.0.0.2`: one row survived (the newer-time `c2-m-1`); the
    // older `c2-m-2` was evicted at the cap boundary. Score and
    // triagedCount reflect the surviving row only.
    const a2 = result.assets.find((a) => a.address === "10.0.0.2");
    expect(a2?.triagedCount).toBe(1);
    expect(a2?.score).toBeCloseTo(0.5);
    expect(a2?.lastEventTimeIso).toBe("2026-05-09T11:30:01.000Z");
    vi.doUnmock("@/lib/triage/types");
    vi.resetModules();
  });

  it("freshness header picks the worst state across customers", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([1, 2]);
    const c1 = makeMockPool({
      customerId: 1,
      cohortRows: [],
      freshness: {
        last_ingested_at: new Date("2026-05-09T11:55:00.000Z"),
        last_run_status: "ok",
        last_error: null,
      },
    });
    const c2 = makeMockPool({
      customerId: 2,
      cohortRows: [],
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
      cohortRows: [],
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

  it("issues exactly one per-asset detail SELECT per tenant regardless of asset count", async () => {
    // Regression for Round 1 Item 3: detail events used to fan out
    // one `cume_dist()` SELECT per asset row. After the batch refactor
    // the per-tenant detail read is a single SELECT keyed on
    // `orig_addr = ANY($3::inet[])`.
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([1]);
    const cohortRows: MenuCohortRow[] = [];
    const detailRowsByAddress: Record<string, Partial<DetailRow>[]> = {};
    for (let i = 0; i < 10; i++) {
      const address = `10.0.0.${i + 1}`;
      cohortRows.push(
        buildCohortRow({
          eventKey: `${i}`,
          address,
          baselineScore: 0.5 + i / 100,
          eventTime: new Date(`2026-05-09T11:${10 + i}:00.000Z`),
          bucketCount: 10,
          cohortCount: 10,
        }),
      );
      detailRowsByAddress[address] = [
        { event_key: `${i}`, baseline_score: 0.5 + i / 100 },
      ];
    }
    const { pool, queries } = makeMockPool({
      customerId: 1,
      cohortRows,
      detailRowsByAddress,
      observedTotal: 10,
      triagedTotal: 10,
    });
    mockGetCustomerPool.mockResolvedValue(pool);
    const { loadTriagePeriod } = await import("@/lib/triage/server-actions");
    const result = await loadTriagePeriod(
      makeSession({ roles: ["System Administrator"] }),
      PERIOD,
    );
    expect(result.assets).toHaveLength(10);
    const detailQueries = queries.filter(
      (q) =>
        q.sql.includes("cume_dist()") &&
        q.sql.includes("PARTITION BY orig_addr"),
    );
    expect(detailQueries).toHaveLength(1);
    // Batched detail SELECT receives the full address list via ANY().
    expect(detailQueries[0].params?.[2]).toEqual(
      expect.arrayContaining(["10.0.0.1", "10.0.0.10"]),
    );
  });

  it("derives the asset list from the §4 final_menu_rows (rows outside the menu do not rank)", async () => {
    // The cohort puts an asset that should make the menu (HttpThreat
    // with the unlabeled tag → favored bucket) alongside an asset
    // with a row whose `baseline_score` is below the (test-injected)
    // strict-enough cohort that the algorithm's quota cannot pick it
    // up. With production cutoff = 0 and `default_N` ≥ 20 every row
    // here survives the menu, so the asset list reflects both rows
    // — but the score / triagedCount are read from the menu set, not
    // from a parallel full-corpus aggregate.
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([1]);
    const { pool } = makeMockPool({
      customerId: 1,
      cohortRows: [
        buildCohortRow({
          eventKey: "1",
          address: "10.0.0.1",
          baselineScore: 0.95,
          bucketCount: 1,
          cohortCount: 2,
          eventTime: new Date("2026-05-09T11:30:00.000Z"),
        }),
        buildCohortRow({
          eventKey: "2",
          address: "10.0.0.2",
          baselineScore: 0.05,
          bucketCount: 1,
          cohortCount: 2,
          eventTime: new Date("2026-05-09T11:20:00.000Z"),
          kind: "DnsCovertChannel",
        }),
      ],
      detailRowsByAddress: {
        "10.0.0.1": [{ event_key: "1", baseline_score: 0.95 }],
        "10.0.0.2": [{ event_key: "2", baseline_score: 0.05 }],
      },
      observedTotal: 2,
      triagedTotal: 2,
    });
    mockGetCustomerPool.mockResolvedValue(pool);
    const { loadTriagePeriod } = await import("@/lib/triage/server-actions");
    // Load with the "All" strictness stop so the 0.05-score row is
    // not filtered by the slider cutoff (#471). This test pre-dates
    // the slider and exercises the algorithm-level menu composition
    // when no user-side cutoff applies.
    const result = await loadTriagePeriod(
      makeSession({ roles: ["System Administrator"] }),
      PERIOD,
      { strictness: "all" },
    );
    expect(result.assets.map((a) => a.address)).toEqual([
      "10.0.0.1",
      "10.0.0.2",
    ]);
    expect(result.assets[0].score).toBeCloseTo(0.95);
    expect(result.assets[1].score).toBeCloseTo(0.05);
    // result.events is the §4 final_menu_rows in score DESC order.
    expect(result.events.map((e) => e.id)).toEqual(["1", "2"]);
  });

  it("never selects orig_addr IS NULL aggregates (acceptance: no synthetic NULL row)", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([1]);
    const { pool, queries } = makeMockPool({
      customerId: 1,
      cohortRows: [],
    });
    mockGetCustomerPool.mockResolvedValue(pool);
    const { loadTriagePeriod } = await import("@/lib/triage/server-actions");
    await loadTriagePeriod(
      makeSession({ roles: ["System Administrator"] }),
      PERIOD,
    );
    // The remaining `observed_event_meta` grouped read in the new
    // pipeline must keep its `orig_addr IS NOT NULL` filter so a row
    // with a NULL orig_addr can never produce a phantom asset entry.
    const aggregates = queries.filter(
      (q) =>
        q.sql.includes("GROUP BY") && q.sql.includes("observed_event_meta"),
    );
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
