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
      // The strictness slider's cutoff is NOT a SQL bind — production
      // keeps the cutoff at the `composeMenu` step (RFC §6 option (a))
      // so the full-cohort bucket aggregates that drive quota
      // allocation are not narrowed by the slider. The harness
      // context's `menuCutoff` is consumed by `sampleAddresses` when
      // it replays `composeMenu`, not by this query's `buildParams`.
      expect(
        lookup("selectMenuCohort").buildParams({ ...ctx, menuCutoff: 0.95 }),
      ).toEqual([
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
        // Default cutoff `0` when no menuCutoff on the context — "All"
        // stop semantics for the detail path.
        0,
      ]);
      // When the harness context carries a non-zero strictness cutoff,
      // the detail query DOES thread it into SQL as a 5th bind. Unlike
      // the menu cohort SELECT (which keeps the cutoff in composeMenu
      // to preserve bucket aggregates), the detail path has no bucket
      // aggregates to protect, so the cutoff lives in the SQL
      // `filtered` CTE — before the per-address `ROW_NUMBER()` — to
      // guarantee every returned row obeys the selected stop.
      expect(
        lookup("selectAssetDetailEventsBatch").buildParams({
          ...ctx,
          menuCutoff: 0.95,
        }),
      ).toEqual([
        ctx.periodStartIso,
        ctx.periodEndIso,
        ctx.addresses,
        TRIAGE_ASSET_DETAIL_LIMIT,
        0.95,
      ]);
    });
  });

  describe("§3/§4 query invariants", () => {
    it("scoring CTE partitions by (kind, baseline_version) in both queries", () => {
      const partitionRe = /PARTITION\s+BY\s+kind,\s*baseline_version/;
      expect(SELECT_MENU_COHORT_SQL).toMatch(partitionRe);
      expect(SELECT_ASSET_DETAIL_EVENTS_BATCH_SQL).toMatch(partitionRe);
    });

    it("menu cohort excludes Blocklist* kinds defensively", () => {
      expect(SELECT_MENU_COHORT_SQL).toMatch(
        /kind\s+NOT\s+LIKE\s+'Blocklist%'/,
      );
      expect(SELECT_ASSET_DETAIL_EVENTS_BATCH_SQL).toMatch(
        /kind\s+NOT\s+LIKE\s+'Blocklist%'/,
      );
    });

    it("does NOT apply the strictness slider cutoff at the SQL level so the full-cohort bucket aggregates that drive quota allocation are preserved (RFC §6 option (a))", () => {
      expect(SELECT_MENU_COHORT_SQL).not.toMatch(/baseline_score\s*>=\s*\$/);
    });

    it("DOES apply the strictness slider cutoff in the asset-detail SQL (#471 Round 4) so detail rows obey the selected stop", () => {
      expect(SELECT_ASSET_DETAIL_EVENTS_BATCH_SQL).toMatch(
        /baseline_score\s*>=\s*\$5/,
      );
    });

    it("applies the asset-detail cutoff inside the `filtered` CTE — BEFORE the per-address `ROW_NUMBER()` — so newer sub-cutoff rows cannot push qualifying older rows out of the newest-N window", () => {
      // Locate the `filtered` CTE block (`filtered AS ( … )`). The
      // cutoff must live inside that CTE's WHERE so it constrains the
      // partition the `ROW_NUMBER()` then numbers. If the cutoff
      // landed in the outer SELECT instead, sub-cutoff rows would
      // still occupy `rn` slots in the per-address partition and
      // displace cutoff-surviving rows from the newest-50 window.
      const filteredMatch =
        /filtered\s+AS\s*\(([\s\S]*?)\)\s*(?:,|SELECT)/.exec(
          SELECT_ASSET_DETAIL_EVENTS_BATCH_SQL,
        );
      expect(filteredMatch).not.toBeNull();
      const filteredBody = filteredMatch?.[1] ?? "";
      expect(filteredBody).toMatch(/ROW_NUMBER\(\)/);
      expect(filteredBody).toMatch(/baseline_score\s*>=\s*\$5/);
    });
  });
});
