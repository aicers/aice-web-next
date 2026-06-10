import { describe, expect, it } from "vitest";

import {
  assertRepresentativeProfile,
  formatProfileAssertionFailure,
  PROFILE_PROBE_SQL,
  PROFILE_SLOP_REPLAY_PHASE1_SQL,
  PROFILE_THRESHOLDS,
  ProfileAssertionError,
} from "../../../scripts/measure-baseline-read-path/profile.mjs";

interface StubResult {
  rows: ReadonlyArray<Record<string, unknown>>;
}

/**
 * Stub `pg.Pool`-shaped object. Each probe SQL string is mapped to a
 * canned result so the assertion runs against a deterministic fixture
 * without touching a real DB.
 */
function makePool(responses: Map<string, StubResult>): {
  query: (sql: string) => Promise<StubResult>;
} {
  return {
    async query(sql: string) {
      const r = responses.get(sql);
      if (!r) throw new Error(`unexpected SQL: ${sql.slice(0, 60)}…`);
      return r;
    },
  };
}

const NOW_MS = new Date("2026-05-12T12:00:00.000Z").getTime();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const MEMBER_SCAN = {
  startIso: new Date(NOW_MS - 2 * HOUR).toISOString(),
  endIso: new Date(NOW_MS - 30 * 60 * 1000).toISOString(),
} as const;

function passingResponses(): Map<string, StubResult> {
  return new Map([
    [PROFILE_PROBE_SQL.baselineRowCount, { rows: [{ count: "250000" }] }],
    [PROFILE_PROBE_SQL.observedRowCount, { rows: [{ count: "1200000" }] }],
    [PROFILE_PROBE_SQL.distinctPartitions, { rows: [{ count: "6" }] }],
    [PROFILE_PROBE_SQL.distinctOrigAddr, { rows: [{ count: "750" }] }],
    [
      PROFILE_PROBE_SQL.baselineEventTimeSpan,
      {
        rows: [
          {
            lo: new Date(NOW_MS - 31 * DAY).toISOString(),
            hi: new Date(NOW_MS - HOUR).toISOString(),
          },
        ],
      },
    ],
    [
      PROFILE_PROBE_SQL.observedEventTimeSpan,
      {
        rows: [
          {
            lo: new Date(NOW_MS - 31 * DAY).toISOString(),
            hi: new Date(NOW_MS - HOUR).toISOString(),
          },
        ],
      },
    ],
    [
      PROFILE_PROBE_SQL.corpusState,
      {
        rows: [
          {
            last_ingested_at: new Date(NOW_MS - 30 * 60 * 1000).toISOString(),
            last_run_status: "ok",
          },
        ],
      },
    ],
    [
      PROFILE_PROBE_SQL.storyFinalizedThrough,
      {
        rows: [
          {
            story_finalized_through: new Date(
              NOW_MS - 30 * 60 * 1000,
            ).toISOString(),
          },
        ],
      },
    ],
    // R3 phase-1 over the slop-replay range — return 8 candidate
    // assets so the default `minSlopReplayPhase1Candidates >= 5`
    // threshold passes.
    [
      PROFILE_SLOP_REPLAY_PHASE1_SQL,
      {
        rows: [
          { orig_addr: "10.0.0.1" },
          { orig_addr: "10.0.0.2" },
          { orig_addr: "10.0.0.3" },
          { orig_addr: "10.0.0.4" },
          { orig_addr: "10.0.0.5" },
          { orig_addr: "10.0.0.6" },
          { orig_addr: "10.0.0.7" },
          { orig_addr: "10.0.0.8" },
        ],
      },
    ],
  ]);
}

describe("assertRepresentativeProfile", () => {
  it("accepts a representative tenant", async () => {
    const pool = makePool(passingResponses());
    const results = await assertRepresentativeProfile(pool, { nowMs: NOW_MS });
    expect(results.baselineRowCount).toBe(250_000);
    expect(results.observedRowCount).toBe(1_200_000);
    expect(results.distinctPartitions).toBe(6);
    expect(results.distinctOrigAddr).toBe(750);
    expect(results.corpusState?.lastRunStatus).toBe("ok");
  });

  it("rejects a tenant whose baseline_triaged_event is under the row floor", async () => {
    const responses = passingResponses();
    responses.set(PROFILE_PROBE_SQL.baselineRowCount, {
      rows: [{ count: "1000" }],
    });
    const pool = makePool(responses);
    await expect(
      assertRepresentativeProfile(pool, { nowMs: NOW_MS }),
    ).rejects.toBeInstanceOf(ProfileAssertionError);
  });

  it("rejects a tenant with a degenerate single-partition cohort", async () => {
    const responses = passingResponses();
    responses.set(PROFILE_PROBE_SQL.distinctPartitions, {
      rows: [{ count: "1" }],
    });
    const pool = makePool(responses);
    await expect(
      assertRepresentativeProfile(pool, { nowMs: NOW_MS }),
    ).rejects.toBeInstanceOf(ProfileAssertionError);
  });

  it("rejects a tenant with too few distinct orig_addr values", async () => {
    const responses = passingResponses();
    responses.set(PROFILE_PROBE_SQL.distinctOrigAddr, {
      rows: [{ count: "10" }],
    });
    const pool = makePool(responses);
    await expect(
      assertRepresentativeProfile(pool, { nowMs: NOW_MS }),
    ).rejects.toBeInstanceOf(ProfileAssertionError);
  });

  it("rejects a tenant whose baseline event_time history is < 30 days", async () => {
    const responses = passingResponses();
    responses.set(PROFILE_PROBE_SQL.baselineEventTimeSpan, {
      rows: [
        {
          lo: new Date(NOW_MS - 5 * DAY).toISOString(),
          hi: new Date(NOW_MS - HOUR).toISOString(),
        },
      ],
    });
    const pool = makePool(responses);
    await expect(
      assertRepresentativeProfile(pool, { nowMs: NOW_MS }),
    ).rejects.toBeInstanceOf(ProfileAssertionError);
  });

  it("rejects a tenant whose baseline event_time high-water mark is stale (30+ day span, but newest row is months old)", async () => {
    // Regression guard for the Round 2 review item: the original
    // `coverageMs = min(now, hi) - lo` formulation accepted this
    // shape because `hi - lo >= 30 days`, even though `hi` was 90
    // days in the past and the recent window the harness probes
    // would be empty.
    const responses = passingResponses();
    responses.set(PROFILE_PROBE_SQL.baselineEventTimeSpan, {
      rows: [
        {
          lo: new Date(NOW_MS - 180 * DAY).toISOString(),
          hi: new Date(NOW_MS - 90 * DAY).toISOString(),
        },
      ],
    });
    const pool = makePool(responses);
    try {
      await assertRepresentativeProfile(pool, { nowMs: NOW_MS });
      throw new Error("assertion should have thrown");
    } catch (err) {
      if (!(err instanceof ProfileAssertionError)) throw err;
      expect(err.failures.map((f) => f.check)).toContain(
        "baselineEventTimeFreshness",
      );
    }
  });

  it("rejects a tenant whose observed event_time high-water mark is stale", async () => {
    const responses = passingResponses();
    responses.set(PROFILE_PROBE_SQL.observedEventTimeSpan, {
      rows: [
        {
          lo: new Date(NOW_MS - 60 * DAY).toISOString(),
          hi: new Date(NOW_MS - 1 * DAY).toISOString(),
        },
      ],
    });
    const pool = makePool(responses);
    try {
      await assertRepresentativeProfile(pool, { nowMs: NOW_MS });
      throw new Error("assertion should have thrown");
    } catch (err) {
      if (!(err instanceof ProfileAssertionError)) throw err;
      expect(err.failures.map((f) => f.check)).toContain(
        "observedEventTimeFreshness",
      );
    }
  });

  it("rejects a tenant whose corpus is entirely empty (no min/max)", async () => {
    const responses = passingResponses();
    responses.set(PROFILE_PROBE_SQL.baselineEventTimeSpan, {
      rows: [{ lo: null, hi: null }],
    });
    const pool = makePool(responses);
    await expect(
      assertRepresentativeProfile(pool, { nowMs: NOW_MS }),
    ).rejects.toBeInstanceOf(ProfileAssertionError);
  });

  it("rejects a tenant whose corpus state is not 'ok'", async () => {
    const responses = passingResponses();
    responses.set(PROFILE_PROBE_SQL.corpusState, {
      rows: [
        {
          last_ingested_at: new Date(NOW_MS - 30 * 60 * 1000).toISOString(),
          last_run_status: "failed",
        },
      ],
    });
    const pool = makePool(responses);
    await expect(
      assertRepresentativeProfile(pool, { nowMs: NOW_MS }),
    ).rejects.toBeInstanceOf(ProfileAssertionError);
  });

  it("rejects a tenant whose corpus ingest is older than 2 hours", async () => {
    const responses = passingResponses();
    responses.set(PROFILE_PROBE_SQL.corpusState, {
      rows: [
        {
          last_ingested_at: new Date(NOW_MS - 3 * HOUR).toISOString(),
          last_run_status: "ok",
        },
      ],
    });
    const pool = makePool(responses);
    await expect(
      assertRepresentativeProfile(pool, { nowMs: NOW_MS }),
    ).rejects.toBeInstanceOf(ProfileAssertionError);
  });

  it("rejects a tenant whose baseline_corpus_state row is absent", async () => {
    const responses = passingResponses();
    responses.set(PROFILE_PROBE_SQL.corpusState, { rows: [] });
    const pool = makePool(responses);
    await expect(
      assertRepresentativeProfile(pool, { nowMs: NOW_MS }),
    ).rejects.toBeInstanceOf(ProfileAssertionError);
  });

  it("collects every failing check, not just the first", async () => {
    const responses = passingResponses();
    responses.set(PROFILE_PROBE_SQL.baselineRowCount, {
      rows: [{ count: "1000" }],
    });
    responses.set(PROFILE_PROBE_SQL.observedRowCount, {
      rows: [{ count: "1000" }],
    });
    responses.set(PROFILE_PROBE_SQL.distinctPartitions, {
      rows: [{ count: "1" }],
    });
    const pool = makePool(responses);
    try {
      await assertRepresentativeProfile(pool, { nowMs: NOW_MS });
      throw new Error("assertion should have thrown");
    } catch (err) {
      if (!(err instanceof ProfileAssertionError)) throw err;
      expect(err.failures.length).toBeGreaterThanOrEqual(3);
      const checkNames = err.failures.map((f) => f.check);
      expect(checkNames).toContain("baselineRowCount");
      expect(checkNames).toContain("observedRowCount");
      expect(checkNames).toContain("distinctPartitions");
    }
  });
});

describe("formatProfileAssertionFailure", () => {
  it("renders failures as a copy-pasteable bullet list", () => {
    const err = new ProfileAssertionError([
      { check: "baselineRowCount", detail: "too few rows" },
      { check: "corpusStateFreshness", detail: "stale ingest" },
    ]);
    const text = formatProfileAssertionFailure(err);
    expect(text).toMatch(
      /FAIL — representative profile not met \(2 check\(s\)\)/,
    );
    expect(text).toMatch(/• baselineRowCount: too few rows/);
    expect(text).toMatch(/• corpusStateFreshness: stale ingest/);
    expect(text).toMatch(/--skip-profile-assert/);
  });
});

describe("PROFILE_THRESHOLDS", () => {
  it("matches the values documented in the harness header", () => {
    expect(PROFILE_THRESHOLDS.baselineTriagedEventMinRows).toBe(200_000);
    expect(PROFILE_THRESHOLDS.observedEventMetaMinRows).toBe(1_000_000);
    expect(PROFILE_THRESHOLDS.minDistinctKindVersionPartitions).toBe(4);
    expect(PROFILE_THRESHOLDS.minDistinctOrigAddr).toBe(500);
    expect(PROFILE_THRESHOLDS.maxCorpusStalenessMs).toBe(2 * HOUR);
    // Issue #601 — starting threshold for the slop-replay phase-1
    // candidate count. Raisable based on what the gate measurement
    // (#603) reports.
    expect(PROFILE_THRESHOLDS.minSlopReplayPhase1Candidates).toBe(5);
  });
});

describe("assertRepresentativeProfile — Story-shape checks (issue #601)", () => {
  it("accepts the structured second argument with `nowMs` + `memberScan` and runs the slop-replay phase-1 count check", async () => {
    const pool = makePool(passingResponses());
    const results = await assertRepresentativeProfile(pool, {
      nowMs: NOW_MS,
      memberScan: MEMBER_SCAN,
    });
    expect(results.slopReplayPhase1Count).toBe(8);
    expect(results.storyFinalizedThrough).not.toBeNull();
  });

  it("rejects a tenant whose `story_finalized_through` is NULL — the slop-replay path is not exercised", async () => {
    const responses = passingResponses();
    responses.set(PROFILE_PROBE_SQL.storyFinalizedThrough, {
      rows: [{ story_finalized_through: null }],
    });
    const pool = makePool(responses);
    try {
      await assertRepresentativeProfile(pool, {
        nowMs: NOW_MS,
        memberScan: MEMBER_SCAN,
      });
      throw new Error("assertion should have thrown");
    } catch (err) {
      if (!(err instanceof ProfileAssertionError)) throw err;
      expect(err.failures.map((f) => f.check)).toContain(
        "storyFinalizedThrough",
      );
    }
  });

  it("rejects a tenant whose R3 phase-1 returns < threshold over the slop-replay scan range", async () => {
    const responses = passingResponses();
    responses.set(PROFILE_SLOP_REPLAY_PHASE1_SQL, {
      rows: [{ orig_addr: "10.0.0.1" }, { orig_addr: "10.0.0.2" }],
    });
    const pool = makePool(responses);
    try {
      await assertRepresentativeProfile(pool, {
        nowMs: NOW_MS,
        memberScan: MEMBER_SCAN,
      });
      throw new Error("assertion should have thrown");
    } catch (err) {
      if (!(err instanceof ProfileAssertionError)) throw err;
      expect(err.failures.map((f) => f.check)).toContain(
        "slopReplayPhase1Count",
      );
    }
  });

  it("does NOT run the phase-1 count probe when `memberScan` is absent", async () => {
    const responses = passingResponses();
    // Removing the phase-1 SQL response would throw on lookup if the
    // assertion still tried to run it — a memberScan-less call must
    // skip the probe entirely.
    responses.delete(PROFILE_SLOP_REPLAY_PHASE1_SQL);
    const pool = makePool(responses);
    await expect(
      assertRepresentativeProfile(pool, { nowMs: NOW_MS }),
    ).resolves.toBeDefined();
  });

  it("still enforces the storyFinalizedThrough precondition without a memberScan range (issue #601: cadence-side gate requirement)", async () => {
    const responses = passingResponses();
    responses.delete(PROFILE_SLOP_REPLAY_PHASE1_SQL);
    responses.set(PROFILE_PROBE_SQL.storyFinalizedThrough, {
      rows: [{ story_finalized_through: null }],
    });
    const pool = makePool(responses);
    await expect(
      assertRepresentativeProfile(pool, { nowMs: NOW_MS }),
    ).rejects.toBeInstanceOf(ProfileAssertionError);
  });
});
