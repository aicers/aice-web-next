import { describe, expect, it, vi } from "vitest";

import { LOCK_NAMESPACE as CADENCE_LOCK_NAMESPACE } from "@/lib/triage/baseline/cadence";
import {
  _testing,
  acquireCustomerCadenceLock,
  drainRemainingRetroactiveDeletes,
  executeFirstRetroactiveDeleteBatch,
  executeRetroactiveDelete,
  PER_CUSTOMER_ADVISORY_LOCK_NAMESPACE,
} from "@/lib/triage/exclusion/retroactive-delete";

// Spy on enqueueNotice so withdraw-emit assertions don't need a real
// pool. `vi.hoisted` lets the factory-hoisted `vi.mock` see this
// variable (otherwise the spy would not exist at mock-execution time).
const enqueueNoticeSpy = vi.hoisted(() =>
  vi.fn<
    (
      customerId: number,
      kind: string,
      payload: unknown,
      client: unknown,
    ) => Promise<string>
  >(async () => "fake-id"),
);
vi.mock("@/lib/aimer/phase2/state", () => ({
  enqueueNotice: enqueueNoticeSpy,
}));

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

    it("emits suffix-only LIKE DELETEs for a `.*\\.` domain (bare host excluded)", () => {
      // Regression guard for issue #457 review round 1: the regex
      // `^.*\.example\.com$` requires at least one literal dot before
      // the suffix, so bare `example.com` is NOT in its match set.
      // Emitting `host = 'example.com'` would permanently remove
      // corpus rows the regex never matched.
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
      expect(stmts[0].sql).toContain("host IS NOT NULL AND host LIKE $1");
      expect(stmts[0].sql).not.toContain("host = $1");
      expect(stmts[0].params).toEqual(["%.example.com"]);
      expect(stmts[1].sql).toContain(
        "dns_query IS NOT NULL AND dns_query LIKE $1",
      );
      expect(stmts[1].sql).not.toContain("dns_query = $1");
    });

    it("emits exact + LIKE DELETEs for a `([a-z0-9-]+\\.)*` domain (bare host included)", () => {
      // The repeating-label shape's `*` quantifier allows zero label
      // prefixes, so both bare and prefixed hosts must be deleted.
      const stmts = buildStatementsForTable(
        "baseline_triaged_event",
        {
          kind: "domain",
          value: "^([a-z0-9-]+\\.)*example\\.com$",
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

    it("emits exact-only DELETEs for a literal-host domain", () => {
      const stmts = buildStatementsForTable(
        "baseline_triaged_event",
        {
          kind: "domain",
          value: "^foo\\.example\\.com$",
          domainSuffix: "foo.example.com",
        },
        100,
      );
      expect(stmts).toHaveLength(2);
      expect(stmts[0].sql).toContain("host = $1");
      expect(stmts[0].params).toEqual(["foo.example.com"]);
      expect(stmts[1].sql).toContain("dns_query = $1");
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

    it("emits no DELETEs for a single-label `[^.]+\\.` domain — not retroactively reducible", () => {
      // Regression guard for issue #457 review round 1: `[^.]+\.`
      // matches exactly one label before the suffix. The planner has
      // no efficient SQL predicate for "exactly one label", so we
      // skip retroactive DELETE entirely. Forward matching still
      // applies via the active-set regex.
      const stmts = buildStatementsForTable(
        "baseline_triaged_event",
        {
          kind: "domain",
          value: "^[^.]+\\.example\\.com$",
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

    describe("two-phase first-batch-then-drain (#457 round 1 review)", () => {
      it("first batch returns `pending` when a predicate filled its batch", async () => {
        // The route handler's transaction is supposed to run only ONE
        // DELETE batch per predicate; if a batch fills (rowCount ===
        // batchSize), the remainder must drain in fresh transactions.
        const client = makeClient((call) => {
          if (call.sql.includes("to_regclass")) {
            return { rows: [{ exists: false }], rowCount: 1 };
          }
          // hostname yields one statement against
          // baseline_triaged_event then one against
          // observed_event_meta. The first fills (50/50), the second
          // is partial (3/50).
          if (call.sql.includes("baseline_triaged_event"))
            return { rows: [], rowCount: 50 };
          if (call.sql.includes("observed_event_meta"))
            return { rows: [], rowCount: 3 };
          return { rows: [], rowCount: 0 };
        });

        const { counts, pending } = await executeFirstRetroactiveDeleteBatch(
          client as unknown as Parameters<
            typeof executeFirstRetroactiveDeleteBatch
          >[0],
          { kind: "hostname", value: "example.com", domainSuffix: null },
          { batchSize: 50 },
        );

        expect(counts.baselineTriagedEvent).toBe(50);
        expect(counts.observedEventMeta).toBe(3);
        // Only the full predicate is pending.
        expect(pending).toHaveLength(1);
        expect(pending[0].tableKey).toBe("baselineTriagedEvent");
        // baseline_triaged_event was queried exactly once during the
        // first batch — it does NOT loop until exhausted.
        const baselineQueries = client.queries.filter((q) =>
          q.sql.includes("DELETE FROM baseline_triaged_event"),
        );
        expect(baselineQueries).toHaveLength(1);
      });

      it("drain phase invokes the TxRunner once per batch and stops at partial", async () => {
        // After the first batch commits, the drain loops in fresh
        // transactions (one per batch) until a batch returns fewer
        // rows than `batchSize`. This bounds lock duration and WAL
        // pressure per #457.
        const responses = [10, 10, 4]; // 2 full batches, then partial.
        let txCount = 0;
        const drained = await drainRemainingRetroactiveDeletes(
          async (fn) => {
            txCount += 1;
            const fakeClient = {
              query: vi.fn(async () => ({
                rows: [],
                rowCount: responses.shift() ?? 0,
              })),
            };
            return fn(fakeClient as unknown as Parameters<typeof fn>[0]);
          },
          [
            {
              tableKey: "baselineTriagedEvent",
              statements: [{ sql: "DELETE x", params: [] }],
            },
          ],
          { batchSize: 10 },
        );

        // 3 batches → 3 fresh transactions.
        expect(txCount).toBe(3);
        expect(drained.baselineTriagedEvent).toBe(24);
      });

      it("first batch with all predicates exhausted returns empty `pending`", async () => {
        // No predicate filled, so the drain phase is skipped entirely.
        const client = makeClient((call) => {
          if (call.sql.includes("to_regclass")) {
            return { rows: [{ exists: false }], rowCount: 1 };
          }
          return { rows: [], rowCount: 1 };
        });

        const { pending } = await executeFirstRetroactiveDeleteBatch(
          client as unknown as Parameters<
            typeof executeFirstRetroactiveDeleteBatch
          >[0],
          { kind: "hostname", value: "example.com", domainSuffix: null },
          { batchSize: 50 },
        );

        expect(pending).toEqual([]);
      });
    });

    describe("#573 Trigger 1: withdraw notice emission", () => {
      it("emits RETURNING clauses on baseline_triaged_event and policy_triaged_event but not observed_event_meta", () => {
        const baseline = buildStatementsForTable(
          "baseline_triaged_event",
          { kind: "hostname", value: "example.com", domainSuffix: null },
          50,
        );
        expect(baseline[0].sql).toContain(
          "RETURNING baseline_version, event_key::text AS event_key",
        );
        expect(baseline[0].withdrawKind).toBe("withdraw_baseline_event");

        const observed = buildStatementsForTable(
          "observed_event_meta",
          { kind: "hostname", value: "example.com", domainSuffix: null },
          50,
        );
        expect(observed[0].sql).not.toContain("RETURNING");
        expect(observed[0].withdrawKind).toBeNull();

        const policy = buildStatementsForTable(
          "policy_triaged_event",
          { kind: "hostname", value: "example.com", domainSuffix: null },
          50,
        );
        expect(policy[0].sql).toContain(
          "RETURNING run_id::text AS run_id, event_key::text AS event_key",
        );
        expect(policy[0].withdrawKind).toBe("withdraw_policy_event");
      });

      it("coalesces baseline returned rows into one notice per baseline_version per drain txn", async () => {
        enqueueNoticeSpy.mockClear();
        const client = makeClient((call) => {
          if (call.sql.includes("to_regclass")) {
            return { rows: [{ exists: false }], rowCount: 1 };
          }
          if (call.sql.includes("DELETE FROM baseline_triaged_event")) {
            // Three rows across two baseline_versions: coalescing
            // should produce two distinct queue notices.
            return {
              rows: [
                { baseline_version: "v1", event_key: "100" },
                { baseline_version: "v1", event_key: "101" },
                { baseline_version: "v2", event_key: "200" },
              ],
              rowCount: 3,
            };
          }
          return { rows: [], rowCount: 0 };
        });

        await executeFirstRetroactiveDeleteBatch(
          client as unknown as Parameters<
            typeof executeFirstRetroactiveDeleteBatch
          >[0],
          { kind: "hostname", value: "example.com", domainSuffix: null },
          { batchSize: 50, customerId: 7 },
        );

        // Two enqueue calls — one per baseline_version, never per row.
        expect(enqueueNoticeSpy).toHaveBeenCalledTimes(2);
        const versions = enqueueNoticeSpy.mock.calls
          .map(
            (call) =>
              (call[2] as { baseline_version: string }).baseline_version,
          )
          .sort();
        expect(versions).toEqual(["v1", "v2"]);
        const v1Payload = enqueueNoticeSpy.mock.calls.find(
          (call) =>
            (call[2] as { baseline_version: string }).baseline_version === "v1",
        )?.[2] as { kind: string; event_keys: string[] };
        expect(v1Payload.event_keys.sort()).toEqual(["100", "101"]);
        // Payload carries the wire-ready `kind` discriminator so the
        // drain can copy it verbatim into `phase2.withdraw.v1`
        // withdrawals[]. All enqueues share the same client.
        for (const call of enqueueNoticeSpy.mock.calls) {
          expect(call[1]).toBe("withdraw_baseline_event");
          expect((call[2] as { kind: string }).kind).toBe("baseline_event");
          expect(call[3]).toBe(client);
        }
      });

      it("emits policy-event withdraw payloads with the wire-ready kind discriminator", async () => {
        enqueueNoticeSpy.mockClear();
        const client = makeClient((call) => {
          if (call.sql.includes("to_regclass")) {
            return { rows: [{ exists: true }], rowCount: 1 };
          }
          if (call.sql.includes("DELETE FROM policy_triaged_event")) {
            return {
              rows: [
                { run_id: "run-1", event_key: "1000" },
                { run_id: "run-1", event_key: "1001" },
                { run_id: "run-2", event_key: "2000" },
              ],
              rowCount: 3,
            };
          }
          return { rows: [], rowCount: 0 };
        });

        await executeFirstRetroactiveDeleteBatch(
          client as unknown as Parameters<
            typeof executeFirstRetroactiveDeleteBatch
          >[0],
          { kind: "hostname", value: "example.com", domainSuffix: null },
          { batchSize: 50, customerId: 11 },
        );

        // Two queue rows, one per run_id, each carrying
        // `kind: "policy_event"` so the wire-ready policy-event drain
        // (#572) can map the queue payload directly into `withdrawals[]`
        // without re-deriving the discriminator from `aimer_push_queue.kind`.
        const policyCalls = enqueueNoticeSpy.mock.calls.filter(
          (call) => call[1] === "withdraw_policy_event",
        );
        expect(policyCalls).toHaveLength(2);
        for (const call of policyCalls) {
          expect((call[2] as { kind: string }).kind).toBe("policy_event");
        }
      });

      it("does NOT enqueue from observed_event_meta deletes", async () => {
        enqueueNoticeSpy.mockClear();
        const client = makeClient((call) => {
          if (call.sql.includes("to_regclass")) {
            return { rows: [{ exists: false }], rowCount: 1 };
          }
          // Even if a row were returned (it shouldn't, no RETURNING),
          // the observed branch must not enqueue. Return rowCount only.
          return { rows: [], rowCount: 5 };
        });

        await executeFirstRetroactiveDeleteBatch(
          client as unknown as Parameters<
            typeof executeFirstRetroactiveDeleteBatch
          >[0],
          { kind: "hostname", value: "example.com", domainSuffix: null },
          { batchSize: 50, customerId: 7 },
        );

        // No baseline/policy rows produced → no enqueue should fire.
        expect(enqueueNoticeSpy).not.toHaveBeenCalled();
      });

      it("skips enqueue entirely when customerId is omitted (delete-only callers)", async () => {
        enqueueNoticeSpy.mockClear();
        const client = makeClient((call) => {
          if (call.sql.includes("to_regclass")) {
            return { rows: [{ exists: false }], rowCount: 1 };
          }
          if (call.sql.includes("DELETE FROM baseline_triaged_event")) {
            return {
              rows: [{ baseline_version: "v1", event_key: "100" }],
              rowCount: 1,
            };
          }
          return { rows: [], rowCount: 0 };
        });

        await executeFirstRetroactiveDeleteBatch(
          client as unknown as Parameters<
            typeof executeFirstRetroactiveDeleteBatch
          >[0],
          { kind: "hostname", value: "example.com", domainSuffix: null },
          { batchSize: 50 },
        );

        expect(enqueueNoticeSpy).not.toHaveBeenCalled();
      });

      it("drain transactions each emit their own withdraw notice (per-batch atomicity)", async () => {
        enqueueNoticeSpy.mockClear();
        const batchRows = [
          [
            { baseline_version: "v1", event_key: "1" },
            { baseline_version: "v1", event_key: "2" },
          ],
          [{ baseline_version: "v1", event_key: "3" }],
        ];

        await drainRemainingRetroactiveDeletes(
          async (fn) => {
            const rows = batchRows.shift() ?? [];
            const fakeClient = {
              query: vi.fn(async () => ({
                rows,
                rowCount: rows.length,
              })),
            };
            return fn(fakeClient as unknown as Parameters<typeof fn>[0]);
          },
          [
            {
              tableKey: "baselineTriagedEvent",
              statements: [
                {
                  sql: "DELETE x",
                  params: [],
                  withdrawKind: "withdraw_baseline_event",
                },
              ],
            },
          ],
          { batchSize: 2, customerId: 9 },
        );

        // First batch rowCount = 2 == batchSize → loop continues; second
        // batch rowCount = 1 < batchSize → exits. So 2 batches, each
        // emitting its own withdraw notice (one per drain txn).
        expect(enqueueNoticeSpy).toHaveBeenCalledTimes(2);
        for (const call of enqueueNoticeSpy.mock.calls) {
          expect(call[1]).toBe("withdraw_baseline_event");
        }
      });
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
