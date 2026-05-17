/**
 * Unit tests for the measurement harness's pure helpers. The full
 * end-to-end harness run requires a representative-profile Postgres
 * tenant (and #528 owns the end-to-end campaign), but the parsing,
 * address-sampling, and cold-command helpers are pure functions /
 * pool-stubbable coroutines and can be exercised offline.
 */

import { describe, expect, it } from "vitest";

import { SELECT_MENU_COHORT_SQL } from "@/lib/triage/baseline/read-path-sql";
import {
  parseExplainAnalyze,
  partitionMeasurableQueries,
  probeR3CandidateAssets,
  redactDsn,
  resolveWindow,
  runColdCommand,
  runColdPhase,
  sampleAddresses,
} from "../../../scripts/measure-baseline-read-path.mjs";

type StubCohortRow = Record<string, unknown>;

/**
 * Build a minimal cohort row carrying the columns
 * `addressesFromCohortRows` actually reads. Real rows have many more
 * fields; defaults below are RFC-shape compatible (HttpThreat with
 * the unlabeled-cluster tag = the `('HttpThreat', true)` favored
 * bucket, so the row is always allocated quota).
 */
function makeCohortRow(overrides: Partial<StubCohortRow>): StubCohortRow {
  return {
    event_key: "1",
    event_time: new Date("2026-05-09T12:00:00.000Z"),
    kind: "HttpThreat",
    baseline_version: "phase1b-four-selector",
    raw_score: 1.0,
    baseline_score: 1.0,
    selector_tags: ["unlabeled-cluster"],
    is_unlabeled: true,
    bucket_count: "1",
    bucket_tag_sum: "1",
    cohort_count: "1",
    orig_addr: "10.0.0.1",
    ...overrides,
  };
}

describe("measure-baseline-read-path — parseExplainAnalyze", () => {
  it("extracts Execution Time and top-node actual rows from text-format EXPLAIN ANALYZE", () => {
    const plan = [
      "Sort  (cost=12.34..15.67 rows=400 width=128) (actual time=2.105..2.456 rows=187 loops=1)",
      "  Sort Key: foo.bar",
      "  ->  Seq Scan on foo  (cost=0.00..10.00 rows=400 width=128) (actual time=0.012..1.999 rows=187 loops=1)",
      "Planning Time: 0.234 ms",
      "Execution Time: 3.789 ms",
    ].join("\n");
    expect(parseExplainAnalyze(plan)).toEqual({
      elapsedMs: 3.789,
      rowCount: 187,
    });
  });

  it("returns rowCount=0 when the plan has no top-node row count line", () => {
    const plan = ["Result", "Execution Time: 0.123 ms"].join("\n");
    expect(parseExplainAnalyze(plan)).toEqual({
      elapsedMs: 0.123,
      rowCount: 0,
    });
  });

  it("throws when Execution Time is missing (non-ANALYZE EXPLAIN run by mistake)", () => {
    const plan = "Seq Scan on foo  (cost=0.00..10.00 rows=400 width=128)";
    expect(() => parseExplainAnalyze(plan)).toThrow(/Execution Time/);
  });
});

describe("measure-baseline-read-path — sampleAddresses", () => {
  interface StubbedPool {
    query: (
      sql: string,
      params: ReadonlyArray<unknown>,
    ) => Promise<{ rows: ReadonlyArray<StubCohortRow> }>;
    capturedSql: string | null;
    capturedParams: ReadonlyArray<unknown> | null;
  }

  function makePool(rows: ReadonlyArray<StubCohortRow>): StubbedPool {
    const pool: StubbedPool = {
      capturedSql: null,
      capturedParams: null,
      async query(sql, params) {
        pool.capturedSql = sql;
        pool.capturedParams = params;
        return { rows };
      },
    };
    return pool;
  }

  it("issues the shared SELECT_MENU_COHORT_SQL with (start, end, MENU_CANDIDATES_PER_BUCKET) params — the strictness cutoff is applied in composeMenu, not in SQL", async () => {
    const pool = makePool([]);
    await sampleAddresses(
      pool,
      "2026-04-12T00:00:00.000Z",
      "2026-05-12T00:00:00.000Z",
    );
    expect(pool.capturedSql).toBe(SELECT_MENU_COHORT_SQL);
    expect(pool.capturedParams).toEqual([
      "2026-04-12T00:00:00.000Z",
      "2026-05-12T00:00:00.000Z",
      500,
    ]);
  });

  it("does NOT add a 4th SQL bind when an explicit menuCutoff is passed — the cutoff threads into composeMenu via addressesFromCohortRows so the full-cohort bucket aggregates are preserved", async () => {
    const pool = makePool([]);
    await sampleAddresses(
      pool,
      "2026-04-12T00:00:00.000Z",
      "2026-05-12T00:00:00.000Z",
      0.5,
    );
    expect(pool.capturedParams).toEqual([
      "2026-04-12T00:00:00.000Z",
      "2026-05-12T00:00:00.000Z",
      500,
    ]);
  });

  it("applies an explicit menuCutoff at the composeMenu step so a high cutoff narrows the returned addresses", async () => {
    // Two rows in the favored unlabeled-HttpThreat bucket, one with
    // baseline_score above the cutoff and one below. The high-cutoff
    // sample should keep only the surviving address.
    const rows = [
      makeCohortRow({
        event_key: "1",
        orig_addr: "10.0.0.1",
        baseline_score: 0.99,
        cohort_count: "2",
        bucket_count: "2",
      }),
      makeCohortRow({
        event_key: "2",
        orig_addr: "10.0.0.2",
        baseline_score: 0.3,
        cohort_count: "2",
        bucket_count: "2",
      }),
    ];
    const pool = makePool(rows);
    const addresses = await sampleAddresses(
      pool,
      "2026-04-12T00:00:00.000Z",
      "2026-05-12T00:00:00.000Z",
      0.95,
    );
    expect(addresses).toEqual(["10.0.0.1"]);
  });

  it("returns the addresses produced by composeMenu over the cohort rows (not a SQL-only superset)", async () => {
    // Two rows in the favored unlabeled-HttpThreat bucket, plus a
    // duplicate orig_addr to exercise the dedupe pass and a row with
    // null orig_addr to exercise the skip-null pass that
    // `uniqueAddresses` performs in production.
    const rows = [
      makeCohortRow({ event_key: "1", orig_addr: "10.0.0.1" }),
      makeCohortRow({ event_key: "2", orig_addr: "10.0.0.2" }),
      makeCohortRow({ event_key: "3", orig_addr: "10.0.0.1" }),
      makeCohortRow({ event_key: "4", orig_addr: null }),
      makeCohortRow({ event_key: "5", orig_addr: "10.0.0.3" }),
    ].map((r, i) => ({
      ...r,
      cohort_count: "5",
      bucket_count: "5",
      // Distinct baseline_score so production sort order is deterministic.
      baseline_score: 1 - i * 0.01,
    }));
    const pool = makePool(rows);
    const addresses = await sampleAddresses(
      pool,
      "2026-04-12T00:00:00.000Z",
      "2026-05-12T00:00:00.000Z",
    );
    expect(addresses).toEqual(["10.0.0.1", "10.0.0.2", "10.0.0.3"]);
  });

  it("does NOT cap the returned address list at TRIAGE_ASSET_PAGE_SIZE — production drives the per-tenant fanout from the uncapped uniqueAddresses(events)", async () => {
    // Build a cohort large enough that composeMenu's §6 default_N
    // (≈ 20 + 30 * log10(1 + postExclusionCount)) selects more than
    // 100 menu rows. With postExclusionCount = 300, default_N ≈ 94;
    // bump to 100k so default_N is well above the 100-row mark
    // (≈ 20 + 30 * log10(100001) ≈ 170). Each row carries a unique
    // orig_addr so the dedupe pass cannot shave the list back down.
    const TOTAL = 300;
    const rows = Array.from({ length: TOTAL }, (_, i) =>
      makeCohortRow({
        event_key: String(i + 1),
        orig_addr: `10.${Math.floor(i / 256)}.${i % 256}.1`,
        cohort_count: "100000",
        bucket_count: String(TOTAL),
        baseline_score: 1 - i * 1e-5,
      }),
    );
    const pool = makePool(rows);
    const addresses = await sampleAddresses(
      pool,
      "2026-04-12T00:00:00.000Z",
      "2026-05-12T00:00:00.000Z",
    );
    // Regression: the prior harness truncated to 100. The production
    // read path does not — `loadCustomerSlice` calls
    // `uniqueAddresses(events)` without a cap, so the planner can
    // legitimately see >100 addresses for `perAssetObservedCounts` /
    // `selectAssetDetailEventsBatch`.
    expect(addresses.length).toBeGreaterThan(100);
  });
});

describe("measure-baseline-read-path — resolveWindow", () => {
  const NOW_MS = new Date("2026-05-12T12:00:00.000Z").getTime();

  it("resolves 30d to a 30-day half-open window anchored at now", () => {
    expect(resolveWindow("30d", NOW_MS)).toEqual({
      periodStartIso: "2026-04-12T12:00:00.000Z",
      periodEndIso: "2026-05-12T12:00:00.000Z",
    });
  });

  it("resolves Nh to an N-hour window", () => {
    expect(resolveWindow("6h", NOW_MS)).toEqual({
      periodStartIso: "2026-05-12T06:00:00.000Z",
      periodEndIso: "2026-05-12T12:00:00.000Z",
    });
  });

  it("throws on unrecognized window spec", () => {
    expect(() => resolveWindow("30w", NOW_MS)).toThrow(/invalid --window/);
  });
});

describe("measure-baseline-read-path — redactDsn", () => {
  it("masks the password segment of a DSN", () => {
    expect(redactDsn("postgres://user:secret@host:5432/db")).toBe(
      "postgres://user:***@host:5432/db",
    );
  });

  it("returns a sentinel for an unparseable DSN", () => {
    expect(redactDsn("not a url")).toBe("<unparseable-dsn>");
  });
});

describe("measure-baseline-read-path — runColdCommand", () => {
  it("returns mode 'absent' with the host-policy label when no command is supplied", () => {
    const result = runColdCommand(null);
    expect(result.mode).toBe("absent");
    expect(result.label).toMatch(/not available — host policy/);
  });

  it("returns mode 'captured' when the command exits 0", () => {
    let invokedWith: string | null = null;
    const result = runColdCommand("/bin/true", (cmd) => {
      invokedWith = cmd;
      return { status: 0 };
    });
    expect(invokedWith).toBe("/bin/true");
    expect(result.mode).toBe("captured");
    expect(result.label).toMatch(/captured via --cold-command=/);
    expect(result.label).toMatch(/one invocation per measured query/);
  });

  it("returns mode 'failed' when the command exits non-zero — caller must NOT emit cold-phase samples", () => {
    const result = runColdCommand("/bin/false", () => ({ status: 1 }));
    expect(result.mode).toBe("failed");
    expect(result.label).toMatch(/exited 1/);
    expect(result.label).toMatch(/no cold-phase samples emitted/);
  });

  it("labels signal exits when status is null", () => {
    const result = runColdCommand("/bin/false", () => ({ status: null }));
    expect(result.mode).toBe("failed");
    expect(result.label).toMatch(/<signal>/);
  });
});

describe("measure-baseline-read-path — runColdPhase", () => {
  interface StubClient {
    queries: string[];
    query: (
      sql: string,
      params?: ReadonlyArray<unknown>,
    ) => Promise<{ rows: ReadonlyArray<Record<string, string>> }>;
    release: () => void;
  }

  interface StubPool {
    id: number;
    ended: boolean;
    client: StubClient;
    connect: () => Promise<StubClient>;
    end: () => Promise<void>;
  }

  /**
   * Build a stub `pg.Pool` whose `EXPLAIN ANALYZE` response includes
   * the minimal "Execution Time:" + "actual time ... rows=..." lines
   * `parseExplainAnalyze` requires.
   */
  function makeStubPool(idCounter: { next: number }): StubPool {
    const id = idCounter.next++;
    const pool: StubPool = {
      id,
      ended: false,
      client: {
        queries: [],
        async query(sql) {
          pool.client.queries.push(sql);
          return {
            rows: [
              {
                "QUERY PLAN":
                  `Seq Scan on x (actual time=0.010..1.234 rows=${id + 7} loops=1)\n` +
                  "Execution Time: 4.321 ms",
              },
            ],
          };
        },
        release() {
          /* no-op */
        },
      },
      async connect() {
        return pool.client;
      },
      async end() {
        pool.ended = true;
      },
    };
    return pool;
  }

  const measuredQueries = [
    {
      name: "q1",
      context: "default" as const,
      sql: "SELECT 1",
      buildParams: () => [] as ReadonlyArray<unknown>,
    },
    {
      name: "q2",
      context: "default" as const,
      sql: "SELECT 2",
      buildParams: () => [] as ReadonlyArray<unknown>,
    },
    {
      name: "q3",
      context: "default" as const,
      sql: "SELECT 3",
      buildParams: () => [] as ReadonlyArray<unknown>,
    },
  ];

  it("emits no cold samples and reports 'host policy' when --cold-command is absent", async () => {
    let spawnCalls = 0;
    const result = await runColdPhase({
      coldCommand: null,
      queries: measuredQueries,
      ctx: {},
      makePool: () => {
        throw new Error("makePool must not be called when no cold command");
      },
      spawn: () => {
        spawnCalls += 1;
        return { status: 0 };
      },
    });
    expect(spawnCalls).toBe(0);
    expect(result.samples).toEqual([]);
    expect(result.label).toMatch(/not available — host policy/);
  });

  it("re-invokes --cold-command and opens a fresh pool for EACH measured query when all invocations succeed", async () => {
    const idCounter = { next: 0 };
    const pools: StubPool[] = [];
    const spawnCalls: string[] = [];
    const result = await runColdPhase({
      coldCommand: "drop-caches",
      queries: measuredQueries,
      ctx: {},
      makePool: () => {
        const p = makeStubPool(idCounter);
        pools.push(p);
        return p;
      },
      spawn: (cmd) => {
        spawnCalls.push(cmd);
        return { status: 0 };
      },
    });
    // The cold command is invoked once per query (NOT once for the
    // whole phase) — this is the regression guard for the Round 4
    // correctness fix.
    expect(spawnCalls).toEqual(["drop-caches", "drop-caches", "drop-caches"]);
    // One fresh pool per query, each closed after its sample.
    expect(pools).toHaveLength(measuredQueries.length);
    expect(pools.every((p) => p.ended)).toBe(true);
    // Each pool received exactly one EXPLAIN ANALYZE call.
    expect(pools.map((p) => p.client.queries.length)).toEqual([1, 1, 1]);
    // One cold sample per query, all phase: "cold".
    expect(result.samples).toHaveLength(measuredQueries.length);
    expect(result.samples.map((s) => s.query)).toEqual(["q1", "q2", "q3"]);
    expect(result.samples.every((s) => s.phase === "cold")).toBe(true);
    expect(result.label).toMatch(/captured via --cold-command=/);
  });

  it("emits NO cold samples when the FIRST cold-command invocation fails (atomic semantics)", async () => {
    const pools: StubPool[] = [];
    const idCounter = { next: 0 };
    const result = await runColdPhase({
      coldCommand: "drop-caches",
      queries: measuredQueries,
      ctx: {},
      makePool: () => {
        const p = makeStubPool(idCounter);
        pools.push(p);
        return p;
      },
      spawn: () => ({ status: 1 }),
    });
    expect(pools).toEqual([]);
    expect(result.samples).toEqual([]);
    expect(result.label).toMatch(/exited 1/);
    expect(result.label).toMatch(/no cold-phase samples emitted/);
  });

  it("DISCARDS partial cold samples when a later cold-command invocation fails (atomic semantics)", async () => {
    const pools: StubPool[] = [];
    const idCounter = { next: 0 };
    let spawnCalls = 0;
    const result = await runColdPhase({
      coldCommand: "drop-caches",
      queries: measuredQueries,
      ctx: {},
      makePool: () => {
        const p = makeStubPool(idCounter);
        pools.push(p);
        return p;
      },
      // Succeed on iteration 0 and 1, fail on iteration 2.
      spawn: () => {
        spawnCalls += 1;
        return { status: spawnCalls === 3 ? 7 : 0 };
      },
    });
    // First two iterations opened pools and captured cold samples,
    // but the third invocation failed — atomic semantics discard the
    // partial cold samples so #528 doesn't silently consume a
    // mix of cold + warm-after-cold + missing.
    expect(pools).toHaveLength(2);
    expect(pools.every((p) => p.ended)).toBe(true);
    expect(result.samples).toEqual([]);
    expect(result.label).toMatch(/failed on query 3\/3 \(q3:default\)/);
    expect(result.label).toMatch(
      /no cold-phase samples emitted \(cold state was not established for all measured queries\)/,
    );
  });

  it("labels cold samples with the entry's context — first-tick / slop-replay (issue #601)", async () => {
    const idCounter = { next: 0 };
    const result = await runColdPhase({
      coldCommand: "drop-caches",
      queries: [
        {
          name: "readR1Candidates",
          context: "first-tick" as const,
          sql: "SELECT 1",
          buildParams: () => [] as ReadonlyArray<unknown>,
        },
        {
          name: "readR1Candidates",
          context: "slop-replay" as const,
          sql: "SELECT 2",
          buildParams: () => [] as ReadonlyArray<unknown>,
        },
      ],
      ctx: {},
      makePool: () => makeStubPool(idCounter),
      spawn: () => ({ status: 0 }),
    });
    expect(result.samples).toHaveLength(2);
    expect(result.samples.map((s) => s.context)).toEqual([
      "first-tick",
      "slop-replay",
    ]);
    expect(result.samples.every((s) => s.query === "readR1Candidates")).toBe(
      true,
    );
  });

  it("atomic-failure label names the failing (query, context) pair (issue #601)", async () => {
    const idCounter = { next: 0 };
    let spawnCalls = 0;
    const result = await runColdPhase({
      coldCommand: "drop-caches",
      queries: [
        {
          name: "readR1Candidates",
          context: "first-tick" as const,
          sql: "SELECT 1",
          buildParams: () => [] as ReadonlyArray<unknown>,
        },
        {
          name: "readR1Candidates",
          context: "slop-replay" as const,
          sql: "SELECT 2",
          buildParams: () => [] as ReadonlyArray<unknown>,
        },
      ],
      ctx: {},
      makePool: () => makeStubPool(idCounter),
      spawn: () => {
        spawnCalls += 1;
        return { status: spawnCalls === 2 ? 4 : 0 };
      },
    });
    expect(result.samples).toEqual([]);
    expect(result.label).toMatch(
      /failed on query 2\/2 \(readR1Candidates:slop-replay\)/,
    );
  });
});

describe("measure-baseline-read-path — probeR3CandidateAssets", () => {
  function makePool(
    firstTickRows: ReadonlyArray<Record<string, string | null>>,
    slopReplayRows: ReadonlyArray<Record<string, string | null>>,
  ) {
    const calls: Array<{ sql: string; params: ReadonlyArray<unknown> }> = [];
    const pool = {
      calls,
      async query(sql: string, params: ReadonlyArray<unknown>) {
        calls.push({ sql, params });
        // First call is first-tick (one-bound SQL); second call is
        // slop-replay (two-bound SQL).
        if (calls.length === 1) return { rows: firstTickRows };
        return { rows: slopReplayRows };
      },
    };
    return pool;
  }

  it("runs phase-1 once per context and returns deduped asset lists", async () => {
    const pool = makePool(
      [{ orig_addr: "10.0.0.1" }, { orig_addr: "10.0.0.2" }],
      [
        { orig_addr: "10.0.0.3" },
        { orig_addr: "10.0.0.3" },
        { orig_addr: "10.0.0.4" },
      ],
    );
    const result = await probeR3CandidateAssets(pool, {
      memberScanStartIso: "2026-05-11T23:00:00.000Z",
      memberScanEndIso: "2026-05-12T00:00:00.000Z",
    });
    expect(pool.calls).toHaveLength(2);
    expect(result.firstTick).toEqual(["10.0.0.1", "10.0.0.2"]);
    // Dedup pass collapses the duplicate `10.0.0.3` so phase-2's
    // `$N::inet[]` bind is well-formed.
    expect(result.slopReplay).toEqual(["10.0.0.3", "10.0.0.4"]);
  });

  it("skips the slop-replay probe when memberScanStartIso is null (fresh tenant — no previous watermark)", async () => {
    const pool = makePool([{ orig_addr: "10.0.0.1" }], []);
    const result = await probeR3CandidateAssets(pool, {
      memberScanStartIso: null,
      memberScanEndIso: "2026-05-12T00:00:00.000Z",
    });
    expect(pool.calls).toHaveLength(1);
    expect(result.firstTick).toEqual(["10.0.0.1"]);
    expect(result.slopReplay).toEqual([]);
  });

  it("filters out null orig_addr rows so the phase-2 ANY bind never carries a NULL element", async () => {
    const pool = makePool(
      [{ orig_addr: null }, { orig_addr: "10.0.0.1" }, { orig_addr: null }],
      [],
    );
    const result = await probeR3CandidateAssets(pool, {
      memberScanStartIso: null,
      memberScanEndIso: "2026-05-12T00:00:00.000Z",
    });
    expect(result.firstTick).toEqual(["10.0.0.1"]);
  });
});

describe("measure-baseline-read-path — partitionMeasurableQueries", () => {
  const phase2FirstTick = {
    name: "readR3CandidatesPhase2",
    context: "first-tick" as const,
    sql: "SELECT 1",
    buildParams: () => [] as ReadonlyArray<unknown>,
  };
  const phase2SlopReplay = {
    name: "readR3CandidatesPhase2",
    context: "slop-replay" as const,
    sql: "SELECT 2",
    buildParams: () => [] as ReadonlyArray<unknown>,
  };
  const r1FirstTick = {
    name: "readR1Candidates",
    context: "first-tick" as const,
    sql: "SELECT 3",
    buildParams: () => [] as ReadonlyArray<unknown>,
  };
  const r1SlopReplay = {
    name: "readR1Candidates",
    context: "slop-replay" as const,
    sql: "SELECT 4",
    buildParams: () => [] as ReadonlyArray<unknown>,
  };
  const menuDefault = {
    name: "selectMenuCohort",
    context: "default" as const,
    sql: "SELECT 5",
    buildParams: () => [] as ReadonlyArray<unknown>,
  };

  it("keeps every entry when both phase-1 asset lists are non-empty and the watermark exists", () => {
    const { measurable, notMeasurable } = partitionMeasurableQueries(
      [
        menuDefault,
        r1FirstTick,
        r1SlopReplay,
        phase2FirstTick,
        phase2SlopReplay,
      ],
      {
        memberScanStartIso: "2026-05-11T23:00:00.000Z",
        r3CandidateAssets: {
          firstTick: ["10.0.0.1"],
          slopReplay: ["10.0.0.2"],
        },
      },
    );
    expect(measurable).toHaveLength(5);
    expect(notMeasurable).toEqual([]);
  });

  it("records phase-2 entries with zero phase-1 assets as `notMeasurable` and omits them from `measurable`", () => {
    const { measurable, notMeasurable } = partitionMeasurableQueries(
      [phase2FirstTick, phase2SlopReplay],
      {
        memberScanStartIso: "2026-05-11T23:00:00.000Z",
        r3CandidateAssets: {
          firstTick: [],
          slopReplay: ["10.0.0.2"],
        },
      },
    );
    expect(measurable).toEqual([phase2SlopReplay]);
    expect(notMeasurable).toEqual([
      {
        query: "readR3CandidatesPhase2",
        context: "first-tick",
        reason: "phase-1 returned 0 assets",
      },
    ]);
  });

  it("records both phase-2 entries as notMeasurable when both asset lists are empty (small-fixture / fresh-corpus path)", () => {
    const { measurable, notMeasurable } = partitionMeasurableQueries(
      [phase2FirstTick, phase2SlopReplay],
      {
        memberScanStartIso: "2026-05-11T23:00:00.000Z",
        r3CandidateAssets: { firstTick: [], slopReplay: [] },
      },
    );
    expect(measurable).toEqual([]);
    expect(notMeasurable.map((n) => `${n.query}:${n.context}`)).toEqual([
      "readR3CandidatesPhase2:first-tick",
      "readR3CandidatesPhase2:slop-replay",
    ]);
  });

  it("skips every slop-replay entry when `story_finalized_through` is NULL (memberScanStartIso === null)", () => {
    const { measurable, notMeasurable } = partitionMeasurableQueries(
      [r1FirstTick, r1SlopReplay, phase2FirstTick, phase2SlopReplay],
      {
        memberScanStartIso: null,
        r3CandidateAssets: { firstTick: ["10.0.0.1"], slopReplay: [] },
      },
    );
    expect(measurable.map((q) => `${q.name}:${q.context}`)).toEqual([
      "readR1Candidates:first-tick",
      "readR3CandidatesPhase2:first-tick",
    ]);
    // r1SlopReplay and phase2SlopReplay both skipped, but the
    // skip-reason for each MUST be the watermark precondition — not
    // the phase-1 zero-asset reason — so the operator sees a single
    // copy of the actionable root cause.
    expect(notMeasurable.map((n) => n.reason)).toEqual([
      expect.stringMatching(/story_finalized_through IS NULL/),
      expect.stringMatching(/story_finalized_through IS NULL/),
    ]);
  });
});
