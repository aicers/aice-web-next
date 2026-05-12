import { describe, expect, it } from "vitest";

import {
  MEASURED_QUERIES,
  MENU_CANDIDATES_PER_BUCKET,
  PER_ASSET_OBSERVED_COUNTS_SQL,
  SELECT_ASSET_DETAIL_EVENTS_BATCH_SQL,
  SELECT_MENU_COHORT_SQL,
  TRIAGE_ASSET_DETAIL_LIMIT,
} from "@/lib/triage/baseline/read-path-sql.mjs";

describe("read-path-sql shared module", () => {
  describe("§5 orig_addr cast cleanup", () => {
    it("binds perAssetObservedCounts addresses as inet[], not text[]", () => {
      expect(PER_ASSET_OBSERVED_COUNTS_SQL).toMatch(
        /orig_addr\s*=\s*ANY\(\$3::inet\[\]\)/,
      );
      expect(PER_ASSET_OBSERVED_COUNTS_SQL).not.toMatch(
        /orig_addr::text\s*=\s*ANY/,
      );
      expect(PER_ASSET_OBSERVED_COUNTS_SQL).not.toMatch(/::text\[\]/);
    });

    it("binds selectAssetDetailEventsBatch addresses as inet[], not text[]", () => {
      expect(SELECT_ASSET_DETAIL_EVENTS_BATCH_SQL).toMatch(
        /orig_addr\s*=\s*ANY\(\$3::inet\[\]\)/,
      );
      expect(SELECT_ASSET_DETAIL_EVENTS_BATCH_SQL).not.toMatch(
        /orig_addr::text\s*=\s*ANY/,
      );
    });
  });

  describe("query coverage", () => {
    it("exposes the five measured queries in MEASURED_QUERIES", () => {
      const names = MEASURED_QUERIES.map((q) => q.name);
      expect(names).toEqual([
        "selectMenuCohort",
        "countObserved",
        "countTriaged",
        "perAssetObservedCounts",
        "selectAssetDetailEventsBatch",
      ]);
    });

    it("buildParams returns the parameter shape each query expects", () => {
      const ctx = {
        periodStartIso: "2026-04-12T00:00:00.000Z",
        periodEndIso: "2026-05-12T00:00:00.000Z",
        observedFromIso: "2026-04-12T00:00:00.000Z",
        addresses: ["10.0.0.1", "10.0.0.2"],
      };
      const byName = new Map(MEASURED_QUERIES.map((q) => [q.name, q]));
      const lookup = (name: string) => {
        const q = byName.get(name);
        if (q === undefined) throw new Error(`missing query: ${name}`);
        return q;
      };

      expect(lookup("selectMenuCohort").buildParams(ctx)).toEqual([
        ctx.periodStartIso,
        ctx.periodEndIso,
        MENU_CANDIDATES_PER_BUCKET,
      ]);
      expect(lookup("countObserved").buildParams(ctx)).toEqual([
        ctx.observedFromIso,
        ctx.periodEndIso,
      ]);
      expect(lookup("countTriaged").buildParams(ctx)).toEqual([
        ctx.periodStartIso,
        ctx.periodEndIso,
      ]);
      expect(lookup("perAssetObservedCounts").buildParams(ctx)).toEqual([
        ctx.observedFromIso,
        ctx.periodEndIso,
        ctx.addresses,
      ]);
      expect(lookup("selectAssetDetailEventsBatch").buildParams(ctx)).toEqual([
        ctx.periodStartIso,
        ctx.periodEndIso,
        ctx.addresses,
        TRIAGE_ASSET_DETAIL_LIMIT,
      ]);
    });
  });

  describe("§3/§4 query invariants", () => {
    it("scoring CTE partitions by (kind, baseline_version) in both queries", () => {
      const partitionRe = /PARTITION\s+BY\s+kind,\s*baseline_version/;
      expect(SELECT_MENU_COHORT_SQL).toMatch(partitionRe);
      expect(SELECT_ASSET_DETAIL_EVENTS_BATCH_SQL).toMatch(partitionRe);
    });

    it("menu cohort excludes BlockList* kinds defensively", () => {
      expect(SELECT_MENU_COHORT_SQL).toMatch(
        /kind\s+NOT\s+LIKE\s+'BlockList%'/,
      );
      expect(SELECT_ASSET_DETAIL_EVENTS_BATCH_SQL).toMatch(
        /kind\s+NOT\s+LIKE\s+'BlockList%'/,
      );
    });
  });
});
