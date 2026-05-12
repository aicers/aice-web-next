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
  redactDsn,
  resolveWindow,
  runColdCommand,
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

  it("issues the shared SELECT_MENU_COHORT_SQL with (start, end, MENU_CANDIDATES_PER_BUCKET) params", async () => {
    const pool = makePool([]);
    await sampleAddresses(
      pool,
      "2026-04-12T00:00:00.000Z",
      "2026-05-12T00:00:00.000Z",
      100,
    );
    expect(pool.capturedSql).toBe(SELECT_MENU_COHORT_SQL);
    expect(pool.capturedParams).toEqual([
      "2026-04-12T00:00:00.000Z",
      "2026-05-12T00:00:00.000Z",
      500,
    ]);
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
      10,
    );
    expect(addresses).toEqual(["10.0.0.1", "10.0.0.2", "10.0.0.3"]);
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
