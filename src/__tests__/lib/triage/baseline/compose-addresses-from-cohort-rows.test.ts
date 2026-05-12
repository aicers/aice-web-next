/**
 * `addressesFromCohortRows` is the shared address-derivation entry
 * point that the production read path (via `composeMenuFromCohort`
 * → `uniqueAddresses` in `server-actions.ts`) and the measurement
 * harness (`scripts/measure-baseline-read-path.mjs`) both reduce to.
 * This suite locks down its behavior so a future divergence between
 * the harness's address slice and production's address slice trips a
 * test instead of silently producing measurements #528 cannot trust.
 */

import { describe, expect, it } from "vitest";

import {
  addressesFromCohortRows,
  type CohortInputRow,
} from "@/lib/triage/baseline/compose.mjs";

function row(overrides: Partial<CohortInputRow>): CohortInputRow {
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

describe("addressesFromCohortRows", () => {
  it("returns an empty array when the cohort is empty", () => {
    expect(addressesFromCohortRows([])).toEqual([]);
  });

  it("deduplicates orig_addr in compose-menu order", () => {
    const rows: CohortInputRow[] = [
      row({
        event_key: "1",
        orig_addr: "10.0.0.1",
        baseline_score: 0.99,
        cohort_count: "5",
        bucket_count: "5",
      }),
      row({
        event_key: "2",
        orig_addr: "10.0.0.2",
        baseline_score: 0.95,
        cohort_count: "5",
        bucket_count: "5",
      }),
      row({
        event_key: "3",
        orig_addr: "10.0.0.1",
        baseline_score: 0.9,
        cohort_count: "5",
        bucket_count: "5",
      }),
      row({
        event_key: "4",
        orig_addr: "10.0.0.3",
        baseline_score: 0.85,
        cohort_count: "5",
        bucket_count: "5",
      }),
    ];
    expect(addressesFromCohortRows(rows)).toEqual([
      "10.0.0.1",
      "10.0.0.2",
      "10.0.0.3",
    ]);
  });

  it("skips null/missing orig_addr (production uniqueAddresses skips falsy values)", () => {
    const rows: CohortInputRow[] = [
      row({
        event_key: "1",
        orig_addr: null,
        baseline_score: 0.99,
        cohort_count: "3",
        bucket_count: "3",
      }),
      row({
        event_key: "2",
        orig_addr: "10.0.0.5",
        baseline_score: 0.98,
        cohort_count: "3",
        bucket_count: "3",
      }),
      row({
        event_key: "3",
        orig_addr: "10.0.0.6",
        baseline_score: 0.97,
        cohort_count: "3",
        bucket_count: "3",
      }),
    ];
    expect(addressesFromCohortRows(rows)).toEqual(["10.0.0.5", "10.0.0.6"]);
  });

  it("caps the result at `limit` (mirrors TRIAGE_ASSET_PAGE_SIZE upstream)", () => {
    const rows: CohortInputRow[] = Array.from({ length: 5 }, (_, i) =>
      row({
        event_key: String(i + 1),
        orig_addr: `10.0.0.${i + 1}`,
        baseline_score: 1 - i * 0.01,
        cohort_count: "5",
        bucket_count: "5",
      }),
    );
    expect(addressesFromCohortRows(rows, { limit: 2 })).toEqual([
      "10.0.0.1",
      "10.0.0.2",
    ]);
  });

  it("drops rows that the compose pass would not surface (cutoff above their baseline_score)", () => {
    // With cutoff = 1.0 every row whose baseline_score < 1.0 is
    // excluded from the assembly pass. The §6 fallback then takes
    // the global top by baseline_score DESC — so we still get the
    // single top row.
    const rows: CohortInputRow[] = [
      row({
        event_key: "1",
        orig_addr: "10.0.0.10",
        baseline_score: 1.0,
        cohort_count: "2",
        bucket_count: "2",
      }),
      row({
        event_key: "2",
        orig_addr: "10.0.0.11",
        baseline_score: 0.1,
        cohort_count: "2",
        bucket_count: "2",
      }),
    ];
    expect(addressesFromCohortRows(rows, { cutoff: 1.0 })).toEqual([
      "10.0.0.10",
    ]);
  });
});
