/**
 * Unit tests for the measurement harness's pure helpers. The full
 * end-to-end harness run requires a representative-profile Postgres
 * tenant (and #528 owns the end-to-end campaign), but the parsing
 * and address-sampling helpers are pure functions / pool-stubbable
 * coroutines and can be exercised offline.
 */

import { describe, expect, it } from "vitest";

import { SELECT_MENU_COHORT_SQL } from "@/lib/triage/baseline/read-path-sql";
import {
  parseExplainAnalyze,
  redactDsn,
  resolveWindow,
  sampleAddresses,
} from "../../../scripts/measure-baseline-read-path.mjs";

interface MenuCohortStubRow {
  orig_addr: string | null | undefined;
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
    ) => Promise<{ rows: ReadonlyArray<MenuCohortStubRow> }>;
    capturedSql: string | null;
    capturedParams: ReadonlyArray<unknown> | null;
  }

  function makePool(rows: ReadonlyArray<MenuCohortStubRow>): StubbedPool {
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

  it("deduplicates orig_addr in cohort order and caps at the limit", async () => {
    const pool = makePool([
      { orig_addr: "10.0.0.1" },
      { orig_addr: "10.0.0.2" },
      { orig_addr: "10.0.0.1" },
      { orig_addr: "10.0.0.3" },
      { orig_addr: "10.0.0.4" },
    ]);
    const addresses = await sampleAddresses(
      pool,
      "2026-04-12T00:00:00.000Z",
      "2026-05-12T00:00:00.000Z",
      3,
    );
    expect(addresses).toEqual(["10.0.0.1", "10.0.0.2", "10.0.0.3"]);
  });

  it("skips null/undefined orig_addr values", async () => {
    const pool = makePool([
      { orig_addr: null },
      { orig_addr: "10.0.0.1" },
      { orig_addr: undefined },
      { orig_addr: "10.0.0.2" },
    ]);
    const addresses = await sampleAddresses(
      pool,
      "2026-04-12T00:00:00.000Z",
      "2026-05-12T00:00:00.000Z",
      100,
    );
    expect(addresses).toEqual(["10.0.0.1", "10.0.0.2"]);
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
