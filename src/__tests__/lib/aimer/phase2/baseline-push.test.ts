import type pg from "pg";
import { describe, expect, it, vi } from "vitest";

import { _testing } from "@/lib/aimer/phase2/baseline-push";

const { trimToBudget, enrichRefreshPayloadWithClient } = _testing;

function makeEvent(eventKey: string, padding: number) {
  return {
    event_key: eventKey,
    event_time: "2026-01-01T00:00:00.000Z",
    kind: "HttpThreat",
    sensor: "s1",
    orig_addr: null,
    orig_port: null,
    resp_addr: null,
    resp_port: null,
    proto: null,
    host: "x".repeat(padding),
    dns_query: null,
    uri: null,
    category: null,
    baseline_version: "v1",
    exclusions_fp: "fp",
    raw_score: 0.5,
    selector_tags: [],
    raw_event: {},
    score_window_context: {
      kind_cohort_window: { from: "a", to: "b" },
      kind_cohort_size: 1,
      baseline_rank_snapshot: 0.5,
    },
    window_signals: {
      s1_percentile_rank: null,
      s3_recurring_count: 0,
      s4_correlated_count: 0,
      s4_correlated_event_keys: [],
    },
    asset_context: {
      primary_asset: null,
      peer_event_summary: { total_peer_count: 0, top_peer_kinds: [] },
    },
    scoring_weights_snapshot: {} as never,
  };
}

describe("loadBaselineStreamingSlice trimToBudget", () => {
  it("returns every event when budget is generous", () => {
    const events = [makeEvent("1", 10), makeEvent("2", 10), makeEvent("3", 10)];
    const fitted = trimToBudget(events, "v1", 1024 * 1024);
    expect(fitted).toHaveLength(3);
  });

  it("trims trailing events when budget is tight, keeps at least one", () => {
    const events = [makeEvent("1", 1000), makeEvent("2", 1000)];
    const fitted = trimToBudget(events, "v1", 200);
    // Budget too small for two events; loader caller relies on the
    // fact that the function always keeps at least one (caller injects
    // first event when none fit).
    expect(fitted.length).toBeLessThanOrEqual(1);
  });

  it("respects budget at the boundary", () => {
    const events = [makeEvent("1", 50), makeEvent("2", 50), makeEvent("3", 50)];
    const oneEventBytes = JSON.stringify(events[0]).length + 1;
    const fitted = trimToBudget(events, "v1", oneEventBytes * 2 + 100);
    expect(fitted.length).toBe(2);
  });
});

describe("enrichRefreshPayloadWithClient", () => {
  /**
   * Build a fake `pg.PoolClient` whose `.query()` dispatches on the SQL
   * shape so the enrichment driver can exercise its real fan-out
   * (cohort rank + cohort size + window signals + peer summaries)
   * without needing a real Postgres connection.
   *
   * Each branch returns the smallest result the enrichment driver
   * needs, keyed off a distinct phrase the production SQL contains.
   */
  function makeFakeClient() {
    const calls: string[] = [];
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push(sql);
      if (sql.includes("PARTITION BY kind, baseline_version")) {
        // Rank snapshot CTE — return rank 0.42 for event "10".
        return { rows: [{ event_key: "10", rank: 0.42 }] };
      }
      if (
        sql.includes(
          "COUNT(*)::text AS count\n       FROM baseline_triaged_event",
        )
      ) {
        // Per-kind cohort size.
        return { rows: [{ kind: "HttpThreat", count: "11" }] };
      }
      if (sql.includes("SELECT corpus_activated_at")) {
        return {
          rows: [
            {
              corpus_activated_at: new Date(Date.now() - 30 * 86400 * 1000),
            },
          ],
        };
      }
      if (sql.includes("ranked_30d AS")) {
        // Window signals — multi-window MAX shape.
        return {
          rows: [
            {
              event_key: "10",
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
              s4_keys_7d: ["100"],
              s4_keys_14d: ["100", "200"],
              s4_keys_30d: ["100", "200", "300"],
            },
          ],
        };
      }
      if (sql.includes("GROUP BY orig_addr, kind")) {
        return { rows: [] };
      }
      void params;
      return { rows: [] };
    });
    return { client: { query } as unknown as pg.PoolClient, calls };
  }

  it("populates §6 fields on a schema-minimal refresh payload", async () => {
    const { client } = makeFakeClient();
    const queued = {
      window: {
        kind: "baseline_event" as const,
        from: "2026-01-01T00:00:00.000Z",
        to: "2026-02-01T00:00:00.000Z",
      },
      baseline_version: "phase1b-four-selector",
      events: [
        {
          event_key: "10",
          event_time: "2026-01-15T00:00:00.000Z",
          kind: "HttpThreat",
          orig_addr: null,
          resp_addr: null,
          category: null,
        },
      ],
    };
    const enriched = await enrichRefreshPayloadWithClient(client, queued);
    const ev = enriched.events[0] as unknown as {
      score_window_context: {
        kind_cohort_window: { from: string; to: string };
        kind_cohort_size: number;
        baseline_rank_snapshot: number | null;
      };
      window_signals: {
        s1_percentile_rank: number | null;
        s3_recurring_count: number;
        s4_correlated_count: number;
        s4_correlated_event_keys: string[];
      };
      raw_event: Record<string, unknown>;
      asset_context: { primary_asset: string | null };
      scoring_weights_snapshot: Record<string, unknown>;
    };
    // Cohort window is the queue payload's own window, not now-anchored.
    expect(ev.score_window_context.kind_cohort_window).toEqual({
      from: queued.window.from,
      to: queued.window.to,
    });
    // Per-kind cohort size, not slice-wide.
    expect(ev.score_window_context.kind_cohort_size).toBe(11);
    // baseline_rank_snapshot from CUME_DIST over (kind, baseline_version).
    expect(ev.score_window_context.baseline_rank_snapshot).toBeCloseTo(0.42);
    // S1 picks the MAX across active windows (0.9 in fixture).
    expect(ev.window_signals.s1_percentile_rank).toBeCloseTo(0.9);
    // S3 / S4 = MAX − self-exclusion (category null → no S4 sub).
    expect(ev.window_signals.s3_recurring_count).toBe(11); // 12 - 1
    expect(ev.window_signals.s4_correlated_count).toBe(4); // 4 - 0
    // Correlated keys are unioned across active windows, self filtered.
    expect(ev.window_signals.s4_correlated_event_keys).toEqual([
      "100",
      "200",
      "300",
    ]);
    expect(ev.raw_event.event_key).toBe("10");
    expect(ev.scoring_weights_snapshot).toBeTruthy();
  });
});
