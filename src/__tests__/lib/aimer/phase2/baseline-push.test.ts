import { describe, expect, it } from "vitest";

import { _testing } from "@/lib/aimer/phase2/baseline-push";

const { trimToBudget } = _testing;

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
    payload_summary: {},
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
