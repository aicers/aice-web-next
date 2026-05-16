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
    expect(pool.queries).toHaveLength(1);
    const call = pool.queries[0];
    expect(call.sql).toMatch(/INSERT INTO engagement_impression/);
    expect(call.sql).toMatch(
      /ON CONFLICT \(menu_load_id, event_key\) DO NOTHING/,
    );
    // 7 shared + 2 rows * 6 per-row = 19 bound params.
    expect(call.params).toHaveLength(19);
    expect(call.params?.slice(0, 7)).toEqual([
      "00000000-0000-4000-8000-000000000001",
      "baseline",
      "2026-05-01T00:00:00Z",
      "2026-05-16T00:00:00Z",
      "top50",
      42,
      "acct-hmac",
    ]);
    expect(call.params?.slice(7, 13)).toEqual([
      "evt-1",
      "HttpThreat",
      "HttpThreat:false",
      1,
      "phase1b-four-selector",
      "quota",
    ]);
    expect(call.params?.slice(13, 19)).toEqual([
      "evt-2",
      "DnsCovertChannel",
      "DnsCovertChannel:false",
      2,
      "phase1b-four-selector",
      "story_protected",
    ]);
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
    expect(call.params).toHaveLength(15);
    const params = call.params as unknown[];
    expect(params[0]).toBe("asset_select");
    expect(params[1]).toBeNull(); // event_key
    expect(params[6]).toBe("baseline"); // surface
    const assetKeyHmac = params[7] as string;
    expect(assetKeyHmac).toMatch(/^[0-9a-f]{64}$/);
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
      dimension: "sensor",
      pivotValueJoinId: "sensor-7",
    });

    const params = pool.queries[0].params as unknown[];
    expect(params[9]).toBe("sensor-7"); // pivot_value_join_id
    expect(params[10]).toBeNull(); // pivot_value_hmac
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
      storyId: "story-7",
      dimension: "origAddr",
      pivotValue: "10.0.0.1",
    });

    const params = pool.queries[0].params as unknown[];
    expect(params[0]).toBe("story_pivot_click");
    expect(params[8]).toBe("origAddr"); // dimension
    expect(params[10]).toMatch(/^[0-9a-f]{64}$/); // pivot_value_hmac
    expect(params[11]).toBe("story-7"); // story_id
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
