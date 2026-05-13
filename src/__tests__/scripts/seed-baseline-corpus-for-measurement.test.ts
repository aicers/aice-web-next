/**
 * Integration test for `scripts/seed-baseline-corpus-for-measurement.mjs`
 * (issue #540). Gated on `TRIAGE_PG_TEST_URL` per the existing baseline
 * test pattern in `src/__tests__/lib/triage/baseline/read-path-sql-inet-binding.test.ts`
 * — the default `pnpm vitest run` skips this suite so no Postgres is
 * required for green CI, and the developer who wants the gate runs:
 *
 *   TRIAGE_PG_TEST_URL="postgres://postgres:postgres@localhost:5432/seed_test" \
 *     pnpm vitest run src/__tests__/scripts/seed-baseline-corpus-for-measurement.test.ts
 *
 * The suite assumes the connected DB is a customer-tenant database
 * (the `migrations/customer/*` schema is applied automatically via
 * `migrateCustomerDb` in `beforeAll`). The seed script's `--reset`
 * truncates between runs so the suite is safe to re-run against the
 * same DB.
 *
 * The profile-assertion-compatibility test seeds a full 200K / 1M row
 * corpus and invokes the #524 measurement harness — that test takes
 * several minutes and is therefore in a separate `describe` block
 * with a 10-minute test timeout. The harness exits 0 only when the
 * representative-profile assertion passes, so a green test proves the
 * seed produces a profile-conformant corpus.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";

import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { migrateCustomerDb } from "@/lib/db/migrate";

const TRIAGE_PG_TEST_URL = process.env.TRIAGE_PG_TEST_URL;
const SCRIPT_PATH = path.resolve(
  process.cwd(),
  "scripts/seed-baseline-corpus-for-measurement.mjs",
);
const HARNESS_PATH = path.resolve(
  process.cwd(),
  "scripts/measure-baseline-read-path.mjs",
);

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

interface SeedFlags {
  seed: number;
  baselineRows?: number;
  observedRows?: number;
  days?: number;
  origAddrs?: number;
  anchorTime?: string | null;
  reset?: boolean;
}

function runSeed(connectionString: string, flags: SeedFlags): RunResult {
  const args: string[] = [
    SCRIPT_PATH,
    `--connection-string=${connectionString}`,
    `--seed=${flags.seed}`,
  ];
  if (flags.baselineRows !== undefined) {
    args.push(`--baseline-rows=${flags.baselineRows}`);
  }
  if (flags.observedRows !== undefined) {
    args.push(`--observed-rows=${flags.observedRows}`);
  }
  if (flags.days !== undefined) args.push(`--days=${flags.days}`);
  if (flags.origAddrs !== undefined) {
    args.push(`--orig-addrs=${flags.origAddrs}`);
  }
  if (flags.anchorTime !== undefined && flags.anchorTime !== null) {
    args.push(`--anchor-time=${flags.anchorTime}`);
  }
  if (flags.reset) args.push("--reset");

  const result = spawnSync(process.execPath, args, {
    encoding: "utf8",
    cwd: process.cwd(),
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function runSeedSmall(connectionString: string, overrides: Partial<SeedFlags>) {
  return runSeed(connectionString, {
    seed: 1,
    baselineRows: 1000,
    observedRows: 5000,
    days: 30,
    origAddrs: 500,
    anchorTime: "2026-01-01T00:00:00Z",
    reset: true,
    ...overrides,
  });
}

async function truncateAll(pool: pg.Pool): Promise<void> {
  await pool.query("DELETE FROM baseline_corpus_state");
  await pool.query("TRUNCATE baseline_triaged_event");
  await pool.query("TRUNCATE observed_event_meta");
}

async function scalarCount(pool: pg.Pool, table: string): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM ${table}`,
  );
  return Number(rows[0].count);
}

async function corpusHash(
  pool: pg.Pool,
): Promise<{ baseline: string; observed: string }> {
  // Deterministic projection of every column we control from the seed.
  // `string_agg(... ORDER BY event_key)` plus md5 collapses the
  // entire table into one hash — two byte-identical seeds produce
  // identical hashes; any drift in row generation surfaces here.
  const baseline = await pool.query<{ hash: string | null }>(`
    SELECT md5(string_agg(
      event_key::text                                       || '|' ||
      EXTRACT(EPOCH FROM event_time)::text                  || '|' ||
      kind                                                  || '|' ||
      sensor                                                || '|' ||
      COALESCE(orig_addr::text, '')                         || '|' ||
      COALESCE(resp_addr::text, '')                         || '|' ||
      COALESCE(orig_port::text, '')                         || '|' ||
      COALESCE(resp_port::text, '')                         || '|' ||
      COALESCE(category, '')                                || '|' ||
      raw_score::text                                       || '|' ||
      array_to_string(selector_tags, ';')                   || '|' ||
      COALESCE(host, '')                                    || '|' ||
      COALESCE(dns_query, '')                               || '|' ||
      COALESCE(uri, '')                                     || '|' ||
      baseline_version                                      || '|' ||
      exclusions_fp,
      ',' ORDER BY event_key
    )) AS hash FROM baseline_triaged_event
  `);
  const observed = await pool.query<{ hash: string | null }>(`
    SELECT md5(string_agg(
      event_key::text                                       || '|' ||
      EXTRACT(EPOCH FROM event_time)::text                  || '|' ||
      kind                                                  || '|' ||
      sensor                                                || '|' ||
      COALESCE(orig_addr::text, '')                         || '|' ||
      COALESCE(resp_addr::text, '')                         || '|' ||
      COALESCE(category, '')                                || '|' ||
      COALESCE(host, '')                                    || '|' ||
      COALESCE(dns_query, '')                               || '|' ||
      COALESCE(uri, '')                                     || '|' ||
      COALESCE(confidence::text, ''),
      ',' ORDER BY event_key
    )) AS hash FROM observed_event_meta
  `);
  return {
    baseline: baseline.rows[0].hash ?? "",
    observed: observed.rows[0].hash ?? "",
  };
}

describe.skipIf(!TRIAGE_PG_TEST_URL)(
  "seed-baseline-corpus-for-measurement — correctness, determinism, --reset",
  () => {
    const connectionString = TRIAGE_PG_TEST_URL as string;
    let pool: pg.Pool;

    beforeAll(async () => {
      await migrateCustomerDb(connectionString);
      pool = new pg.Pool({ connectionString });
      await truncateAll(pool);
    }, 120_000);

    afterAll(async () => {
      if (pool !== undefined) {
        await truncateAll(pool);
        await pool.end();
      }
    });

    afterEach(async () => {
      if (pool !== undefined) await truncateAll(pool);
    });

    it("seeds with exact row counts and the documented contract constraints", async () => {
      const anchor = "2026-01-01T00:00:00Z";
      const result = runSeedSmall(connectionString, { anchorTime: anchor });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("VACUUM ANALYZE baseline_triaged_event");
      expect(result.stdout).toContain("VACUUM ANALYZE observed_event_meta");

      expect(await scalarCount(pool, "baseline_triaged_event")).toBe(1000);
      expect(await scalarCount(pool, "observed_event_meta")).toBe(5000);

      const state = await pool.query<{
        last_run_status: string;
        last_ingested_at_ms: string;
        corpus_activated_at_ms: string;
      }>(`
        SELECT
          last_run_status,
          (EXTRACT(EPOCH FROM last_ingested_at) * 1000)::text AS last_ingested_at_ms,
          (EXTRACT(EPOCH FROM corpus_activated_at) * 1000)::text AS corpus_activated_at_ms
        FROM baseline_corpus_state WHERE id = true
      `);
      expect(state.rows[0].last_run_status).toBe("ok");
      const anchorMs = Date.parse(anchor);
      expect(Number(state.rows[0].last_ingested_at_ms)).toBe(
        anchorMs - 60 * 60 * 1000,
      );
      expect(Number(state.rows[0].corpus_activated_at_ms)).toBe(
        anchorMs - 30 * 24 * 60 * 60 * 1000,
      );

      const orphan = await pool.query<{ count: string }>(`
        SELECT COUNT(*)::text AS count
          FROM baseline_triaged_event b
         WHERE NOT EXISTS (
           SELECT 1 FROM observed_event_meta o WHERE o.event_key = b.event_key
         )
      `);
      expect(Number(orphan.rows[0].count)).toBe(0);

      const versions = await pool.query<{ baseline_version: string }>(
        "SELECT DISTINCT baseline_version FROM baseline_triaged_event",
      );
      const versionSet = new Set(versions.rows.map((r) => r.baseline_version));
      expect(versionSet.has("phase1a-simple")).toBe(true);
      expect(versionSet.has("phase1b-four-selector")).toBe(true);

      const blocklist = await pool.query<{ count: string }>(`
        SELECT COUNT(*)::text AS count
          FROM baseline_triaged_event
         WHERE kind ILIKE 'blocklist%'
      `);
      expect(Number(blocklist.rows[0].count)).toBe(0);

      const badUnlabeled = await pool.query<{ count: string }>(`
        SELECT COUNT(*)::text AS count
          FROM baseline_triaged_event
         WHERE 'unlabeled-cluster' = ANY(selector_tags)
           AND NOT (
             baseline_version = 'phase1b-four-selector' AND kind = 'HttpThreat'
           )
      `);
      expect(Number(badUnlabeled.rows[0].count)).toBe(0);

      const badCategory = await pool.query<{ count: string }>(`
        SELECT COUNT(*)::text AS count
          FROM baseline_triaged_event
         WHERE category IS NOT NULL
           AND category NOT IN (
             'COMMAND_AND_CONTROL', 'EXFILTRATION', 'IMPACT',
             'INITIAL_ACCESS', 'CREDENTIAL_ACCESS'
           )
      `);
      expect(Number(badCategory.rows[0].count)).toBe(0);

      const nullExclusion = await pool.query<{ count: string }>(`
        SELECT COUNT(*)::text AS count
          FROM baseline_triaged_event
         WHERE exclusions_fp IS NULL
      `);
      expect(Number(nullExclusion.rows[0].count)).toBe(0);

      const span = await pool.query<{
        baseline_min_ms: string;
        baseline_max_ms: string;
        observed_min_ms: string;
        observed_max_ms: string;
      }>(`
        SELECT
          (EXTRACT(EPOCH FROM (SELECT MIN(event_time) FROM baseline_triaged_event)) * 1000)::text AS baseline_min_ms,
          (EXTRACT(EPOCH FROM (SELECT MAX(event_time) FROM baseline_triaged_event)) * 1000)::text AS baseline_max_ms,
          (EXTRACT(EPOCH FROM (SELECT MIN(event_time) FROM observed_event_meta)) * 1000)::text AS observed_min_ms,
          (EXTRACT(EPOCH FROM (SELECT MAX(event_time) FROM observed_event_meta)) * 1000)::text AS observed_max_ms
      `);
      const daysMs = 30 * 24 * 60 * 60 * 1000;
      const expectedMin = anchorMs - daysMs - 1000;
      const expectedMax = anchorMs - 1000;
      expect(Number(span.rows[0].baseline_min_ms)).toBe(expectedMin);
      expect(Number(span.rows[0].baseline_max_ms)).toBe(expectedMax);
      expect(Number(span.rows[0].observed_min_ms)).toBe(expectedMin);
      expect(Number(span.rows[0].observed_max_ms)).toBe(expectedMax);
      // `MAX − MIN = :days` exactly so the harness's `>= :days`
      // comparison passes at the lower-bound margin.
      expect(expectedMax - expectedMin).toBe(daysMs);
    }, 60_000);

    it("produces byte-identical INSERTs for identical --seed and --anchor-time", async () => {
      const anchor = "2026-01-15T00:00:00Z";
      const first = runSeedSmall(connectionString, {
        seed: 7,
        anchorTime: anchor,
      });
      expect(first.status, first.stderr).toBe(0);
      const hashA = await corpusHash(pool);

      await truncateAll(pool);

      const second = runSeedSmall(connectionString, {
        seed: 7,
        anchorTime: anchor,
      });
      expect(second.status, second.stderr).toBe(0);
      const hashB = await corpusHash(pool);

      expect(hashB).toEqual(hashA);
    }, 60_000);

    it("produces a different corpus when the anchor changes (sanity check that the anchor actually drives timestamps)", async () => {
      const first = runSeedSmall(connectionString, {
        seed: 7,
        anchorTime: "2026-01-15T00:00:00Z",
      });
      expect(first.status, first.stderr).toBe(0);
      const hashA = await corpusHash(pool);

      await truncateAll(pool);

      const second = runSeedSmall(connectionString, {
        seed: 7,
        anchorTime: "2026-02-15T00:00:00Z",
      });
      expect(second.status, second.stderr).toBe(0);
      const hashB = await corpusHash(pool);

      expect(hashB.baseline).not.toEqual(hashA.baseline);
      expect(hashB.observed).not.toEqual(hashA.observed);
    }, 60_000);

    it("aborts on a non-empty corpus without --reset and succeeds with --reset", async () => {
      const seedFlags: SeedFlags = {
        seed: 1,
        baselineRows: 1000,
        observedRows: 5000,
        days: 30,
        origAddrs: 500,
        anchorTime: "2026-01-01T00:00:00Z",
      };
      const first = runSeed(connectionString, { ...seedFlags, reset: true });
      expect(first.status, first.stderr).toBe(0);
      const hashFirst = await corpusHash(pool);

      const second = runSeed(connectionString, { ...seedFlags, reset: false });
      expect(second.status).not.toBe(0);
      expect(second.stderr).toMatch(/non-empty/i);
      // Original data must still be intact after the failed run.
      expect(await scalarCount(pool, "baseline_triaged_event")).toBe(1000);
      expect(await scalarCount(pool, "observed_event_meta")).toBe(5000);

      const third = runSeed(connectionString, { ...seedFlags, reset: true });
      expect(third.status, third.stderr).toBe(0);
      const hashAfterReset = await corpusHash(pool);

      await truncateAll(pool);
      const fresh = runSeed(connectionString, { ...seedFlags, reset: true });
      expect(fresh.status, fresh.stderr).toBe(0);
      const hashFresh = await corpusHash(pool);

      // --reset followed by re-seeding with the same seed/anchor must
      // converge on the same byte-identical state a fresh-DB seed
      // would produce.
      expect(hashAfterReset).toEqual(hashFresh);
      expect(hashAfterReset).toEqual(hashFirst);
    }, 120_000);
  },
);

describe.skipIf(!TRIAGE_PG_TEST_URL)(
  "seed-baseline-corpus-for-measurement — #524 profile assertion compatibility (slow)",
  () => {
    const connectionString = TRIAGE_PG_TEST_URL as string;
    let pool: pg.Pool;

    beforeAll(async () => {
      await migrateCustomerDb(connectionString);
      pool = new pg.Pool({ connectionString });
      await truncateAll(pool);
    }, 120_000);

    afterAll(async () => {
      if (pool !== undefined) {
        await truncateAll(pool);
        await pool.end();
      }
    });

    it("the #524 harness's representative-profile assertion passes against the default-flag seed", async () => {
      // Seed with documented defaults — intentionally omit
      // `--anchor-time` so the anchor defaults to the test's
      // execution time. The wall-clock-against-`now()` freshness
      // predicate the harness applies (`last_ingested_at < 2h ago`,
      // `MAX(event_time) within 2h of now()`) would fail on a fixed
      // past anchor, so this test specifically exercises the
      // anchor-defaults-to-now path.
      const seedResult = spawnSync(
        process.execPath,
        [
          SCRIPT_PATH,
          `--connection-string=${connectionString}`,
          "--seed=42",
          "--reset",
        ],
        { encoding: "utf8", cwd: process.cwd() },
      );
      expect(seedResult.status, seedResult.stderr).toBe(0);

      // Invoke the #524 harness WITHOUT `--skip-profile-assert`.
      // `warmups=0 samples=1` keeps the run short; the test only
      // cares that the profile gate clears, not the timings.
      const harness = spawnSync(
        process.execPath,
        [
          HARNESS_PATH,
          `--connection-string=${connectionString}`,
          "--window=30d",
          "--warmups=0",
          "--samples=1",
        ],
        { encoding: "utf8", cwd: process.cwd() },
      );
      expect(harness.status, harness.stderr).toBe(0);
    }, 600_000);
  },
);
