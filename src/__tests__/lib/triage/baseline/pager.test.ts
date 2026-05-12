import { describe, expect, it, vi } from "vitest";
import { REVIEW_MAX_PAGE_SIZE } from "@/lib/review/limits";
import {
  type CadencePagerOptions,
  createCadencePager,
  cursorToEventKey,
} from "@/lib/triage/baseline/pager";
import {
  EMPTY_EXCLUSIONS_FINGERPRINT,
  type ExclusionRule,
} from "@/lib/triage/exclusion";

interface FakeClient {
  queries: Array<{ sql: string; params: unknown[] | undefined }>;
  query: ReturnType<typeof vi.fn>;
}

type SelectorRow = {
  event_key: string;
  s1_7d: number;
  s1_14d: number;
  s1_30d: number;
  s3_7d: string;
  s3_14d: string;
  s3_30d: string;
  s4_7d: string;
  s4_14d: string;
  s4_30d: string;
};

/**
 * Build a FakeClient that recognises the query shapes the pager issues:
 *
 *   - `INSERT INTO observed_event_meta` (single batched multi-row
 *     VALUES per page) — return a `rowCount` matching the number of
 *     parameter rows so the pager's `observedInserted` accumulator
 *     reflects the true insert count.
 *   - `INSERT INTO baseline_triaged_event` (single batched multi-row
 *     VALUES per page) — same pattern, sized by 19 columns per row.
 *   - `SELECT … cume_dist() …` (the batched Phase 2 SELECT) — return a
 *     scripted per-row map keyed by `event_key`.
 *   - any other query — empty rows, `rowCount: 1`.
 *
 * The `selectorRows` map lets a test inject the per-page raw selector
 * values that the batched SELECT would have returned against real
 * `observed_event_meta` history.
 */
const OBSERVED_COLS_PER_ROW = 11;
const BASELINE_COLS_PER_ROW = 19;
function makeClient(
  selectorRows: Map<string, Omit<SelectorRow, "event_key">> = new Map(),
): FakeClient {
  const client: FakeClient = {
    queries: [],
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      client.queries.push({ sql, params });
      if (sql.includes("cume_dist()")) {
        // The batched Phase 2 SELECT. Extract event_keys from the page
        // VALUES tuple — every fourth param starting at index 0 is an
        // event_key (event_key, kind, orig_addr, resp_addr).
        const rows: SelectorRow[] = [];
        for (let i = 0; i < (params?.length ?? 0); i += 4) {
          const eventKey = String(params?.[i]);
          const projected = selectorRows.get(eventKey) ?? {
            s1_7d: 0,
            s1_14d: 0,
            s1_30d: 0,
            s3_7d: "0",
            s3_14d: "0",
            s3_30d: "0",
            s4_7d: "0",
            s4_14d: "0",
            s4_30d: "0",
          };
          rows.push({ event_key: eventKey, ...projected });
        }
        return { rows, rowCount: rows.length };
      }
      if (sql.includes("INSERT INTO observed_event_meta")) {
        const n = Math.floor((params?.length ?? 0) / OBSERVED_COLS_PER_ROW);
        return { rows: [], rowCount: n };
      }
      if (sql.includes("INSERT INTO baseline_triaged_event")) {
        const n = Math.floor((params?.length ?? 0) / BASELINE_COLS_PER_ROW);
        return { rows: [], rowCount: n };
      }
      return { rows: [], rowCount: 1 };
    }),
  };
  return client;
}

/**
 * Slice the multi-row VALUES params of a batched INSERT into per-row
 * windows so per-event assertions stay readable. `colsPerRow` is the
 * fixed column count for the table the INSERT targets.
 */
function sliceRows<T = unknown>(
  params: unknown[] | undefined,
  colsPerRow: number,
): T[][] {
  const out: T[][] = [];
  const all = params ?? [];
  for (let i = 0; i < all.length; i += colsPerRow) {
    out.push(all.slice(i, i + colsPerRow) as T[]);
  }
  return out;
}

function eventKeyToCursor(value: bigint): string {
  return value.toString();
}

/** All three §7 statistics windows active — simulates a mature corpus. */
const ALL_WINDOWS_ACTIVE: CadencePagerOptions["activeWindowsOverride"] =
  new Set([7, 14, 30] as const);
/** Cold-start day 1 — no statistics window has activated yet. */
const NO_WINDOWS_ACTIVE: CadencePagerOptions["activeWindowsOverride"] =
  new Set();

describe("cursorToEventKey", () => {
  it("validates and returns the decimal RocksDB-key cursor unchanged", () => {
    expect(cursorToEventKey("1")).toBe("1");
    expect(cursorToEventKey("255")).toBe("255");
    expect(cursorToEventKey("123456789012345678901")).toBe(
      "123456789012345678901",
    );
    expect(cursorToEventKey("340282366920938463463374607431768211455")).toBe(
      "340282366920938463463374607431768211455",
    );
  });

  it("throws on a non-decimal cursor (rejects legacy base64 shape too)", () => {
    expect(() => cursorToEventKey("AAAA")).toThrow(/malformed edge cursor/);
    expect(() => cursorToEventKey("")).toThrow(/malformed edge cursor/);
    expect(() => cursorToEventKey("12.0")).toThrow(/malformed edge cursor/);
    expect(() => cursorToEventKey("-1")).toThrow(/malformed edge cursor/);
    expect(() =>
      cursorToEventKey("1234567890123456789012345678901234567890"),
    ).toThrow(/malformed edge cursor/);
  });
});

describe("createCadencePager — Phase 1.B four-selector pipeline", () => {
  it("two-phase per page: one batched Phase 1 INSERT, then the batched SELECT, then one batched Phase 2 INSERT", async () => {
    const cursor1 = eventKeyToCursor(BigInt(1001));
    const cursor2 = eventKeyToCursor(BigInt(1002));
    const cursor3 = eventKeyToCursor(BigInt(1003));

    const fetchPage = vi.fn(async () => ({
      eventListWithTriage: {
        pageInfo: {
          hasPreviousPage: false,
          hasNextPage: false,
          startCursor: cursor1,
          endCursor: cursor3,
        },
        edges: [
          {
            cursor: cursor1,
            node: {
              __typename: "HttpThreat",
              time: "2026-05-09T12:00:00.000Z",
              sensor: "sensor-a",
              category: "COMMAND_AND_CONTROL",
              level: "MEDIUM",
              confidence: 0.9,
              origAddr: "10.0.0.1",
              respAddr: "1.1.1.1",
              origPort: 50000,
              respPort: 443,
              host: "phish.example",
              uri: "/login",
              clusterId: "",
            },
          },
          {
            cursor: cursor2,
            node: {
              __typename: "NetworkThreat",
              time: "2026-05-09T12:01:00.000Z",
              sensor: "sensor-a",
              category: "IMPACT",
              level: "MEDIUM",
              confidence: 0.5,
              origAddr: "10.0.0.2",
              respAddr: "1.1.1.2",
              origPort: 51000,
              respPort: 443,
            },
          },
          {
            cursor: cursor3,
            node: {
              __typename: "PortScan",
              time: "2026-05-09T12:02:00.000Z",
              sensor: "sensor-a",
              category: "RECONNAISSANCE",
              level: "LOW",
              confidence: 0.1,
              origAddr: "10.0.0.3",
              respAddr: "1.1.1.3",
            },
          },
        ],
      },
    }));

    const selectorRows = new Map<string, Omit<SelectorRow, "event_key">>([
      // HttpThreat unlabeled CC: high percentile, lots of recurrence.
      [
        cursor1,
        {
          s1_7d: 0.95,
          s1_14d: 0.9,
          s1_30d: 0.8,
          s3_7d: "9",
          s3_14d: "9",
          s3_30d: "9",
          s4_7d: "4",
          s4_14d: "4",
          s4_30d: "4",
        },
      ],
      // NetworkThreat labelled IMPACT: mid percentile, no recurrence.
      [
        cursor2,
        {
          s1_7d: 0.5,
          s1_14d: 0.5,
          s1_30d: 0.5,
          s3_7d: "1",
          s3_14d: "1",
          s3_30d: "1",
          s4_7d: "1",
          s4_14d: "1",
          s4_30d: "1",
        },
      ],
      // PortScan: no §3 selectors fire (non-critical category, not
      // HttpThreat, low percentile).
      [
        cursor3,
        {
          s1_7d: 0.2,
          s1_14d: 0.2,
          s1_30d: 0.2,
          s3_7d: "1",
          s3_14d: "1",
          s3_30d: "1",
          s4_7d: "1",
          s4_14d: "1",
          s4_30d: "1",
        },
      ],
    ]);

    const pager = createCadencePager({
      fetchPage: fetchPage as unknown as CadencePagerOptions["fetchPage"],
      activeWindowsOverride: ALL_WINDOWS_ACTIVE,
    });
    const client = makeClient(selectorRows);
    const result = await pager.ingestPage(
      client as unknown as Parameters<typeof pager.ingestPage>[0],
      42,
      null,
    );
    expect(result).toEqual({
      observedInserted: 3,
      baselineInserted: 3,
      endCursor: cursor3,
      hasNextPage: false,
      exclusionsFp: EMPTY_EXCLUSIONS_FINGERPRINT,
    });

    // Phase 1: one batched observed_event_meta INSERT carrying every
    // surviving event in one round-trip.
    const observedInserts = client.queries.filter((q) =>
      q.sql.includes("INSERT INTO observed_event_meta"),
    );
    expect(observedInserts).toHaveLength(1);
    const observedRows = sliceRows(
      observedInserts[0].params,
      OBSERVED_COLS_PER_ROW,
    );
    expect(observedRows).toHaveLength(3);

    // Phase 2: one batched SELECT before any baseline insert, then one
    // batched baseline INSERT carrying every page row.
    const sqls = client.queries.map((q) => q.sql);
    const cumeIdx = sqls.findIndex((s) => s.includes("cume_dist()"));
    expect(cumeIdx).toBeGreaterThanOrEqual(0);
    const baselineInsertIdx = sqls.findIndex((s) =>
      s.includes("INSERT INTO baseline_triaged_event"),
    );
    const observedInsertIdx = sqls.findIndex((s) =>
      s.includes("INSERT INTO observed_event_meta"),
    );
    // Phase 1 INSERT runs before the cume_dist SELECT, which runs
    // before the Phase 2 INSERT (ordering is load-bearing per RFC §3).
    expect(observedInsertIdx).toBeLessThan(cumeIdx);
    expect(cumeIdx).toBeLessThan(baselineInsertIdx);

    // Single batched baseline INSERT — RFC §3: every surviving page
    // row is persisted even when raw_score = 0 (cold start) or all §3
    // selectors miss; read-time cohort filtering, not an INSERT gate,
    // decides what the menu shows.
    const baselineInserts = client.queries.filter((q) =>
      q.sql.includes("INSERT INTO baseline_triaged_event"),
    );
    expect(baselineInserts).toHaveLength(1);
    const baselineRows = sliceRows(
      baselineInserts[0].params,
      BASELINE_COLS_PER_ROW,
    );
    expect(baselineRows).toHaveLength(3);

    // Per-row offsets (zero-indexed within each row):
    //   12 → baseline_version, 14 → category,
    //   15 → baseline_score (legacy, now NULL), 16 → raw_score,
    //   17 → selector_tags
    for (const row of baselineRows) {
      expect(row[12]).toBe("phase1b-four-selector");
      // baseline_score must be NULL on Phase 1.B rows — RFC §3 makes
      // it read-time-only.
      expect(row[15]).toBeNull();
      expect(typeof row[16]).toBe("number");
      expect(Array.isArray(row[17])).toBe(true);
    }

    // HttpThreat unlabeled CC: s1 (0.95 > 0.85) → S1-high; s2 = 1 →
    // S2-severe; s3 = 9/10 = 0.9 > 0.5 → S3-recurring; s4 = 3/4 =
    // 0.75 > 0.5 → S4-correlated; unlabeled → unlabeled-cluster.
    const httpThreatTags = baselineRows[0][17] as string[];
    expect(httpThreatTags.sort()).toEqual([
      "S1-high",
      "S2-severe",
      "S3-recurring",
      "S4-correlated",
      "unlabeled-cluster",
    ]);

    // NetworkThreat labelled IMPACT: s1 = 0.5 (no S1-high), s2 = 1 →
    // S2-severe, s3 = 0/10 = 0 (no S3), s4 = 0/4 = 0 (no S4), not
    // HttpThreat → no unlabeled. Only S2-severe.
    expect(baselineRows[1][17]).toEqual(["S2-severe"]);

    // PortScan RECONNAISSANCE: nothing fires.
    expect(baselineRows[2][17]).toEqual([]);

    // exclusions_fp threaded into every page-row tuple of the batched
    // baseline INSERT.
    for (const row of baselineRows) {
      expect(row).toContain(EMPTY_EXCLUSIONS_FINGERPRINT);
    }

    expect(fetchPage).toHaveBeenCalledTimes(1);
    const firstCallArgs = (
      fetchPage.mock.calls[0] as Array<{
        customerId: number;
        variables: {
          filter: { customers: string[] };
          triage: null;
          first: number;
          after: string | null;
        };
      }>
    )[0];
    expect(firstCallArgs).toMatchObject({
      customerId: 42,
      variables: {
        filter: { customers: ["42"] },
        triage: null,
        after: null,
      },
    });
    // #537: review-web's `Connection::pagination_input` rejects any
    // `first` outside `[0, 100]`, so the cadence pager MUST stay at or
    // below `REVIEW_MAX_PAGE_SIZE`. This bound (not an exact value)
    // is the contract — drift back to a higher constant has bricked
    // Phase 1.A/1.B corpus ingestion before.
    expect(firstCallArgs.variables.first).toBeGreaterThan(0);
    expect(firstCallArgs.variables.first).toBeLessThanOrEqual(
      REVIEW_MAX_PAGE_SIZE,
    );
  });

  it("drops events matching an active exclusion before BOTH corpus INSERTs", async () => {
    const cursor = eventKeyToCursor(BigInt(2001));
    const fetchPage = vi.fn(async () => ({
      eventListWithTriage: {
        pageInfo: {
          hasPreviousPage: false,
          hasNextPage: false,
          startCursor: cursor,
          endCursor: cursor,
        },
        edges: [
          {
            cursor,
            node: {
              __typename: "HttpThreat",
              time: "2026-05-09T12:00:00.000Z",
              sensor: "sensor-a",
              category: "COMMAND_AND_CONTROL",
              level: "MEDIUM",
              confidence: 0.8,
              origAddr: "10.0.0.5",
              host: "ads.example.com",
              clusterId: "real-cluster",
            },
          },
        ],
      },
    }));

    const rule: ExclusionRule = { hostname: ["ads.example.com"] };
    const resolver = {
      async resolve() {
        return { rules: [rule] };
      },
    };
    const pager = createCadencePager({
      fetchPage: fetchPage as unknown as CadencePagerOptions["fetchPage"],
      resolver,
      activeWindowsOverride: ALL_WINDOWS_ACTIVE,
    });
    const client = makeClient();
    const result = await pager.ingestPage(
      client as unknown as Parameters<typeof pager.ingestPage>[0],
      42,
      null,
    );

    expect(result.observedInserted).toBe(0);
    expect(result.baselineInserted).toBe(0);
    expect(client.queries.some((q) => q.sql.startsWith("INSERT INTO"))).toBe(
      false,
    );
    // No batched SELECT either — empty survivors short-circuits Phase 2.
    expect(client.queries.some((q) => q.sql.includes("cume_dist()"))).toBe(
      false,
    );
  });

  it("hard-excludes Blocklist* events from BOTH corpus INSERTs (RFC §1 denominator integrity)", async () => {
    const blockCursor = eventKeyToCursor(BigInt(3001));
    const realCursor = eventKeyToCursor(BigInt(3002));
    const fetchPage = vi.fn(async () => ({
      eventListWithTriage: {
        pageInfo: {
          hasPreviousPage: false,
          hasNextPage: false,
          startCursor: blockCursor,
          endCursor: realCursor,
        },
        edges: [
          {
            cursor: blockCursor,
            node: {
              __typename: "BlocklistHttp",
              time: "2026-05-09T12:00:00.000Z",
              sensor: "sensor-a",
              category: "RECONNAISSANCE",
              level: "LOW",
              confidence: 0.1,
              origAddr: "10.0.0.99",
              respAddr: "1.1.1.99",
              host: "blocked.example",
            },
          },
          {
            cursor: realCursor,
            node: {
              __typename: "HttpThreat",
              time: "2026-05-09T12:01:00.000Z",
              sensor: "sensor-a",
              category: "IMPACT",
              level: "MEDIUM",
              confidence: 0.7,
              origAddr: "10.0.0.1",
              respAddr: "1.1.1.1",
              host: "real.example",
              clusterId: "real-cluster",
            },
          },
        ],
      },
    }));
    const pager = createCadencePager({
      fetchPage: fetchPage as unknown as CadencePagerOptions["fetchPage"],
      activeWindowsOverride: ALL_WINDOWS_ACTIVE,
    });
    const client = makeClient();
    const result = await pager.ingestPage(
      client as unknown as Parameters<typeof pager.ingestPage>[0],
      42,
      null,
    );

    // Only the HttpThreat survives; the Blocklist event was dropped at
    // the front, never INSERTed into observed_event_meta (so it cannot
    // pollute S1 / S3 / S4 percentile / repeat / correlation aggregates
    // against the post-exclusion peer population) and never INSERTed
    // into baseline_triaged_event.
    expect(result.observedInserted).toBe(1);
    expect(result.baselineInserted).toBe(1);

    // Single batched INSERT per phase. Slice each batched VALUES tuple
    // back into per-row windows and pull out the event_key (col 0).
    const observedInserts = client.queries.filter((q) =>
      q.sql.includes("INSERT INTO observed_event_meta"),
    );
    expect(observedInserts).toHaveLength(1);
    const observedKeys = sliceRows(
      observedInserts[0].params,
      OBSERVED_COLS_PER_ROW,
    ).map((row) => row[0]);
    expect(observedKeys).toEqual([realCursor]);

    const baselineInserts = client.queries.filter((q) =>
      q.sql.includes("INSERT INTO baseline_triaged_event"),
    );
    expect(baselineInserts).toHaveLength(1);
    const baselineKeys = sliceRows(
      baselineInserts[0].params,
      BASELINE_COLS_PER_ROW,
    ).map((row) => row[0]);
    expect(baselineKeys).toEqual([realCursor]);
  });

  it("threads the after cursor and reports hasNextPage from the resolver", async () => {
    const startCursor = eventKeyToCursor(BigInt(100));
    const endCursor = eventKeyToCursor(BigInt(101));
    const fetchPage = vi.fn(async () => ({
      eventListWithTriage: {
        pageInfo: {
          hasPreviousPage: true,
          hasNextPage: true,
          startCursor,
          endCursor,
        },
        edges: [],
      },
    }));
    const pager = createCadencePager({
      fetchPage: fetchPage as unknown as CadencePagerOptions["fetchPage"],
      activeWindowsOverride: ALL_WINDOWS_ACTIVE,
    });
    const client = makeClient();
    const result = await pager.ingestPage(
      client as unknown as Parameters<typeof pager.ingestPage>[0],
      99,
      "previous-page-cursor",
    );

    expect(result.endCursor).toBe(endCursor);
    expect(result.hasNextPage).toBe(true);
    expect((fetchPage.mock.calls[0] as unknown[])[0]).toMatchObject({
      customerId: 99,
      variables: { after: "previous-page-cursor" },
    });
  });

  it("reports an empty page (no edges) without any INSERTs or batched SELECT", async () => {
    const fetchPage = vi.fn(async () => ({
      eventListWithTriage: {
        pageInfo: {
          hasPreviousPage: false,
          hasNextPage: false,
          startCursor: null,
          endCursor: null,
        },
        edges: [],
      },
    }));
    const pager = createCadencePager({
      fetchPage: fetchPage as unknown as CadencePagerOptions["fetchPage"],
      activeWindowsOverride: ALL_WINDOWS_ACTIVE,
    });
    const client = makeClient();
    const result = await pager.ingestPage(
      client as unknown as Parameters<typeof pager.ingestPage>[0],
      42,
      null,
    );
    expect(result).toEqual({
      observedInserted: 0,
      baselineInserted: 0,
      endCursor: null,
      hasNextPage: false,
      exclusionsFp: EMPTY_EXCLUSIONS_FINGERPRINT,
    });
    expect(client.queries.some((q) => q.sql.startsWith("INSERT INTO"))).toBe(
      false,
    );
    expect(client.queries.some((q) => q.sql.includes("cume_dist()"))).toBe(
      false,
    );
  });

  it("computes raw_score = 0.5 for an unlabeled-only HttpThreat under no active windows (cold start day 1)", async () => {
    const cursor = eventKeyToCursor(BigInt(4001));
    const fetchPage = vi.fn(async () => ({
      eventListWithTriage: {
        pageInfo: {
          hasPreviousPage: false,
          hasNextPage: false,
          startCursor: cursor,
          endCursor: cursor,
        },
        edges: [
          {
            cursor,
            node: {
              __typename: "HttpThreat",
              time: "2026-05-09T12:00:00.000Z",
              sensor: "sensor-a",
              category: "RECONNAISSANCE", // not in CRITICAL_CATEGORIES
              level: "LOW",
              confidence: 0.5,
              origAddr: "10.0.0.9",
              host: "novel.example",
              clusterId: "none",
            },
          },
        ],
      },
    }));
    const pager = createCadencePager({
      fetchPage: fetchPage as unknown as CadencePagerOptions["fetchPage"],
      activeWindowsOverride: NO_WINDOWS_ACTIVE,
    });
    const client = makeClient();
    const result = await pager.ingestPage(
      client as unknown as Parameters<typeof pager.ingestPage>[0],
      42,
      null,
    );
    expect(result.baselineInserted).toBe(1);
    const baseInsert = client.queries.find((q) =>
      q.sql.includes("INSERT INTO baseline_triaged_event"),
    );
    expect(baseInsert).toBeDefined();
    // baseline_score: NULL on Phase 1.B.
    expect(baseInsert?.params?.[15]).toBeNull();
    // raw_score = w_UNLABELED * 1 = 0.5 (only the UNLABELED_BONUS
    // fires in a non-critical-category cold-start row).
    expect(baseInsert?.params?.[16]).toBeCloseTo(0.5, 10);
    expect(baseInsert?.params?.[17]).toEqual(["unlabeled-cluster"]);
  });

  it("emits no S3 / S4 tags when orig_addr IS NULL even with non-zero per-window numerators (NULL-address contract)", async () => {
    const cursor = eventKeyToCursor(BigInt(5001));
    const fetchPage = vi.fn(async () => ({
      eventListWithTriage: {
        pageInfo: {
          hasPreviousPage: false,
          hasNextPage: false,
          startCursor: cursor,
          endCursor: cursor,
        },
        edges: [
          {
            cursor,
            node: {
              __typename: "RdpBruteForce",
              time: "2026-05-09T12:00:00.000Z",
              sensor: "sensor-a",
              category: "CREDENTIAL_ACCESS",
              level: "MEDIUM",
              confidence: 0.6,
              // No origAddr / respAddr — RdpBruteForce omits them.
            },
          },
        ],
      },
    }));
    // Synthetic per-window values that would trip S3 / S4 tags if not
    // for the NULL-address guard.
    const selectorRows = new Map([
      [
        cursor,
        {
          s1_7d: 0.5,
          s1_14d: 0.5,
          s1_30d: 0.5,
          s3_7d: "100",
          s3_14d: "100",
          s3_30d: "100",
          s4_7d: "100",
          s4_14d: "100",
          s4_30d: "100",
        },
      ],
    ]);
    const pager = createCadencePager({
      fetchPage: fetchPage as unknown as CadencePagerOptions["fetchPage"],
      activeWindowsOverride: ALL_WINDOWS_ACTIVE,
    });
    const client = makeClient(selectorRows);
    await pager.ingestPage(
      client as unknown as Parameters<typeof pager.ingestPage>[0],
      42,
      null,
    );
    const baseInsert = client.queries.find((q) =>
      q.sql.includes("INSERT INTO baseline_triaged_event"),
    );
    const tags = baseInsert?.params?.[17] as string[];
    expect(tags).not.toContain("S3-recurring");
    expect(tags).not.toContain("S4-correlated");
    // S2 fires (CREDENTIAL_ACCESS ∈ CRITICAL_CATEGORIES).
    expect(tags).toContain("S2-severe");
  });
});
