/**
 * SQL-level compatibility test for the §5 `orig_addr` cast cleanup
 * (issue #524). The PR rewrites `perAssetObservedCounts` and
 * `selectAssetDetailEventsBatch` to bind `orig_addr` as `inet[]`
 * instead of casting the column to `text` and binding `text[]`.
 *
 * The change relies on `pg`'s driver-level array binding: the
 * JS-side parameter is still `string[]`, but the placeholder is
 * `$N::inet[]` so the planner can use the existing GiST inet index
 * on `orig_addr` (or a future btree) instead of being foreclosed by
 * the cast. The regex / mocked-query tests elsewhere prove the SQL
 * text is correct; this file goes one level deeper and proves that
 * `pg` actually serializes a `string[]` to a `text[]` literal that
 * Postgres can cast to `inet[]` and that the filter returns the same
 * rows the old cast form returned.
 *
 * Gated on `TRIAGE_PG_TEST_URL` — when the env var is absent (typical
 * CI / local-dev case) the suite is skipped, so this file does not
 * require a running Postgres for `pnpm vitest run` to pass. To
 * exercise the binding locally:
 *
 *   TRIAGE_PG_TEST_URL="postgres://postgres:postgres@localhost:5432/postgres" \
 *     pnpm vitest run \
 *     src/__tests__/lib/triage/baseline/read-path-sql-inet-binding.test.ts
 *
 * The test creates a temporary table inside a savepoint-style
 * transaction that always rolls back, so it never mutates the target
 * DB — any Postgres the developer has handy is enough; no
 * representative-profile data required.
 */

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TRIAGE_PG_TEST_URL = process.env.TRIAGE_PG_TEST_URL;

describe.skipIf(!TRIAGE_PG_TEST_URL)(
  "orig_addr inet[] binding — SQL-level compatibility",
  () => {
    let pool: pg.Pool;
    let client: pg.PoolClient;

    beforeAll(async () => {
      pool = new pg.Pool({ connectionString: TRIAGE_PG_TEST_URL });
      client = await pool.connect();
      await client.query("BEGIN");
      await client.query(`
        CREATE TEMP TABLE inet_binding_test (
          id        serial PRIMARY KEY,
          orig_addr inet NOT NULL
        ) ON COMMIT DROP
      `);
      // Mix of v4 / v6 addresses including duplicates so we can
      // verify that the binding selects exactly the matching rows
      // regardless of v4-vs-v6 form and ordering. The post-cleanup
      // code path passes JS `string[]` for the `inet[]` placeholder;
      // pg drives the parameter as `text[]` on the wire and Postgres
      // casts each element to `inet` on the server side.
      await client.query(`
        INSERT INTO inet_binding_test (orig_addr) VALUES
          ('10.0.0.1'::inet),
          ('10.0.0.2'::inet),
          ('10.0.0.3'::inet),
          ('192.168.1.1'::inet),
          ('2001:db8::1'::inet)
      `);
    });

    afterAll(async () => {
      if (client !== undefined) {
        try {
          await client.query("ROLLBACK");
        } finally {
          client.release();
        }
      }
      if (pool !== undefined) {
        await pool.end();
      }
    });

    it("inet[] binding selects the same rows the legacy text-cast form selected", async () => {
      const addresses = ["10.0.0.1", "10.0.0.3", "2001:db8::1"];
      const inetResult = await client.query<{ id: number; addr: string }>(
        `SELECT id, orig_addr::text AS addr
           FROM inet_binding_test
          WHERE orig_addr = ANY($1::inet[])
          ORDER BY id`,
        [addresses],
      );
      const textResult = await client.query<{ id: number; addr: string }>(
        `SELECT id, orig_addr::text AS addr
           FROM inet_binding_test
          WHERE orig_addr::text = ANY($1::text[])
          ORDER BY id`,
        [addresses],
      );
      expect(inetResult.rows.map((r) => r.id)).toEqual(
        textResult.rows.map((r) => r.id),
      );
      expect(inetResult.rows.map((r) => r.addr)).toEqual([
        "10.0.0.1",
        "10.0.0.3",
        "2001:db8::1",
      ]);
    });

    it("inet[] binding handles an empty address list without error", async () => {
      const { rows } = await client.query<{ id: number }>(
        `SELECT id
           FROM inet_binding_test
          WHERE orig_addr = ANY($1::inet[])`,
        [[]],
      );
      expect(rows).toEqual([]);
    });

    it("inet[] binding rejects malformed addresses with a Postgres error", async () => {
      // Defensive: if a future caller ever leaks a non-IP string
      // into the parameter, the planner refuses the cast at runtime
      // rather than silently returning zero rows. The error is
      // surfaced as a `pg` rejection so the request fails fast.
      await expect(
        client.query(
          `SELECT id FROM inet_binding_test WHERE orig_addr = ANY($1::inet[])`,
          [["not-an-ip"]],
        ),
      ).rejects.toThrow(/invalid input syntax for type inet/);
    });
  },
);
