import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const TEST_KEY = "x".repeat(64);
const ORIGINAL_KEY = process.env.ENGAGEMENT_HMAC_KEY;

interface QueryCall {
  sql: string;
  params: unknown[] | undefined;
}

interface FakePool {
  queries: QueryCall[];
  query: (sql: string, params?: unknown[]) => Promise<{ rowCount: number }>;
}

function makePool(rowCount = 0): FakePool {
  const queries: QueryCall[] = [];
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    queries.push({ sql, params });
    return { rowCount };
  });
  return { queries, query: query as FakePool["query"] };
}

const mockGetCustomerPool = vi.hoisted(() => vi.fn());

vi.mock("@/lib/triage/policy/customer-db", () => ({
  getCustomerPool: mockGetCustomerPool,
}));

import { _resetEngagementHmacKey } from "@/lib/triage/engagement/hmac";
import { _resetEngagementSnapshotSeedCache } from "@/lib/triage/engagement/snapshot";
import {
  recordAction,
  recordImpressions,
} from "@/lib/triage/engagement/storage";

beforeAll(() => {
  process.env.ENGAGEMENT_HMAC_KEY = TEST_KEY;
  _resetEngagementHmacKey();
});

afterEach(() => {
  process.env.ENGAGEMENT_HMAC_KEY = TEST_KEY;
  _resetEngagementHmacKey();
  _resetEngagementSnapshotSeedCache();
  mockGetCustomerPool.mockReset();
});

afterEach(() => {
  if (ORIGINAL_KEY === undefined) {
    delete process.env.ENGAGEMENT_HMAC_KEY;
  } else {
    process.env.ENGAGEMENT_HMAC_KEY = ORIGINAL_KEY;
  }
  _resetEngagementHmacKey();
});

describe("recordImpressions", () => {
  it("emits a single multi-row INSERT with the correct placeholder shape", async () => {
    const pool = makePool(2);
    mockGetCustomerPool.mockResolvedValue(pool);

    const result = await recordImpressions("acct-hmac", {
      menuLoadId: "00000000-0000-4000-8000-000000000001",
      customerId: 42,
      surface: "baseline",
      strictnessStop: "top50",
      periodStartIso: "2026-05-01T00:00:00Z",
      periodEndIso: "2026-05-16T00:00:00Z",
      impressions: [
        {
          eventKey: "evt-1",
          kind: "HttpThreat",
          slotBucket: "HttpThreat:false",
          rank: 1,
          baselineVersion: "phase1b-four-selector",
          shownBy: "quota",
        },
        {
          eventKey: "evt-2",
          kind: "DnsCovertChannel",
          slotBucket: "DnsCovertChannel:false",
          rank: 2,
          baselineVersion: "phase1b-four-selector",
          shownBy: "story_protected",
        },
      ],
    });

    expect(result).toBe(2);
    // The first query is the per-pool snapshot upsert (RFC §8.2);
    // the impression INSERT follows. Both fire on the same pool.
    expect(pool.queries).toHaveLength(2);
    const snapshotCall = pool.queries[0];
    expect(snapshotCall.sql).toMatch(/INSERT INTO engagement_model_snapshot/);
    expect(snapshotCall.sql).toMatch(/ON CONFLICT \(version\) DO NOTHING/);
    expect(snapshotCall.params?.[0]).toBe("phase2-v1");

    const call = pool.queries[1];
    expect(call.sql).toMatch(/INSERT INTO engagement_impression/);
    expect(call.sql).toMatch(/engagement_model_version/);
    expect(call.sql).toMatch(
      /ON CONFLICT \(menu_load_id, event_key\) DO NOTHING/,
    );
    // 8 shared + 2 rows * 6 per-row = 20 bound params (Phase 2
    // adds engagement_model_version to the shared block).
    expect(call.params).toHaveLength(20);
    expect(call.params?.slice(0, 8)).toEqual([
      "00000000-0000-4000-8000-000000000001",
      "baseline",
      "2026-05-01T00:00:00Z",
      "2026-05-16T00:00:00Z",
      "top50",
      42,
      "acct-hmac",
      "phase2-v1",
    ]);
    expect(call.params?.slice(8, 14)).toEqual([
      "evt-1",
      "HttpThreat",
      "HttpThreat:false",
      1,
      "phase1b-four-selector",
      "quota",
    ]);
    expect(call.params?.slice(14, 20)).toEqual([
      "evt-2",
      "DnsCovertChannel",
      "DnsCovertChannel:false",
      2,
      "phase1b-four-selector",
      "story_protected",
    ]);
  });

  it("skips the snapshot upsert on a second batch against the same pool", async () => {
    const pool = makePool(1);
    mockGetCustomerPool.mockResolvedValue(pool);
    const batch = {
      menuLoadId: "00000000-0000-4000-8000-000000000001",
      customerId: 42,
      surface: "baseline",
      strictnessStop: "top50" as const,
      periodStartIso: "2026-05-01T00:00:00Z",
      periodEndIso: "2026-05-16T00:00:00Z",
      impressions: [
        {
          eventKey: "evt-1",
          kind: "HttpThreat",
          slotBucket: "HttpThreat:false",
          rank: 1,
          baselineVersion: "phase1b-four-selector",
          shownBy: "quota" as const,
        },
      ],
    };
    await recordImpressions("acct-hmac", batch);
    await recordImpressions("acct-hmac", {
      ...batch,
      menuLoadId: "00000000-0000-4000-8000-000000000002",
    });
    // Two batches: snapshot upsert once, impression INSERT twice.
    expect(pool.queries).toHaveLength(3);
    expect(pool.queries[0].sql).toMatch(/engagement_model_snapshot/);
    expect(pool.queries[1].sql).toMatch(/INSERT INTO engagement_impression/);
    expect(pool.queries[2].sql).toMatch(/INSERT INTO engagement_impression/);
  });

  it("is a no-op on an empty batch (no pool acquisition)", async () => {
    const result = await recordImpressions("acct-hmac", {
      menuLoadId: "00000000-0000-4000-8000-000000000001",
      customerId: 42,
      surface: "baseline",
      strictnessStop: "top50",
      periodStartIso: "2026-05-01T00:00:00Z",
      periodEndIso: "2026-05-16T00:00:00Z",
      impressions: [],
    });
    expect(result).toBe(0);
    expect(mockGetCustomerPool).not.toHaveBeenCalled();
  });
});

describe("recordAction", () => {
  it("inserts an asset_select row with HMAC'd asset address (raw value never bound)", async () => {
    const pool = makePool(1);
    mockGetCustomerPool.mockResolvedValue(pool);

    await recordAction("acct-hmac", {
      type: "asset_select",
      customerId: 1,
      surface: "baseline",
      assetAddress: "10.0.0.1",
    });

    expect(pool.queries).toHaveLength(1);
    const call = pool.queries[0];
    expect(call.sql).toMatch(/INSERT INTO engagement_action/);
    expect(call.sql).toMatch(/menu_load_id/);
    // Phase 2 expands to 16 params (15 + menu_load_id).
    expect(call.params).toHaveLength(16);
    const params = call.params as unknown[];
    expect(params[0]).toBe("asset_select");
    expect(params[1]).toBeNull(); // event_key
    expect(params[6]).toBe("baseline"); // surface
    const assetKeyHmac = params[7] as string;
    expect(assetKeyHmac).toMatch(/^[0-9a-f]{64}$/);
    // Non-row-bound action — menu_load_id must be NULL per the
    // schema-level CHECK.
    expect(params[15]).toBeNull(); // menu_load_id
    // No raw asset address must appear in the bound params.
    for (const p of params) {
      expect(p).not.toBe("10.0.0.1");
    }
  });

  it("inserts a pivot_click with HMAC'd pivot value and the correct shape", async () => {
    const pool = makePool(1);
    mockGetCustomerPool.mockResolvedValue(pool);

    await recordAction("acct-hmac", {
      type: "pivot_click",
      customerId: 1,
      surface: "baseline",
      eventKey: "evt-1",
      kind: "HttpThreat",
      baselineVersion: "phase1b-four-selector",
      menuLoadId: "00000000-0000-4000-8000-000000000002",
      dimension: "host",
      pivotValue: "Example.COM",
    });

    const params = pool.queries[0].params as unknown[];
    expect(params[0]).toBe("pivot_click");
    expect(params[1]).toBe("evt-1"); // event_key
    expect(params[2]).toBe("HttpThreat"); // kind
    expect(params[3]).toBe("phase1b-four-selector"); // baseline_version
    expect(params[8]).toBe("host"); // dimension
    expect(params[9]).toBeNull(); // pivot_value_join_id
    const pivotHmac = params[10] as string;
    expect(pivotHmac).toMatch(/^[0-9a-f]{64}$/);
    expect(params[15]).toBe("00000000-0000-4000-8000-000000000002"); // menu_load_id
    // No raw pivot value bound.
    for (const p of params) {
      expect(p).not.toBe("Example.COM");
      expect(p).not.toBe("example.com");
    }
  });

  it("inserts a pivot_click that carries a join id instead of an HMAC", async () => {
    const pool = makePool(1);
    mockGetCustomerPool.mockResolvedValue(pool);

    await recordAction("acct-hmac", {
      type: "pivot_click",
      customerId: 1,
      surface: "baseline",
      eventKey: "evt-1",
      kind: "HttpThreat",
      baselineVersion: "phase1b-four-selector",
      menuLoadId: "00000000-0000-4000-8000-000000000003",
      dimension: "sameSensor",
      pivotValueJoinId: "sensor-7",
    });

    const params = pool.queries[0].params as unknown[];
    expect(params[9]).toBe("sensor-7"); // pivot_value_join_id
    expect(params[10]).toBeNull(); // pivot_value_hmac
    expect(params[15]).toBe("00000000-0000-4000-8000-000000000003"); // menu_load_id
  });

  it("inserts a story_pivot_click with story_id + dimension + pivot HMAC", async () => {
    const pool = makePool(1);
    mockGetCustomerPool.mockResolvedValue(pool);

    await recordAction("acct-hmac", {
      type: "story_pivot_click",
      customerId: 1,
      surface: "baseline",
      eventKey: "evt-1",
      kind: "HttpThreat",
      baselineVersion: "phase1b-four-selector",
      menuLoadId: "00000000-0000-4000-8000-000000000004",
      storyId: "story-7",
      dimension: "externalIp",
      pivotValue: "10.0.0.1",
    });

    const params = pool.queries[0].params as unknown[];
    expect(params[0]).toBe("story_pivot_click");
    expect(params[8]).toBe("externalIp"); // dimension
    expect(params[10]).toMatch(/^[0-9a-f]{64}$/); // pivot_value_hmac
    expect(params[11]).toBe("story-7"); // story_id
    expect(params[15]).toBe("00000000-0000-4000-8000-000000000004"); // menu_load_id
  });

  it("inserts an exclusion_create with the exclusion id and no row-bound fields", async () => {
    const pool = makePool(1);
    mockGetCustomerPool.mockResolvedValue(pool);

    await recordAction("acct-hmac", {
      type: "exclusion_create",
      customerId: 1,
      surface: "baseline",
      exclusionId: "excl-99",
    });

    const params = pool.queries[0].params as unknown[];
    expect(params[0]).toBe("exclusion_create");
    expect(params[1]).toBeNull(); // event_key
    expect(params[2]).toBeNull(); // kind
    expect(params[12]).toBe("excl-99"); // exclusion_id
  });

  // Phase 2 joins/counts depend on equivalent pivot values producing the
  // same HMAC. The dimension switch in `hmacForDimension` must be keyed
  // to the actual `PivotDimensionId` strings the panel sends (#588 review
  // round 1 item 3); a fall-through to `hmacNormalized(trim)` bypasses
  // the IP/domain/fingerprint/country normalizers and fragments joins.
  describe("hmacForDimension wiring (pivot-dimension normalization)", () => {
    async function emitPivot(
      dimension: string,
      pivotValue: string,
    ): Promise<string> {
      const pool = makePool(1);
      mockGetCustomerPool.mockResolvedValue(pool);
      await recordAction("acct-hmac", {
        type: "pivot_click",
        customerId: 1,
        surface: "baseline",
        eventKey: "evt-1",
        kind: "HttpThreat",
        baselineVersion: "phase1b-four-selector",
        menuLoadId: "00000000-0000-4000-8000-000000000005",
        dimension,
        pivotValue,
      });
      return (pool.queries[0].params as unknown[])[10] as string;
    }

    it("externalIp / internalIp use the IP normalizer (leading-zero IPv4 → canonical)", async () => {
      const canonical = await emitPivot("externalIp", "10.0.0.1");
      // Leading-zero IPv4 form normalizes to the same HMAC.
      const leadingZero = await emitPivot("externalIp", "010.000.000.001");
      expect(leadingZero).toBe(canonical);
      const internal = await emitPivot("internalIp", "010.000.000.001");
      expect(internal).toBe(canonical);
    });

    it("registrableDomain / sni use the domain normalizer (punycode + lowercase + trailing-dot strip)", async () => {
      const canonical = await emitPivot("registrableDomain", "example.com");
      expect(await emitPivot("registrableDomain", "EXAMPLE.com.")).toBe(
        canonical,
      );
      // sni rides the same normalizer so an SNI capture of the same
      // host joins against the registrableDomain HMAC.
      expect(await emitPivot("sni", "Example.COM")).toBe(canonical);
    });

    it("ja3 / ja3s use the fingerprint normalizer (lowercase hex)", async () => {
      const canonical = await emitPivot(
        "ja3",
        "771,4865-4866-4867,0-23-65281,29-23-24,0",
      );
      const upper = await emitPivot(
        "ja3",
        "771,4865-4866-4867,0-23-65281,29-23-24,0".toUpperCase(),
      );
      expect(upper).toBe(canonical);
      // ja3s — the registry uses lowercase id, not the old `ja3S`.
      const ja3sCanonical = await emitPivot("ja3s", "abc123");
      expect(await emitPivot("ja3s", "ABC123")).toBe(ja3sCanonical);
    });

    it("country uses the ISO-3166 alpha-2 uppercase normalizer", async () => {
      const canonical = await emitPivot("country", "US");
      expect(await emitPivot("country", "us")).toBe(canonical);
    });

    it("unknown dimensions fall through to the generic normalizer (trim only)", async () => {
      const a = await emitPivot("brandNewDimensionId", "abc");
      const b = await emitPivot("brandNewDimensionId", "  abc  ");
      expect(a).toBe(b);
    });
  });

  it("inserts a strictness_change with from/to stop names", async () => {
    const pool = makePool(1);
    mockGetCustomerPool.mockResolvedValue(pool);

    await recordAction("acct-hmac", {
      type: "strictness_change",
      customerId: 1,
      surface: "baseline",
      strictnessFrom: "top50",
      strictnessTo: "top20",
    });

    const params = pool.queries[0].params as unknown[];
    expect(params[0]).toBe("strictness_change");
    expect(params[13]).toBe("top50"); // strictness_from
    expect(params[14]).toBe("top20"); // strictness_to
  });
});
