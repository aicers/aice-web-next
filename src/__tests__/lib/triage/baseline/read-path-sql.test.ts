import { describe, expect, it } from "vitest";

import {
  COUNT_ELIGIBLE_BY_STOP_SQL,
  MEASURED_QUERIES,
  MENU_CANDIDATES_PER_BUCKET,
  PER_ASSET_OBSERVED_COUNTS_SQL,
  SELECT_ASSET_DETAIL_EVENTS_BATCH_SQL,
  SELECT_MENU_COHORT_SQL,
  SELECT_STORY_PROTECTED_COHORT_SQL,
  STORY_PROTECTED_PER_TENANT_LIMIT,
  TRIAGE_ASSET_DETAIL_LIMIT,
} from "@/lib/triage/baseline/read-path-sql.mjs";
import {
  CRITICAL_CATEGORIES,
  CRITICAL_SELECTOR_SET,
  LOWSLOW_SELECTOR_SET,
  R4_MIN_SOURCES,
  R5_MIN_SOURCES,
  R5_MIN_VICTIMS,
} from "@/lib/triage/story/critical-sets.mjs";
import {
  buildReadR1CandidatesSql,
  buildReadR2CandidatesPhase1Sql,
  buildReadR2CandidatesPhase2Sql,
  buildReadR3CandidatesPhase1Sql,
  buildReadR3CandidatesPhase2Sql,
  buildReadR4CandidatesPhase1Sql,
  buildReadR4CandidatesPhase2Sql,
  buildReadR5CandidatesPhase1Sql,
  buildReadR5CandidatesPhase2Sql,
  buildReadR6CandidatesPhase1Sql,
  buildReadR6CandidatesPhase2Sql,
} from "@/lib/triage/story/read-path-sql.mjs";
import { STRICTNESS_STOPS } from "@/lib/triage/strictness/stops";

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
    it("exposes the menu queries plus the R1 / R3 / R4 / R5 / R6 / R2 cadence entries as (name, context) pairs in MEASURED_QUERIES", () => {
      // #471 adds two queries — `selectStoryProtectedCohort` (branch
      // B force-union) and `countEligibleByStop` (per-stop preview
      // hints). #601 adds R1 + R3 phase-1 + R3 phase-2 cadence
      // entries, each in two contexts (first-tick / slop-replay).
      // #694 adds R4 phase-1/phase-2 and R5 phase-1/phase-2, also in
      // two contexts each. #701 adds R6 phase-1/phase-2 (the
      // low-and-slow sweep), again two contexts each. #702 adds R2
      // phase-1/phase-2 (the multi-stage low-and-slow sweep pass), again
      // two contexts each — so the flat (query, context) list now has
      // seven menu entries plus twenty-two cadence/sweep entries.
      const pairs = MEASURED_QUERIES.map((q) => `${q.name}:${q.context}`);
      expect(pairs).toEqual([
        "selectMenuCohort:default",
        "countObserved:default",
        "countTriaged:default",
        "perAssetObservedCounts:default",
        "selectAssetDetailEventsBatch:default",
        "selectStoryProtectedCohort:default",
        "countEligibleByStop:default",
        "readR1Candidates:first-tick",
        "readR1Candidates:slop-replay",
        "readR3CandidatesPhase1:first-tick",
        "readR3CandidatesPhase1:slop-replay",
        "readR3CandidatesPhase2:first-tick",
        "readR3CandidatesPhase2:slop-replay",
        "readR4CandidatesPhase1:first-tick",
        "readR4CandidatesPhase1:slop-replay",
        "readR4CandidatesPhase2:first-tick",
        "readR4CandidatesPhase2:slop-replay",
        "readR5CandidatesPhase1:first-tick",
        "readR5CandidatesPhase1:slop-replay",
        "readR5CandidatesPhase2:first-tick",
        "readR5CandidatesPhase2:slop-replay",
        "readR6CandidatesPhase1:first-tick",
        "readR6CandidatesPhase1:slop-replay",
        "readR6CandidatesPhase2:first-tick",
        "readR6CandidatesPhase2:slop-replay",
        "readR2CandidatesPhase1:first-tick",
        "readR2CandidatesPhase1:slop-replay",
        "readR2CandidatesPhase2:first-tick",
        "readR2CandidatesPhase2:slop-replay",
      ]);
    });

    it("buildParams returns the parameter shape each query expects", () => {
      const ctx = {
        periodStartIso: "2026-04-12T00:00:00.000Z",
        periodEndIso: "2026-05-12T00:00:00.000Z",
        observedFromIso: "2026-04-12T00:00:00.000Z",
        addresses: ["10.0.0.1", "10.0.0.2"],
        memberScanStartIso: "2026-05-11T23:00:00.000Z",
        memberScanEndIso: "2026-05-12T00:00:00.000Z",
      };
      // Menu entries have unique names; cadence entries repeat names
      // across contexts. The lookup helper restricts itself to the
      // default-context (menu) entries to keep the existing
      // assertions byName-stable.
      const byName = new Map(
        MEASURED_QUERIES.filter((q) => q.context === "default").map((q) => [
          q.name,
          q,
        ]),
      );
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

    it("threads the per-bucket cap and slider cutoff into the branch B SQL so per-tenant LIMIT is applied to branch-B-unique rows, not branch-A overlap (#596 Round 2 / Round 4)", () => {
      // The two extra binds are how branch B predicts branch A's
      // SQL/composeMenu coverage in-database — `bucket_rn > $4` flags
      // rows branch A's SQL cohort cannot include, `baseline_score
      // < $5` flags rows branch A's `composeMenu` cutoff filter cannot
      // include. The ORDER BY pulls branch-B-unique rows to the head
      // so the per-tenant LIMIT never strands a row that needed
      // force-union. The truncation banner uses an unfiltered
      // `COUNT(*) OVER ()` of in-window Story members (#596 Round 4
      // item 2) — the merge layer subtracts the visible Story count
      // (identified via the menu cohort's `in_story` projection) to
      // avoid the Round 2 over-attribution risk in JS rather than in
      // SQL.
      expect(SELECT_STORY_PROTECTED_COHORT_SQL).toMatch(
        /bucket_rn\s*>\s*\$4\s+OR\s+baseline_score\s*<\s*\$5/,
      );
      // The protected-total projection is an unfiltered COUNT(*) OVER ()
      // — the Round 2 FILTER was removed in Round 4 because the merge
      // layer can now identify branch-A-shown Story members via
      // `MenuCohortDbRow.in_story` and compute the dropped count
      // exactly without a SQL-side pre-filter.
      expect(SELECT_STORY_PROTECTED_COHORT_SQL).toMatch(
        /COUNT\(\*\)\s+OVER\s*\(\)\s+AS\s+protected_total_in_window/,
      );
      expect(SELECT_STORY_PROTECTED_COHORT_SQL).not.toMatch(
        /COUNT\(\*\)\s+FILTER\s*\(WHERE\s+branch_b_unique\)/,
      );
      // The ORDER BY pulls branch-B-unique rows to the head of the
      // result before falling back to the §3 priority sort, so a
      // tenant whose branch-A overlap exceeds the per-tenant LIMIT
      // still surfaces every unique row.
      expect(SELECT_STORY_PROTECTED_COHORT_SQL).toMatch(
        /ORDER BY\s+branch_b_unique\s+DESC,\s+baseline_score\s+DESC/,
      );
      // bucket_rn must use branch A's exact partition + ordering so
      // the prediction is correct, not approximate.
      expect(SELECT_STORY_PROTECTED_COHORT_SQL).toMatch(
        /PARTITION BY kind,\s*is_unlabeled[\s\S]*?ORDER BY baseline_score DESC,\s*event_time DESC,\s*event_key DESC[\s\S]*?\)\s+AS bucket_rn/,
      );
    });

    it("projects `in_story` on the menu cohort SELECT so branch A's Story membership is visible to the merge layer (#596 Round 4 item 2)", () => {
      // Without this, the merge layer could not distinguish branch-A-
      // shown Story members from branch-A-shown non-Story rows, and
      // `storyProtectedDroppedCount` would either over-attribute
      // (using the unfiltered SQL pre-count) or under-detect (using
      // the FILTERed pre-count under SQL LIMIT pressure).
      expect(SELECT_MENU_COHORT_SQL).toMatch(
        /EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+event_group_member\s+m\s+WHERE\s+m\.event_key\s*=\s*baseline_triaged_event\.event_key\s*\)\s+AS\s+in_story/,
      );
      expect(SELECT_MENU_COHORT_SQL).toMatch(/in_story\s+AS\s+in_story/);
    });

    it("buildParams for selectStoryProtectedCohort threads MENU_CANDIDATES_PER_BUCKET and menuCutoff into the SQL binds (#596 Round 2 item 1)", () => {
      const ctx = {
        periodStartIso: "2026-04-12T00:00:00.000Z",
        periodEndIso: "2026-05-12T00:00:00.000Z",
        observedFromIso: "2026-04-12T00:00:00.000Z",
        addresses: [],
        memberScanStartIso: null,
        memberScanEndIso: "2026-05-12T00:00:00.000Z",
      };
      const branchB = MEASURED_QUERIES.find(
        (q) => q.name === "selectStoryProtectedCohort",
      );
      if (!branchB) throw new Error("selectStoryProtectedCohort not measured");
      // Default cutoff `0` (no `menuCutoff` on context) ⇒ "All" stop;
      // every in-story row is treated as branch-B-unique only when its
      // `bucket_rn` exceeds the cap, which is the correct semantic at
      // the "All" stop (composeMenu still lifts quota there).
      expect(branchB.buildParams(ctx)).toEqual([
        ctx.periodStartIso,
        ctx.periodEndIso,
        STORY_PROTECTED_PER_TENANT_LIMIT,
        MENU_CANDIDATES_PER_BUCKET,
        0,
      ]);
      // A non-zero cutoff (e.g. Top 5%) threads through so the SQL's
      // `branch_b_unique` predicate picks up the sub-cutoff rows that
      // branch A's `composeMenu` would have dropped.
      expect(branchB.buildParams({ ...ctx, menuCutoff: 0.95 })).toEqual([
        ctx.periodStartIso,
        ctx.periodEndIso,
        STORY_PROTECTED_PER_TENANT_LIMIT,
        MENU_CANDIDATES_PER_BUCKET,
        0.95,
      ]);
    });

    it("eligible-by-stop SQL has one FILTER per non-'all' stop, and each filter cutoff matches that stop's `STRICTNESS_STOPS` cutoff (drift guard for #471 §4)", () => {
      // The slider chip's "≈ N" preview hint is summed from the
      // per-stop FILTER aggregates here. If a future stop change
      // touched `STRICTNESS_STOPS` but missed the SQL (or vice versa),
      // the preview would silently disagree with the loaded result.
      const stops = STRICTNESS_STOPS.filter((s) => s.id !== "all");
      const filterRe =
        /COUNT\(\*\)\s+FILTER\s+\(WHERE\s+baseline_score\s*>=\s*([\d.]+)\s+OR\s+in_story\)/g;
      const cutoffsInSql = Array.from(
        COUNT_ELIGIBLE_BY_STOP_SQL.matchAll(filterRe),
        (m) => Number(m[1]),
      ).sort((a, b) => a - b);
      const cutoffsInStops = stops.map((s) => s.cutoff).sort((a, b) => a - b);
      expect(cutoffsInSql).toEqual(cutoffsInStops);
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

  describe("R1 / R3 cadence entries (issue #601)", () => {
    const ctx = {
      periodStartIso: "2026-04-12T00:00:00.000Z",
      periodEndIso: "2026-05-12T00:00:00.000Z",
      observedFromIso: "2026-04-12T00:00:00.000Z",
      addresses: [],
      memberScanStartIso: "2026-05-11T23:00:00.000Z",
      memberScanEndIso: "2026-05-12T00:00:00.000Z",
      r3CandidateAssets: {
        firstTick: ["10.0.0.1", "10.0.0.2"],
        slopReplay: ["10.0.0.3"],
      },
    };

    const lookup = (name: string, context: "first-tick" | "slop-replay") => {
      const q = MEASURED_QUERIES.find(
        (e) => e.name === name && e.context === context,
      );
      if (q === undefined) {
        throw new Error(`missing measured entry: ${name}:${context}`);
      }
      return q;
    };

    it("readR1Candidates SQL matches the cadence builder byte-for-byte", () => {
      expect(lookup("readR1Candidates", "first-tick").sql).toBe(
        buildReadR1CandidatesSql({ memberScanStartIsNull: true }),
      );
      expect(lookup("readR1Candidates", "slop-replay").sql).toBe(
        buildReadR1CandidatesSql({ memberScanStartIsNull: false }),
      );
    });

    it("readR3CandidatesPhase1 SQL matches the cadence builder byte-for-byte", () => {
      expect(lookup("readR3CandidatesPhase1", "first-tick").sql).toBe(
        buildReadR3CandidatesPhase1Sql({ memberScanStartIsNull: true }),
      );
      expect(lookup("readR3CandidatesPhase1", "slop-replay").sql).toBe(
        buildReadR3CandidatesPhase1Sql({ memberScanStartIsNull: false }),
      );
    });

    it("readR3CandidatesPhase2 SQL matches the cadence builder byte-for-byte", () => {
      expect(lookup("readR3CandidatesPhase2", "first-tick").sql).toBe(
        buildReadR3CandidatesPhase2Sql({ memberScanStartIsNull: true }),
      );
      expect(lookup("readR3CandidatesPhase2", "slop-replay").sql).toBe(
        buildReadR3CandidatesPhase2Sql({ memberScanStartIsNull: false }),
      );
    });

    it("first-tick buildParams omit the lower bound", () => {
      const r1 = lookup("readR1Candidates", "first-tick").buildParams(ctx);
      expect(r1).toEqual([
        ctx.memberScanEndIso,
        Array.from(CRITICAL_CATEGORIES),
      ]);

      const p1 = lookup("readR3CandidatesPhase1", "first-tick").buildParams(
        ctx,
      );
      expect(p1).toEqual([
        ctx.memberScanEndIso,
        Array.from(CRITICAL_SELECTOR_SET),
      ]);

      const p2 = lookup("readR3CandidatesPhase2", "first-tick").buildParams(
        ctx,
      );
      expect(p2).toEqual([
        ctx.memberScanEndIso,
        ctx.r3CandidateAssets.firstTick,
        Array.from(CRITICAL_SELECTOR_SET),
      ]);
    });

    it("slop-replay buildParams bind both bounds and use the slop-replay asset list", () => {
      const r1 = lookup("readR1Candidates", "slop-replay").buildParams(ctx);
      expect(r1).toEqual([
        ctx.memberScanStartIso,
        ctx.memberScanEndIso,
        Array.from(CRITICAL_CATEGORIES),
      ]);

      const p1 = lookup("readR3CandidatesPhase1", "slop-replay").buildParams(
        ctx,
      );
      expect(p1).toEqual([
        ctx.memberScanStartIso,
        ctx.memberScanEndIso,
        Array.from(CRITICAL_SELECTOR_SET),
      ]);

      const p2 = lookup("readR3CandidatesPhase2", "slop-replay").buildParams(
        ctx,
      );
      expect(p2).toEqual([
        ctx.memberScanStartIso,
        ctx.memberScanEndIso,
        ctx.r3CandidateAssets.slopReplay,
        Array.from(CRITICAL_SELECTOR_SET),
      ]);
    });

    it("critical-category / critical-selector sets resolve identically to the cadence's source-of-truth `.mjs`", () => {
      // Round-trip via buildParams ⇒ the embedded array is the same
      // reference (or at least the same string content) the harness
      // sees — guarantees the cadence-layer and harness-layer reads
      // come from one source.
      const r1Params = lookup("readR1Candidates", "first-tick").buildParams(
        ctx,
      ) as ReadonlyArray<unknown>;
      expect(r1Params[1]).toEqual(Array.from(CRITICAL_CATEGORIES));
      const p1Params = lookup(
        "readR3CandidatesPhase1",
        "first-tick",
      ).buildParams(ctx) as ReadonlyArray<unknown>;
      expect(p1Params[1]).toEqual(Array.from(CRITICAL_SELECTOR_SET));
    });
  });

  describe("R4 / R5 multi-source cadence entries (issue #694)", () => {
    const ctx = {
      periodStartIso: "2026-04-12T00:00:00.000Z",
      periodEndIso: "2026-05-12T00:00:00.000Z",
      observedFromIso: "2026-04-12T00:00:00.000Z",
      addresses: [],
      memberScanStartIso: "2026-05-11T23:00:00.000Z",
      memberScanEndIso: "2026-05-12T00:00:00.000Z",
      r4CandidateVictims: {
        firstTick: ["10.0.0.9"],
        slopReplay: ["10.0.0.8", "10.0.0.7"],
      },
      r5CandidateCategories: {
        firstTick: ["IMPACT"],
        slopReplay: ["EXFILTRATION"],
      },
    };

    const lookup = (name: string, context: "first-tick" | "slop-replay") => {
      const q = MEASURED_QUERIES.find(
        (e) => e.name === name && e.context === context,
      );
      if (q === undefined) {
        throw new Error(`missing measured entry: ${name}:${context}`);
      }
      return q;
    };

    it("R4 / R5 SQL matches the cadence builders byte-for-byte", () => {
      expect(lookup("readR4CandidatesPhase1", "first-tick").sql).toBe(
        buildReadR4CandidatesPhase1Sql({ memberScanStartIsNull: true }),
      );
      expect(lookup("readR4CandidatesPhase1", "slop-replay").sql).toBe(
        buildReadR4CandidatesPhase1Sql({ memberScanStartIsNull: false }),
      );
      expect(lookup("readR4CandidatesPhase2", "first-tick").sql).toBe(
        buildReadR4CandidatesPhase2Sql({ memberScanStartIsNull: true }),
      );
      expect(lookup("readR4CandidatesPhase2", "slop-replay").sql).toBe(
        buildReadR4CandidatesPhase2Sql({ memberScanStartIsNull: false }),
      );
      expect(lookup("readR5CandidatesPhase1", "first-tick").sql).toBe(
        buildReadR5CandidatesPhase1Sql({ memberScanStartIsNull: true }),
      );
      expect(lookup("readR5CandidatesPhase1", "slop-replay").sql).toBe(
        buildReadR5CandidatesPhase1Sql({ memberScanStartIsNull: false }),
      );
      expect(lookup("readR5CandidatesPhase2", "first-tick").sql).toBe(
        buildReadR5CandidatesPhase2Sql({ memberScanStartIsNull: true }),
      );
      expect(lookup("readR5CandidatesPhase2", "slop-replay").sql).toBe(
        buildReadR5CandidatesPhase2Sql({ memberScanStartIsNull: false }),
      );
    });

    it("R4 phase-1 binds the source threshold; first-tick omits the lower bound", () => {
      expect(
        lookup("readR4CandidatesPhase1", "first-tick").buildParams(ctx),
      ).toEqual([
        ctx.memberScanEndIso,
        Array.from(CRITICAL_CATEGORIES),
        Array.from(CRITICAL_SELECTOR_SET),
        R4_MIN_SOURCES,
      ]);
      expect(
        lookup("readR4CandidatesPhase1", "slop-replay").buildParams(ctx),
      ).toEqual([
        ctx.memberScanStartIso,
        ctx.memberScanEndIso,
        Array.from(CRITICAL_CATEGORIES),
        Array.from(CRITICAL_SELECTOR_SET),
        R4_MIN_SOURCES,
      ]);
    });

    it("R4 phase-2 binds the probed victim list", () => {
      expect(
        lookup("readR4CandidatesPhase2", "first-tick").buildParams(ctx),
      ).toEqual([
        ctx.memberScanEndIso,
        ctx.r4CandidateVictims.firstTick,
        Array.from(CRITICAL_CATEGORIES),
        Array.from(CRITICAL_SELECTOR_SET),
      ]);
      expect(
        lookup("readR4CandidatesPhase2", "slop-replay").buildParams(ctx),
      ).toEqual([
        ctx.memberScanStartIso,
        ctx.memberScanEndIso,
        ctx.r4CandidateVictims.slopReplay,
        Array.from(CRITICAL_CATEGORIES),
        Array.from(CRITICAL_SELECTOR_SET),
      ]);
    });

    it("R5 phase-1 binds the source AND victim thresholds", () => {
      expect(
        lookup("readR5CandidatesPhase1", "first-tick").buildParams(ctx),
      ).toEqual([
        ctx.memberScanEndIso,
        Array.from(CRITICAL_CATEGORIES),
        Array.from(CRITICAL_SELECTOR_SET),
        R5_MIN_SOURCES,
        R5_MIN_VICTIMS,
      ]);
      expect(
        lookup("readR5CandidatesPhase1", "slop-replay").buildParams(ctx),
      ).toEqual([
        ctx.memberScanStartIso,
        ctx.memberScanEndIso,
        Array.from(CRITICAL_CATEGORIES),
        Array.from(CRITICAL_SELECTOR_SET),
        R5_MIN_SOURCES,
        R5_MIN_VICTIMS,
      ]);
    });

    it("R5 phase-2 binds the probed campaign-category list", () => {
      expect(
        lookup("readR5CandidatesPhase2", "first-tick").buildParams(ctx),
      ).toEqual([
        ctx.memberScanEndIso,
        ctx.r5CandidateCategories.firstTick,
        Array.from(CRITICAL_SELECTOR_SET),
      ]);
      expect(
        lookup("readR5CandidatesPhase2", "slop-replay").buildParams(ctx),
      ).toEqual([
        ctx.memberScanStartIso,
        ctx.memberScanEndIso,
        ctx.r5CandidateCategories.slopReplay,
        Array.from(CRITICAL_SELECTOR_SET),
      ]);
    });

    it("R4 phase-1 SQL pre-aggregates `(resp_addr, category)` with a distinct-source HAVING", () => {
      const sql = buildReadR4CandidatesPhase1Sql({
        memberScanStartIsNull: false,
      });
      expect(sql).toMatch(/GROUP BY resp_addr, category/);
      expect(sql).toMatch(/HAVING COUNT\(DISTINCT orig_addr\) >= \$5/);
      expect(sql).toMatch(/resp_addr IS NOT NULL/);
    });

    it("R5 phase-1 SQL enforces the ≥2-victims floor via COUNT(DISTINCT resp_addr)", () => {
      const sql = buildReadR5CandidatesPhase1Sql({
        memberScanStartIsNull: false,
      });
      expect(sql).toMatch(/GROUP BY category/);
      expect(sql).toMatch(/COUNT\(DISTINCT orig_addr\) >= \$5/);
      expect(sql).toMatch(/COUNT\(DISTINCT resp_addr\) >= \$6/);
    });

    it("multi-source phase-2 reads select resp_addr via host()", () => {
      const r4 = buildReadR4CandidatesPhase2Sql({
        memberScanStartIsNull: true,
      });
      const r5 = buildReadR5CandidatesPhase2Sql({
        memberScanStartIsNull: true,
      });
      expect(r4).toMatch(/host\(resp_addr\)\s+AS resp_addr/);
      expect(r4).toMatch(/resp_addr = ANY\(\$2::inet\[\]\)/);
      expect(r5).toMatch(/host\(resp_addr\)\s+AS resp_addr/);
      expect(r5).toMatch(/category = ANY\(\$2::text\[\]\)/);
    });
  });

  describe("R6 low-and-slow sweep entries (issue #701)", () => {
    const ctx = {
      periodStartIso: "2026-04-12T00:00:00.000Z",
      periodEndIso: "2026-05-12T00:00:00.000Z",
      observedFromIso: "2026-04-12T00:00:00.000Z",
      addresses: [],
      memberScanStartIso: "2026-05-11T00:00:00.000Z",
      memberScanEndIso: "2026-05-12T00:00:00.000Z",
      r6CandidateAssets: {
        firstTick: ["10.0.0.4"],
        slopReplay: ["10.0.0.5", "10.0.0.6"],
      },
    };

    const lookup = (name: string, context: "first-tick" | "slop-replay") => {
      const q = MEASURED_QUERIES.find(
        (e) => e.name === name && e.context === context,
      );
      if (q === undefined) {
        throw new Error(`missing measured entry: ${name}:${context}`);
      }
      return q;
    };

    it("R6 SQL matches the cadence builders byte-for-byte", () => {
      expect(lookup("readR6CandidatesPhase1", "first-tick").sql).toBe(
        buildReadR6CandidatesPhase1Sql({ memberScanStartIsNull: true }),
      );
      expect(lookup("readR6CandidatesPhase1", "slop-replay").sql).toBe(
        buildReadR6CandidatesPhase1Sql({ memberScanStartIsNull: false }),
      );
      expect(lookup("readR6CandidatesPhase2", "first-tick").sql).toBe(
        buildReadR6CandidatesPhase2Sql({ memberScanStartIsNull: true }),
      );
      expect(lookup("readR6CandidatesPhase2", "slop-replay").sql).toBe(
        buildReadR6CandidatesPhase2Sql({ memberScanStartIsNull: false }),
      );
    });

    it("R6 phase-1 binds the R6 selector set; first-tick omits the lower bound", () => {
      expect(
        lookup("readR6CandidatesPhase1", "first-tick").buildParams(ctx),
      ).toEqual([ctx.memberScanEndIso, Array.from(LOWSLOW_SELECTOR_SET)]);
      expect(
        lookup("readR6CandidatesPhase1", "slop-replay").buildParams(ctx),
      ).toEqual([
        ctx.memberScanStartIso,
        ctx.memberScanEndIso,
        Array.from(LOWSLOW_SELECTOR_SET),
      ]);
    });

    it("R6 phase-2 binds the probed asset list", () => {
      expect(
        lookup("readR6CandidatesPhase2", "first-tick").buildParams(ctx),
      ).toEqual([
        ctx.memberScanEndIso,
        ctx.r6CandidateAssets.firstTick,
        Array.from(LOWSLOW_SELECTOR_SET),
      ]);
      expect(
        lookup("readR6CandidatesPhase2", "slop-replay").buildParams(ctx),
      ).toEqual([
        ctx.memberScanStartIso,
        ctx.memberScanEndIso,
        ctx.r6CandidateAssets.slopReplay,
        Array.from(LOWSLOW_SELECTOR_SET),
      ]);
    });

    it("R6 phase-1 SQL pre-aggregates by orig_addr with both member and UTC-hour dispersion floors", () => {
      const sql = buildReadR6CandidatesPhase1Sql({
        memberScanStartIsNull: false,
      });
      expect(sql).toMatch(/GROUP BY orig_addr/);
      expect(sql).toMatch(/HAVING COUNT\(\*\) >= 3/);
      expect(sql).toMatch(
        /COUNT\(DISTINCT date_trunc\('hour', event_time AT TIME ZONE 'UTC'\)\) >= 3/,
      );
      expect(sql).toMatch(/selector_tags && \$3::text\[\]/);
    });

    it("R6 phase-2 SQL is the single-source per-asset read (no resp_addr)", () => {
      const sql = buildReadR6CandidatesPhase2Sql({
        memberScanStartIsNull: false,
      });
      expect(sql).toMatch(/orig_addr = ANY\(\$3::inet\[\]\)/);
      expect(sql).toMatch(/selector_tags && \$4::text\[\]/);
      expect(sql).not.toMatch(/resp_addr/);
    });

    it("the R6 selector set extends the critical set with S3-recurring", () => {
      expect(Array.from(LOWSLOW_SELECTOR_SET)).toEqual(
        expect.arrayContaining([
          ...Array.from(CRITICAL_SELECTOR_SET),
          "S3-recurring",
        ]),
      );
    });
  });

  describe("R2 multi-stage low-and-slow sweep entries (issue #702)", () => {
    const ctx = {
      periodStartIso: "2026-04-12T00:00:00.000Z",
      periodEndIso: "2026-05-12T00:00:00.000Z",
      observedFromIso: "2026-04-12T00:00:00.000Z",
      addresses: [],
      memberScanStartIso: "2026-05-11T00:00:00.000Z",
      memberScanEndIso: "2026-05-12T00:00:00.000Z",
      r2CandidateAssets: {
        firstTick: ["10.0.0.4"],
        slopReplay: ["10.0.0.5", "10.0.0.6"],
      },
    };

    const lookup = (name: string, context: "first-tick" | "slop-replay") => {
      const q = MEASURED_QUERIES.find(
        (e) => e.name === name && e.context === context,
      );
      if (q === undefined) {
        throw new Error(`missing measured entry: ${name}:${context}`);
      }
      return q;
    };

    it("R2 SQL matches the cadence builders byte-for-byte", () => {
      expect(lookup("readR2CandidatesPhase1", "first-tick").sql).toBe(
        buildReadR2CandidatesPhase1Sql({ memberScanStartIsNull: true }),
      );
      expect(lookup("readR2CandidatesPhase1", "slop-replay").sql).toBe(
        buildReadR2CandidatesPhase1Sql({ memberScanStartIsNull: false }),
      );
      expect(lookup("readR2CandidatesPhase2", "first-tick").sql).toBe(
        buildReadR2CandidatesPhase2Sql({ memberScanStartIsNull: true }),
      );
      expect(lookup("readR2CandidatesPhase2", "slop-replay").sql).toBe(
        buildReadR2CandidatesPhase2Sql({ memberScanStartIsNull: false }),
      );
    });

    it("R2 phase-1 binds only the time bound(s) — no selector/category array", () => {
      expect(
        lookup("readR2CandidatesPhase1", "first-tick").buildParams(ctx),
      ).toEqual([ctx.memberScanEndIso]);
      expect(
        lookup("readR2CandidatesPhase1", "slop-replay").buildParams(ctx),
      ).toEqual([ctx.memberScanStartIso, ctx.memberScanEndIso]);
    });

    it("R2 phase-2 binds the probed asset list", () => {
      expect(
        lookup("readR2CandidatesPhase2", "first-tick").buildParams(ctx),
      ).toEqual([ctx.memberScanEndIso, ctx.r2CandidateAssets.firstTick]);
      expect(
        lookup("readR2CandidatesPhase2", "slop-replay").buildParams(ctx),
      ).toEqual([
        ctx.memberScanStartIso,
        ctx.memberScanEndIso,
        ctx.r2CandidateAssets.slopReplay,
      ]);
    });

    it("R2 phase-1 SQL pre-aggregates by orig_addr with distinct-category AND UTC-hour dispersion floors", () => {
      const sql = buildReadR2CandidatesPhase1Sql({
        memberScanStartIsNull: false,
      });
      expect(sql).toMatch(/GROUP BY orig_addr/);
      expect(sql).toMatch(/COUNT\(DISTINCT category\) >= 3/);
      expect(sql).toMatch(
        /COUNT\(DISTINCT date_trunc\('hour', event_time AT TIME ZONE 'UTC'\)\) >= 3/,
      );
      expect(sql).toMatch(/category IS NOT NULL/);
      // R2 keys on category, not selectors — no selector overlap.
      expect(sql).not.toMatch(/selector_tags/);
    });

    it("R2 phase-2 SQL is the single-source per-asset read filtered on category IS NOT NULL (no resp_addr, no selector overlap)", () => {
      const sql = buildReadR2CandidatesPhase2Sql({
        memberScanStartIsNull: false,
      });
      expect(sql).toMatch(/orig_addr = ANY\(\$3::inet\[\]\)/);
      expect(sql).toMatch(/category IS NOT NULL/);
      expect(sql).not.toMatch(/resp_addr/);
      // `selector_tags` is projected as a column (CandidateEvent needs
      // it), but R2 keys on category — there must be no selector overlap
      // FILTER (`selector_tags && $`).
      expect(sql).not.toMatch(/selector_tags\s*&&/);
    });
  });
});
