/**
 * Coverage for {@link loadSingleBaselineEventWireItem}, the single-
 * event manual-Send loader added in sub-issue #621.
 *
 * The helper is the Detection menu Phase 2 path's entry point: it
 * loads exactly one `baseline_triaged_event` row by `event_key` and
 * runs the same per-event enrichment as the cursor-based streaming
 * slice loader, returning a {@link BaselineStreamingEvent} ready to
 * embed in the `events[]` array of a `phase2.baseline.v1` payload.
 *
 * Tested invariants:
 *
 *  - Returns null when the row does not exist in the corpus (the
 *    routing endpoint maps this to `{ route: "phase1" }`).
 *  - Returns null when `event_key` is not a valid decimal i128 string
 *    (so a non-numeric REview id cannot reach the DB).
 *  - On a hit, the returned shape carries every §6 enrichment field
 *    {@link enrichEvents} produces — `score_window_context`,
 *    `window_signals`, `asset_context`, `scoring_weights_snapshot` —
 *    populated from the same loader fan-out the streaming slice
 *    loader uses (enrichment parity).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface FakeQueryCall {
  sql: string;
  params: unknown[] | undefined;
}

function makeFakePool() {
  const calls: FakeQueryCall[] = [];
  let response: (sql: string) => { rows: unknown[]; rowCount: number } =
    () => ({
      rows: [],
      rowCount: 0,
    });
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      return response(sql);
    }),
    release: vi.fn(),
  };
  const pool = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      return response(sql);
    }),
    connect: vi.fn(async () => client),
  };
  return {
    pool,
    client,
    calls,
    setResponse: (
      fn: (sql: string) => { rows: unknown[]; rowCount: number },
    ) => {
      response = fn;
    },
  };
}

const fake = makeFakePool();
vi.mock("@/lib/triage/policy/customer-db", () => ({
  getCustomerPool: vi.fn(async () => fake.pool),
}));

describe("loadSingleBaselineEventWireItem", () => {
  let baselinePush: typeof import("@/lib/aimer/phase2/baseline-push");

  beforeEach(async () => {
    baselinePush = await import("@/lib/aimer/phase2/baseline-push");
    fake.calls.length = 0;
    fake.client.query.mockClear();
    fake.pool.connect.mockClear();
    fake.client.release.mockClear();
    fake.setResponse(() => ({ rows: [], rowCount: 0 }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null when the event_key is not a valid i128 decimal string", async () => {
    const out = await baselinePush.loadSingleBaselineEventWireItem({
      customerId: 7,
      eventKey: "evt-AAAA-BBBB-CCCC",
    });
    expect(out).toBeNull();
    // The pattern guard short-circuits before any DB connection is
    // taken — keeps the corpus probe off the fast path for non-
    // baseline-passing input that the operator's locator might carry.
    expect(fake.pool.connect).not.toHaveBeenCalled();
  });

  it("returns null when the cursor probe finds no row", async () => {
    fake.setResponse((sql) => {
      if (sql.includes("FROM baseline_triaged_event")) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    });
    const out = await baselinePush.loadSingleBaselineEventWireItem({
      customerId: 7,
      eventKey: "100",
    });
    expect(out).toBeNull();
    // The routing endpoint maps this to `{ route: "phase1" }` so the
    // operator's click falls through to the bridge handoff.
  });

  it("loads + enriches a single row in the BaselineStreamingEvent shape", async () => {
    fake.setResponse((sql) => {
      if (
        sql.includes("FROM baseline_triaged_event\n        WHERE event_key")
      ) {
        return {
          rows: [
            {
              event_key: "100",
              event_time: new Date("2026-01-15T00:00:00Z"),
              event_time_iso: "2026-01-15T00:00:00.000Z",
              kind: "HttpThreat",
              sensor: "s1",
              orig_addr: "10.0.0.1",
              orig_port: 12345,
              resp_addr: "10.0.0.2",
              resp_port: 80,
              proto: 6,
              host: "example.com",
              dns_query: null,
              uri: "/path",
              category: "reconnaissance",
              baseline_version: "phase1b-four-selector",
              exclusions_fp: "fp",
              raw_score: 0.7,
              selector_tags: [],
            },
          ],
          rowCount: 1,
        };
      }
      // Enrichment fan-out: mirror the shapes the streaming slice
      // loader's helpers expect so the single-event helper produces
      // the same §6 fields. Each branch returns the minimum shape
      // the corresponding loader needs to populate the result map.
      if (sql.includes("PARTITION BY kind, baseline_version")) {
        return { rows: [{ event_key: "100", rank: 0.42 }], rowCount: 1 };
      }
      // Peer summary SQL also matches `COUNT(*)::text AS count FROM
      // baseline_triaged_event`, so check the group-by shape first —
      // `GROUP BY orig_addr, kind` (two columns) is unique to the
      // peer-summary loader. The cohort-size SQL groups by `kind`
      // alone.
      if (sql.includes("GROUP BY orig_addr, kind")) {
        return {
          rows: [{ orig_addr: "10.0.0.1", kind: "HttpThreat", count: "3" }],
          rowCount: 1,
        };
      }
      if (
        sql.includes(
          "COUNT(*)::text AS count\n       FROM baseline_triaged_event",
        )
      ) {
        return { rows: [{ kind: "HttpThreat", count: "11" }], rowCount: 1 };
      }
      if (sql.includes("SELECT corpus_activated_at")) {
        return {
          rows: [
            {
              corpus_activated_at: new Date(Date.now() - 30 * 86400 * 1000),
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes("ranked_30d AS")) {
        return {
          rows: [
            {
              event_key: "100",
              s1_7d: 0.5,
              s1_14d: 0.8,
              s1_30d: 0.9,
              s1_7d_has: true,
              s1_14d_has: true,
              s1_30d_has: true,
              s3_7d: "5",
              s3_14d: "8",
              s3_30d: "12",
              s4_7d: "2",
              s4_14d: "3",
              s4_30d: "4",
              s4_keys_7d: ["200"],
              s4_keys_14d: ["200", "300"],
              s4_keys_30d: ["200", "300", "400"],
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });

    const out = await baselinePush.loadSingleBaselineEventWireItem({
      customerId: 7,
      eventKey: "100",
    });
    expect(out).not.toBeNull();
    if (!out) return;
    // Identity passthrough from the row.
    expect(out.event_key).toBe("100");
    expect(out.baseline_version).toBe("phase1b-four-selector");
    expect(out.raw_event.event_key).toBe("100");
    // §6 enrichment fields are populated from the same fan-out the
    // streaming slice loader uses — enrichment parity is what makes
    // this helper a drop-in for "exactly this one event_key" without
    // duplicating the enrichment internals.
    expect(out.score_window_context.kind_cohort_size).toBe(11);
    expect(out.score_window_context.baseline_rank_snapshot).toBeCloseTo(0.42);
    expect(out.window_signals.s1_percentile_rank).toBeCloseTo(0.9);
    // S3 / S4 = MAX − self-exclusion (category present → S4 sub = 1).
    expect(out.window_signals.s3_recurring_count).toBe(11);
    expect(out.window_signals.s4_correlated_count).toBe(3);
    expect(out.window_signals.s4_correlated_event_keys).toEqual([
      "200",
      "300",
      "400",
    ]);
    expect(out.asset_context.primary_asset).toBe("10.0.0.1");
    expect(out.asset_context.peer_event_summary.top_peer_kinds).toEqual([
      { kind: "HttpThreat", count: 3 },
    ]);
    expect(out.scoring_weights_snapshot).toBeTruthy();

    // The probe query is keyed on event_key (the helper does not page
    // forward from a cursor — single-event semantics).
    const probe = fake.calls.find(
      (c) =>
        c.sql.includes("FROM baseline_triaged_event") &&
        c.sql.includes("WHERE event_key"),
    );
    expect(probe).toBeDefined();
    expect(probe?.params?.[0]).toBe("100");

    // Client is released on the happy path.
    expect(fake.client.release).toHaveBeenCalled();
  });
});
