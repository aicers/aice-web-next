import { describe, expect, it, vi } from "vitest";

import { LOCK_NAMESPACE as CADENCE_LOCK_NAMESPACE } from "@/lib/triage/baseline/cadence";
import {
  _testing,
  acquireCustomerCadenceLock,
  executeRetroactiveDelete,
  PER_CUSTOMER_ADVISORY_LOCK_NAMESPACE,
} from "@/lib/triage/exclusion/retroactive-delete";

const { buildStatementsForTable } = _testing;

interface QueryCall {
  sql: string;
  params: unknown[] | undefined;
}

interface QueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
}

interface MockClient {
  queries: QueryCall[];
  query: ReturnType<typeof vi.fn>;
}

/**
 * Build a fake `pg.PoolClient` that records every issued query and
 * dispatches a response from a per-test programmable handler.
 */
function makeClient(
  responder: (call: QueryCall) => QueryResult | Promise<QueryResult>,
): MockClient {
  const queries: QueryCall[] = [];
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    const call = { sql, params };
    queries.push(call);
    return responder(call);
  });
  return { queries, query } as unknown as MockClient;
}

describe("retroactive-delete planner", () => {
  describe("buildStatementsForTable", () => {
    it("emits orig_addr + resp_addr DELETEs for ipAddress", () => {
      const stmts = buildStatementsForTable(
        "baseline_triaged_event",
        { kind: "ipAddress", value: "192.168.1.0/24", domainSuffix: null },
        100,
      );
      expect(stmts).toHaveLength(2);
      expect(stmts[0].sql).toContain("orig_addr <<= $1::inet");
      expect(stmts[1].sql).toContain("resp_addr <<= $1::inet");
      expect(stmts[0].params).toEqual(["192.168.1.0/24"]);
    });

    it("emits a host = $1 DELETE for hostname", () => {
      const stmts = buildStatementsForTable(
        "baseline_triaged_event",
        { kind: "hostname", value: "example.com", domainSuffix: null },
        100,
      );
      expect(stmts).toHaveLength(1);
      expect(stmts[0].sql).toContain("host = $1");
      expect(stmts[0].params).toEqual(["example.com"]);
    });

    it("emits a uri = $1 DELETE for uri", () => {
      const stmts = buildStatementsForTable(
        "baseline_triaged_event",
        { kind: "uri", value: "/foo", domainSuffix: null },
        100,
      );
      expect(stmts).toHaveLength(1);
      expect(stmts[0].sql).toContain("uri = $1");
    });

    it("emits exact + LIKE DELETEs for a suffix-reducible domain", () => {
      const stmts = buildStatementsForTable(
        "baseline_triaged_event",
        {
          kind: "domain",
          value: "^.*\\.example\\.com$",
          domainSuffix: ".example.com",
        },
        100,
      );
      expect(stmts).toHaveLength(2);
      expect(stmts[0].sql).toContain(
        "host IS NOT NULL AND (host = $1 OR host LIKE $2)",
      );
      expect(stmts[0].params).toEqual(["example.com", "%.example.com"]);
      expect(stmts[1].sql).toContain(
        "dns_query IS NOT NULL AND (dns_query = $1 OR dns_query LIKE $2)",
      );
    });

    it("emits no DELETEs for an unreducible domain", () => {
      const stmts = buildStatementsForTable(
        "baseline_triaged_event",
        {
          kind: "domain",
          value: "^(a|b)\\.com$",
          domainSuffix: null,
        },
        100,
      );
      expect(stmts).toHaveLength(0);
    });

    it("rejects a non-positive batchSize", () => {
      expect(() =>
        buildStatementsForTable(
          "baseline_triaged_event",
          { kind: "hostname", value: "x", domainSuffix: null },
          0,
        ),
      ).toThrow();
    });
  });

  describe("acquireCustomerCadenceLock", () => {
    it("locks on hashtext('triage_baseline_cadence:' || customer_id)", async () => {
      const client = makeClient(() => ({ rows: [], rowCount: 0 }));
      await acquireCustomerCadenceLock(
        client as unknown as Parameters<typeof acquireCustomerCadenceLock>[0],
        42,
      );
      expect(client.queries).toHaveLength(1);
      expect(client.queries[0].sql).toContain("pg_advisory_xact_lock");
      expect(client.queries[0].sql).toContain("hashtext($1)");
      // Key MUST match the cadence runner so cadence skips when ADD
      // holds the lock.
      expect(client.queries[0].params).toEqual([
        `${PER_CUSTOMER_ADVISORY_LOCK_NAMESPACE}42`,
      ]);
    });

    it("uses the byte-identical namespace string as the cadence runner", () => {
      // Spec acceptance criterion (#457): "ADD blocks on cadence's
      // advisory lock […]. A test simulates contention against the
      // merged cadence runner." Two strings sent to `hashtext()` only
      // collide if they are byte-equal — assert the cadence runner's
      // export and the exclusion-side constant are the same value, so
      // a future rename on either side breaks this test rather than
      // silently splitting the two writers into different lock ids.
      expect(PER_CUSTOMER_ADVISORY_LOCK_NAMESPACE).toBe(CADENCE_LOCK_NAMESPACE);
    });

    it("issues the lock query with the cadence-identical key for any customer id", async () => {
      // End-to-end check: simulate ADD acquiring the lock for
      // customer 7 and confirm the parameter that would be passed to
      // Postgres' `hashtext()` is exactly what the cadence runner
      // would compute for the same customer.
      const client = makeClient(() => ({ rows: [], rowCount: 0 }));
      await acquireCustomerCadenceLock(
        client as unknown as Parameters<typeof acquireCustomerCadenceLock>[0],
        7,
      );
      expect(client.queries[0].params).toEqual([`${CADENCE_LOCK_NAMESPACE}7`]);
    });
  });

  describe("executeRetroactiveDelete", () => {
    /**
     * Programmable responder: returns the row count for each
     * `DELETE FROM <table>` matched by predicate. Other queries (the
     * `to_regclass` probe) are answered separately.
     */
    function makePolicyTableClient(opts: {
      policyTableExists: boolean;
      perTableRowCount: Record<string, number>;
    }) {
      return makeClient((call) => {
        if (call.sql.includes("to_regclass")) {
          return {
            rows: [{ exists: opts.policyTableExists }],
            rowCount: 1,
          };
        }
        // DELETE statements: extract the table name and return the
        // configured row count once, then 0 to break the batch loop.
        const match = call.sql.match(/DELETE FROM (\w+)/);
        const table = match?.[1] ?? "unknown";
        const remaining = opts.perTableRowCount[table] ?? 0;
        opts.perTableRowCount[table] = 0;
        return { rows: [], rowCount: remaining };
      });
    }

    it("skips policy_triaged_event when to_regclass returns null", async () => {
      const client = makePolicyTableClient({
        policyTableExists: false,
        perTableRowCount: {
          baseline_triaged_event: 3,
          observed_event_meta: 7,
        },
      });

      const counts = await executeRetroactiveDelete(
        client as unknown as Parameters<typeof executeRetroactiveDelete>[0],
        { kind: "hostname", value: "example.com", domainSuffix: null },
        { batchSize: 100 },
      );

      expect(counts.policyTriagedEvent).toBeNull();
      expect(counts.baselineTriagedEvent).toBe(3);
      expect(counts.observedEventMeta).toBe(7);

      const tablesQueried = client.queries
        .map((q) => q.sql.match(/DELETE FROM (\w+)/)?.[1])
        .filter(Boolean);
      expect(tablesQueried).not.toContain("policy_triaged_event");
    });

    it("engages the policy_triaged_event branch when the table exists", async () => {
      const client = makePolicyTableClient({
        policyTableExists: true,
        perTableRowCount: {
          baseline_triaged_event: 1,
          observed_event_meta: 2,
          policy_triaged_event: 5,
        },
      });

      const counts = await executeRetroactiveDelete(
        client as unknown as Parameters<typeof executeRetroactiveDelete>[0],
        { kind: "hostname", value: "example.com", domainSuffix: null },
        { batchSize: 100 },
      );

      expect(counts.policyTriagedEvent).toBe(5);

      const tablesQueried = client.queries
        .map((q) => q.sql.match(/DELETE FROM (\w+)/)?.[1])
        .filter(Boolean);
      expect(tablesQueried).toContain("policy_triaged_event");
    });

    it("drains the batch loop until rowCount < batchSize", async () => {
      // Three batches of 100, then one batch of 30 (loop exit).
      const remainingByTable: Record<string, number[]> = {
        baseline_triaged_event: [100, 100, 100, 30],
        observed_event_meta: [0],
      };

      const client = makeClient((call) => {
        if (call.sql.includes("to_regclass")) {
          return { rows: [{ exists: false }], rowCount: 1 };
        }
        const match = call.sql.match(/DELETE FROM (\w+)/);
        const table = match?.[1] ?? "unknown";
        const next = remainingByTable[table]?.shift() ?? 0;
        return { rows: [], rowCount: next };
      });

      const counts = await executeRetroactiveDelete(
        client as unknown as Parameters<typeof executeRetroactiveDelete>[0],
        { kind: "hostname", value: "example.com", domainSuffix: null },
        { batchSize: 100 },
      );

      expect(counts.baselineTriagedEvent).toBe(100 + 100 + 100 + 30);
      // 4 batched DELETEs against baseline_triaged_event + 1 single
      // empty drain against observed_event_meta + the to_regclass probe.
      const baselineDeletes = client.queries.filter((q) =>
        q.sql.includes("DELETE FROM baseline_triaged_event"),
      );
      expect(baselineDeletes).toHaveLength(4);
    });

    it("ipAddress exclusions still target NTLM rows via orig_addr / resp_addr", async () => {
      // NTLM carve-out: hostname/uri/domain branches naturally skip
      // NULL rows; ipAddress unconditionally targets `orig_addr` /
      // `resp_addr`, which are populated for NTLM. The check here is
      // that the emitted SQL has no host-NULL filter on the ipAddress
      // path that would inadvertently exclude NTLM rows.
      const stmts = buildStatementsForTable(
        "baseline_triaged_event",
        { kind: "ipAddress", value: "10.0.0.0/8", domainSuffix: null },
        50,
      );
      for (const stmt of stmts) {
        expect(stmt.sql).not.toContain("host IS NOT NULL");
        expect(stmt.sql).not.toContain("host IS NULL");
      }
    });
  });
});
