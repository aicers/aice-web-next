/**
 * Vitest entrypoint for the step-(f) wall-clock runner (issue #602).
 *
 * Operator invocation (Option 1 in the issue body):
 *
 *   RUNNER_TENANT=<customer-id> \
 *   RUNNER_OUTPUT_JSON=/abs/path/out.json \
 *   pnpm vitest run src/__tests__/scripts/measure-step-f.runner.test.ts
 *
 * Stdout carries human-readable progress only (the Vitest reporter
 * shares the channel, so structured JSON cannot go there). The full
 * `StepFRunnerOutput` document is written to `RUNNER_OUTPUT_JSON`.
 *
 * Optional knobs:
 *
 *   RUNNER_SAMPLES         — per-page sample count for each toggle pass
 *                            (default 30).
 *   RUNNER_MAX_PAGES       — hard cap on pages walked (default 200).
 *   RUNNER_PAGE_SIZE       — `first` for the cadence pager fetch
 *                            (default REVIEW_MAX_PAGE_SIZE = 100).
 *
 * Required Postgres grants on the connection's role:
 *
 *   - INSERT on observed_event_meta, baseline_triaged_event,
 *     event_group, event_group_member.
 *   - UPDATE on baseline_corpus_state (story_finalized_through,
 *     last_event_cursor, run-status columns).
 *   - The connection must open its own transactions — no PgBouncer
 *     transaction-pool interposing on the rollback boundary, otherwise
 *     the per-sample SAVEPOINT semantics break.
 *
 * Concurrency: the runner holds the per-customer advisory lock for
 * the full duration of the run (potentially several minutes for a
 * full tick × samples × two toggle passes). Cadence ticks and
 * exclusion-ADD on the same tenant are blocked for that duration.
 */

import type pg from "pg";
import { describe, expect, it, vi } from "vitest";

import { REVIEW_MAX_PAGE_SIZE } from "@/lib/review/limits";
import { LOCK_NAMESPACE } from "@/lib/triage/baseline/cadence";
import type { CadenceConnectionResponse } from "@/lib/triage/baseline/pager";
import { EMPTY_EXCLUSION_SET_RESOLVER } from "@/lib/triage/exclusion";

import {
  buildLockKeyParam,
  type FetchEventPageFn,
  LockNotAcquiredError,
  type LockProbeClient,
  pairedDeltas,
  percentile,
  runStepFMeasurement,
  summarizeFullTick,
  summarizePageSamples,
  tryAcquireAdvisoryLock,
} from "./measure-step-f-runner";

type ScriptedClientOpts = {
  lockAcquired: boolean;
  /**
   * Value the scripted `baseline_corpus_state` singleton returns for
   * `last_event_cursor`. The runner uses this as the initial
   * `afterCursor`, so the corresponding fetch assertion can probe
   * whether the cursor flowed from the singleton.
   */
  lastEventCursor?: string | null;
};

describe("measure-step-f — buildLockKeyParam", () => {
  it("reproduces the cadence pager's LOCK_NAMESPACE + customerId key so hashtext() collapses to the same lock id", () => {
    expect(buildLockKeyParam(42)).toBe(`${LOCK_NAMESPACE}42`);
  });
});

describe("measure-step-f — percentile", () => {
  it("returns the value itself for a single-element cohort", () => {
    expect(percentile([7], 0.5)).toBe(7);
    expect(percentile([7], 0.95)).toBe(7);
  });

  it("returns NaN on an empty cohort so the consumer can decide how to render it", () => {
    expect(Number.isNaN(percentile([], 0.5))).toBe(true);
  });

  it("matches numpy's linear convention on a sorted cohort", () => {
    // Equivalent to numpy.percentile([1..10], 50/95). Linear-interpolation
    // p50 on `1..10` is `5.5`; p95 is `9.55`.
    const cohort = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(cohort, 0.5)).toBeCloseTo(5.5, 6);
    expect(percentile(cohort, 0.95)).toBeCloseTo(9.55, 6);
  });

  it("does not mutate the caller's array", () => {
    const cohort = [9, 1, 5, 3, 7];
    percentile(cohort, 0.5);
    expect(cohort).toEqual([9, 1, 5, 3, 7]);
  });
});

describe("measure-step-f — pairedDeltas", () => {
  it("computes treated_j − baseline_j element-wise", () => {
    expect(pairedDeltas([10, 12, 14], [11, 13, 17])).toEqual([1, 1, 3]);
  });

  it("rejects length mismatches so the gate cannot silently fall back to independent percentiles", () => {
    expect(() => pairedDeltas([1, 2, 3], [1, 2])).toThrow(/length mismatch/);
  });
});

describe("measure-step-f — summarizePageSamples / summarizeFullTick", () => {
  it("emits baseline + treated + paired-delta p50/p95 per page", () => {
    const stats = summarizePageSamples(
      0,
      100,
      [10, 11, 12, 13, 14],
      [12, 14, 15, 16, 18],
    );
    expect(stats.pageIndex).toBe(0);
    expect(stats.rowCount).toBe(100);
    expect(stats.baseline.p50).toBeCloseTo(12, 6);
    expect(stats.treated.p50).toBeCloseTo(15, 6);
    // Paired deltas: [2, 3, 3, 3, 4] — p50 is 3.
    expect(stats.delta.p50).toBeCloseTo(3, 6);
  });

  it("aggregates the full-tick percentiles over per-page p50s (single hot page must not be smoothed)", () => {
    const perPage = [
      summarizePageSamples(0, 50, [10, 10, 10], [12, 12, 12]),
      summarizePageSamples(1, 50, [11, 11, 11], [13, 13, 13]),
      // Hot page — the full-tick p95 should pull toward it.
      summarizePageSamples(2, 50, [40, 40, 40], [80, 80, 80]),
    ];
    const fullTick = summarizeFullTick(perPage);
    expect(fullTick).not.toBeNull();
    if (!fullTick) return;
    expect(fullTick.baseline.p50).toBeCloseTo(11, 6);
    expect(fullTick.baseline.p95).toBeGreaterThan(11);
    expect(fullTick.delta.p95).toBeGreaterThan(fullTick.delta.p50);
  });

  it("returns null when no pages were measured", () => {
    expect(summarizeFullTick([])).toBeNull();
  });
});

describe("measure-step-f — tryAcquireAdvisoryLock", () => {
  it("issues `pg_try_advisory_xact_lock(hashtext($1))` with the same key the cadence pager uses", async () => {
    const captured: Array<{ sql: string; params: unknown[] }> = [];
    const client: LockProbeClient = {
      async query(sql, params) {
        captured.push({ sql, params });
        return { rows: [{ acquired: true }] };
      },
    };
    const acquired = await tryAcquireAdvisoryLock(client, 999);
    expect(acquired).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0].sql).toMatch(/pg_try_advisory_xact_lock/);
    expect(captured[0].sql).toMatch(/hashtext\(\$1\)/);
    expect(captured[0].params).toEqual([`${LOCK_NAMESPACE}999`]);
  });

  it("returns false when Postgres reports the lock as already held", async () => {
    const client: LockProbeClient = {
      async query() {
        return { rows: [{ acquired: false }] };
      },
    };
    expect(await tryAcquireAdvisoryLock(client, 1)).toBe(false);
  });
});

/**
 * Scripted fake `pg.PoolClient`. Recognises `BEGIN` / `ROLLBACK` /
 * `SAVEPOINT` / `RELEASE SAVEPOINT` / `ROLLBACK TO SAVEPOINT` and the
 * pager's INSERTs as no-ops, returns a scripted `acquired` flag for
 * the advisory-lock probe, and returns an empty `selector_map` SELECT
 * so the score path never touches per-row math.
 */
type ScriptedResult = { rows: Record<string, unknown>[]; rowCount: number };

function makeScriptedClient(opts: ScriptedClientOpts): {
  client: {
    queries: string[];
    query: (sql: string, params?: unknown[]) => Promise<ScriptedResult>;
    release: () => void;
  };
} {
  const queries: string[] = [];
  const lastEventCursor = opts.lastEventCursor ?? null;
  const client = {
    queries,
    query: vi.fn(async (sql: string, _params?: unknown[]) => {
      queries.push(sql);
      if (sql.includes("pg_try_advisory_xact_lock")) {
        return {
          rows: [{ acquired: opts.lockAcquired }],
          rowCount: 1,
        };
      }
      // The runner mirrors cadence's `readOrInitCorpusState` after
      // acquiring the lock — the SELECT must return the singleton or
      // the runner throws "singleton row is missing after INSERT".
      if (
        sql.includes("FROM baseline_corpus_state") &&
        sql.includes("last_event_cursor")
      ) {
        return {
          rows: [{ last_event_cursor: lastEventCursor }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 } as ScriptedResult;
    }),
    release: vi.fn(),
  };
  return { client };
}

describe("measure-step-f — runStepFMeasurement: advisory-lock guard", () => {
  it("rolls back the outer transaction and throws `LockNotAcquiredError` when a competing holder already owns the lock", async () => {
    const { client } = makeScriptedClient({ lockAcquired: false });
    const fetchPage = vi.fn();

    await expect(
      runStepFMeasurement({
        client: client as unknown as pg.PoolClient,
        customerId: 17,
        resolver: EMPTY_EXCLUSION_SET_RESOLVER,
        fetchPage,
        pageSize: REVIEW_MAX_PAGE_SIZE,
        samples: 3,
      }),
    ).rejects.toBeInstanceOf(LockNotAcquiredError);

    // The runner opened the outer transaction, observed the failed
    // lock, and rolled back without touching the fetch path or
    // running any page-level SAVEPOINT.
    expect(client.queries[0]).toBe("BEGIN");
    expect(client.queries).toContain("ROLLBACK");
    expect(fetchPage).not.toHaveBeenCalled();
    expect(client.queries.some((sql) => sql.startsWith("SAVEPOINT"))).toBe(
      false,
    );
  });

  it("propagates the customer id on the thrown error so the operator can correlate against tenant logs", async () => {
    const { client } = makeScriptedClient({ lockAcquired: false });
    const err = await runStepFMeasurement({
      client: client as unknown as pg.PoolClient,
      customerId: 4242,
      resolver: EMPTY_EXCLUSION_SET_RESOLVER,
      fetchPage: vi.fn(),
      pageSize: REVIEW_MAX_PAGE_SIZE,
      samples: 1,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(LockNotAcquiredError);
    expect((err as LockNotAcquiredError).customerId).toBe(4242);
  });
});

describe("measure-step-f — runStepFMeasurement: empty first page short-circuit", () => {
  it("stops cleanly when the resolver returns no edges and `hasNextPage = false` (zero pages measured, outer transaction rolled back)", async () => {
    const { client } = makeScriptedClient({ lockAcquired: true });
    const emptyResponse: CadenceConnectionResponse = {
      eventListWithTriage: {
        pageInfo: {
          hasPreviousPage: false,
          hasNextPage: false,
          startCursor: null,
          endCursor: null,
        },
        edges: [],
      },
    };
    const fetchPage = vi.fn(async () => emptyResponse);

    const out = await runStepFMeasurement({
      client: client as unknown as pg.PoolClient,
      customerId: 1,
      resolver: EMPTY_EXCLUSION_SET_RESOLVER,
      fetchPage,
      pageSize: REVIEW_MAX_PAGE_SIZE,
      samples: 5,
    });

    expect(out.samples).toEqual([]);
    expect(out.perPage).toEqual([]);
    expect(out.fullTick).toBeNull();
    expect(out.meta.pageCount).toBe(0);
    expect(out.meta.mode).toBe("sampling-rollback");
    expect(out.meta.lockNamespace).toBe(LOCK_NAMESPACE);
    expect(fetchPage).toHaveBeenCalledTimes(1);
    // Outer transaction lifecycle: BEGIN happens before the lock probe,
    // ROLLBACK happens in the `finally` after the empty page short-
    // circuits the loop. Between them the runner must have mirrored
    // cadence's first-page state setup (read/init the singleton +
    // markRunning); the snapshot test then verifies those writes are
    // discarded.
    expect(client.queries[0]).toBe("BEGIN");
    expect(client.queries[client.queries.length - 1]).toBe("ROLLBACK");
    expect(
      client.queries.some((sql) =>
        sql.includes("INSERT INTO baseline_corpus_state"),
      ),
    ).toBe(true);
    expect(
      client.queries.some(
        (sql) =>
          sql.includes("FROM baseline_corpus_state") &&
          sql.includes("last_event_cursor"),
      ),
    ).toBe(true);
    expect(
      client.queries.some(
        (sql) =>
          sql.includes("UPDATE baseline_corpus_state") &&
          sql.includes("last_run_status = 'running'"),
      ),
    ).toBe(true);
  });
});

describe("measure-step-f — runStepFMeasurement: initial cursor", () => {
  it("threads `baseline_corpus_state.last_event_cursor` into the first fetch's `after`, not `null`, so the walk starts from the tenant's current watermark", async () => {
    const TENANT_WATERMARK = "cursor-from-prior-tick";
    const { client } = makeScriptedClient({
      lockAcquired: true,
      lastEventCursor: TENANT_WATERMARK,
    });
    const emptyResponse: CadenceConnectionResponse = {
      eventListWithTriage: {
        pageInfo: {
          hasPreviousPage: false,
          hasNextPage: false,
          startCursor: null,
          endCursor: null,
        },
        edges: [],
      },
    };
    const fetchPage: FetchEventPageFn = vi.fn(async () => emptyResponse);

    await runStepFMeasurement({
      client: client as unknown as pg.PoolClient,
      customerId: 7,
      resolver: EMPTY_EXCLUSION_SET_RESOLVER,
      fetchPage,
      pageSize: REVIEW_MAX_PAGE_SIZE,
      samples: 1,
    });

    const mocked = vi.mocked(fetchPage);
    expect(mocked).toHaveBeenCalledTimes(1);
    const firstArgs = mocked.mock.calls[0];
    expect(firstArgs).toBeDefined();
    if (!firstArgs) return;
    expect(firstArgs[0].variables.after).toBe(TENANT_WATERMARK);
  });
});

/**
 * End-to-end measurement block. Gated on `RUNNER_TENANT` so the
 * default Vitest suite (and CI) skip it. When set, the runner walks
 * the chosen tenant against the customer pool, writes the structured
 * JSON output to `RUNNER_OUTPUT_JSON`, and asserts the post-rollback
 * snapshot equality required by the issue's test plan.
 */
const RUNNER_TENANT = process.env.RUNNER_TENANT;
const RUNNER_OUTPUT_JSON = process.env.RUNNER_OUTPUT_JSON;

describe("measure-step-f — end-to-end on a representative tenant", () => {
  it.skipIf(!RUNNER_TENANT)(
    "walks the tenant, emits baseline + treated + advance samples per page, and leaves `observed_event_meta` / `baseline_triaged_event` / `event_group` / `event_group_member` / `baseline_corpus_state` byte-identical after the outer ROLLBACK",
    async () => {
      if (!RUNNER_TENANT) {
        throw new Error("unreachable: gated by skipIf");
      }
      if (!RUNNER_OUTPUT_JSON) {
        throw new Error(
          "RUNNER_OUTPUT_JSON is required — Vitest owns stdout so the runner cannot stream JSON there.",
        );
      }
      const customerId = Number.parseInt(RUNNER_TENANT, 10);
      if (!Number.isInteger(customerId) || customerId <= 0) {
        throw new Error(
          `RUNNER_TENANT must be a positive integer customer id (got ${JSON.stringify(RUNNER_TENANT)}).`,
        );
      }
      const samples = parseIntEnv("RUNNER_SAMPLES", 30);
      const maxPages = parseIntEnv("RUNNER_MAX_PAGES", 200);
      const pageSize = parseIntEnv("RUNNER_PAGE_SIZE", REVIEW_MAX_PAGE_SIZE);

      // Lazy imports: the customer-db / pager / storage modules pull
      // in `import "server-only"` (aliased in the Vitest config) and
      // open real GraphQL clients on import. Keep them out of the
      // module graph of the unit-test blocks above.
      const [{ getCustomerPool }, pager, { STORAGE_EXCLUSION_SET_RESOLVER }] =
        await Promise.all([
          import("@/lib/triage/policy/customer-db"),
          import("@/lib/triage/baseline/pager"),
          import("@/lib/triage/exclusion"),
        ]);
      const fs = await import("node:fs/promises");

      const pool = await getCustomerPool(customerId);
      const client = await pool.connect();
      try {
        const preSnapshot = await readStateSnapshot(client);

        const out = await runStepFMeasurement({
          client,
          customerId,
          resolver: STORAGE_EXCLUSION_SET_RESOLVER,
          fetchPage: pager.fetchEventPage,
          pageSize,
          samples,
          maxPages,
          onProgress: (msg) => {
            process.stderr.write(`[measure-step-f] ${msg}\n`);
          },
        });

        const postSnapshot = await readStateSnapshot(client);
        expect(postSnapshot).toEqual(preSnapshot);

        await fs.writeFile(
          RUNNER_OUTPUT_JSON,
          `${JSON.stringify(out, null, 2)}\n`,
          "utf8",
        );
        process.stderr.write(
          `[measure-step-f] wrote ${out.samples.length} sample rows ` +
            `(${out.meta.pageCount} pages × ${samples} samples × 2 toggles ` +
            `+ ${out.meta.pageCount} advance) to ${RUNNER_OUTPUT_JSON}\n`,
        );
      } finally {
        client.release();
      }
    },
    /* timeout */ 30 * 60 * 1000,
  );
});

function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer (got ${raw}).`);
  }
  return parsed;
}

interface StateSnapshot {
  observedRowCount: number;
  baselineRowCount: number;
  eventGroupRowCount: number;
  eventGroupMemberRowCount: number;
  corpusStateRow: Record<string, unknown> | null;
}

/**
 * Read the row-count + corpus-state snapshot the test plan compares
 * pre- and post-run. `baseline_corpus_state` is a single-row state
 * table, so row equality (not row-count parity) is the gate.
 */
async function readStateSnapshot(client: {
  query: (sql: string) => Promise<{ rows: Record<string, unknown>[] }>;
}): Promise<StateSnapshot> {
  const [observed, baseline, eventGroup, eventGroupMember, corpus] =
    await Promise.all([
      client.query(`SELECT COUNT(*)::bigint AS n FROM observed_event_meta`),
      client.query(`SELECT COUNT(*)::bigint AS n FROM baseline_triaged_event`),
      client.query(`SELECT COUNT(*)::bigint AS n FROM event_group`),
      client.query(`SELECT COUNT(*)::bigint AS n FROM event_group_member`),
      client.query(
        `SELECT last_event_cursor, last_ingested_at, baseline_version,
                exclusions_fp, last_run_status, last_error,
                story_finalized_through
           FROM baseline_corpus_state
          WHERE id = true`,
      ),
    ]);
  return {
    observedRowCount: Number(observed.rows[0]?.n ?? 0),
    baselineRowCount: Number(baseline.rows[0]?.n ?? 0),
    eventGroupRowCount: Number(eventGroup.rows[0]?.n ?? 0),
    eventGroupMemberRowCount: Number(eventGroupMember.rows[0]?.n ?? 0),
    corpusStateRow: corpus.rows[0] ?? null,
  };
}
