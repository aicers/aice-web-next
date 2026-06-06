import { describe, expect, it } from "vitest";

import {
  applyMemberCap,
  buildSummaryPayload,
  type CandidateEvent,
  CRITICAL_SELECTOR_SET,
  detectAllStories,
  detectR1,
  detectR3,
  detectR4,
  detectR5,
  R1_LAMBDA,
  R4_MIN_SOURCES,
  R5_MIN_SOURCES,
  R5_MIN_VICTIMS,
  STORY_MEMBER_CAP,
} from "@/lib/triage/story/rules";

function event(
  partial: Omit<Partial<CandidateEvent>, "eventTime"> & {
    eventKey: string;
    eventTime: string;
  },
): CandidateEvent {
  const { eventTime, ...rest } = partial;
  return {
    kind: "HttpThreat",
    origAddr: "10.0.0.5",
    respAddr: null,
    category: null,
    selectorTags: [],
    rawScore: 0,
    ...rest,
    eventTime: new Date(eventTime),
  };
}

describe("CRITICAL_SELECTOR_SET", () => {
  it("matches the §3 v1 set verbatim — guards against an RFC 0001 rename", () => {
    expect([...CRITICAL_SELECTOR_SET].sort()).toEqual([
      "S2-severe",
      "unlabeled-cluster",
    ]);
  });
});

describe("detectR1", () => {
  it("fires when same asset has ≥2 distinct critical categories within 10 min", () => {
    const stories = detectR1([
      event({
        eventKey: "1",
        eventTime: "2026-05-09T12:00:00Z",
        category: "INITIAL_ACCESS",
      }),
      event({
        eventKey: "2",
        eventTime: "2026-05-09T12:03:00Z",
        category: "COMMAND_AND_CONTROL",
      }),
      event({
        eventKey: "3",
        eventTime: "2026-05-09T12:06:00Z",
        category: "COMMAND_AND_CONTROL",
      }),
    ]);
    expect(stories).toHaveLength(1);
    const [s] = stories;
    expect(s.ruleId).toBe("R1");
    expect(s.primaryAsset).toBe("10.0.0.5");
    expect(s.members).toHaveLength(3);
    expect(s.timeWindowStart.toISOString()).toBe("2026-05-09T12:00:00.000Z");
    expect(s.timeWindowEnd.toISOString()).toBe("2026-05-09T12:06:00.000Z");
    expect(s.score).toBe(3 + R1_LAMBDA * 2);
  });

  it("does not fire with only one critical category in the window", () => {
    const stories = detectR1([
      event({
        eventKey: "1",
        eventTime: "2026-05-09T12:00:00Z",
        category: "IMPACT",
      }),
      event({
        eventKey: "2",
        eventTime: "2026-05-09T12:05:00Z",
        category: "IMPACT",
      }),
    ]);
    expect(stories).toEqual([]);
  });

  it("skips events with NULL orig_addr (partial unique index requires non-NULL primary_asset)", () => {
    const stories = detectR1([
      event({
        eventKey: "1",
        eventTime: "2026-05-09T12:00:00Z",
        category: "INITIAL_ACCESS",
        origAddr: null,
      }),
      event({
        eventKey: "2",
        eventTime: "2026-05-09T12:03:00Z",
        category: "COMMAND_AND_CONTROL",
        origAddr: null,
      }),
    ]);
    expect(stories).toEqual([]);
  });

  it("ignores non-critical categories", () => {
    // RECONNAISSANCE is NOT in CRITICAL_CATEGORIES, so it doesn't
    // count toward the distinct-category cardinality.
    const stories = detectR1([
      event({
        eventKey: "1",
        eventTime: "2026-05-09T12:00:00Z",
        category: "INITIAL_ACCESS",
      }),
      event({
        eventKey: "2",
        eventTime: "2026-05-09T12:01:00Z",
        category: "RECONNAISSANCE",
      }),
    ]);
    expect(stories).toEqual([]);
  });

  it("does not fire when the second category falls outside the 10-min window", () => {
    const stories = detectR1([
      event({
        eventKey: "1",
        eventTime: "2026-05-09T12:00:00Z",
        category: "INITIAL_ACCESS",
      }),
      event({
        eventKey: "2",
        eventTime: "2026-05-09T12:11:00Z",
        category: "COMMAND_AND_CONTROL",
      }),
    ]);
    expect(stories).toEqual([]);
  });

  it("sliding-window: an R1 window starting inside a prior greedy bucket still fires", () => {
    // Regression for the greedy-partition bug: events at 00:00 A,
    // 00:09 A, 00:11 B contain a valid 10-minute window at
    // [00:09, 00:11] with categories {A, B}. The greedy partition
    // resets at 00:11 (because 00:11 − 00:00 = 11 min > 10 min)
    // and produces buckets [00:00, 00:09] (only A) + [00:11]
    // (only B), missing the valid {A, B} window.
    const stories = detectR1([
      event({
        eventKey: "1",
        eventTime: "2026-05-09T00:00:00Z",
        category: "INITIAL_ACCESS",
      }),
      event({
        eventKey: "2",
        eventTime: "2026-05-09T00:09:00Z",
        category: "INITIAL_ACCESS",
      }),
      event({
        eventKey: "3",
        eventTime: "2026-05-09T00:11:00Z",
        category: "COMMAND_AND_CONTROL",
      }),
    ]);
    expect(stories).toHaveLength(1);
    const [s] = stories;
    expect(s.members.map((m) => m.eventKey)).toEqual(["2", "3"]);
    expect(s.timeWindowStart.toISOString()).toBe("2026-05-09T00:09:00.000Z");
    expect(s.timeWindowEnd.toISOString()).toBe("2026-05-09T00:11:00.000Z");
  });
});

describe("detectR3", () => {
  it("fires when same asset has ≥3 critical-selector events within 1 hour", () => {
    const stories = detectR3([
      event({
        eventKey: "10",
        eventTime: "2026-05-09T14:00:00Z",
        selectorTags: ["S2-severe"],
      }),
      event({
        eventKey: "11",
        eventTime: "2026-05-09T14:25:00Z",
        selectorTags: ["S2-severe"],
      }),
      event({
        eventKey: "12",
        eventTime: "2026-05-09T14:55:00Z",
        selectorTags: ["unlabeled-cluster"],
      }),
    ]);
    expect(stories).toHaveLength(1);
    const [s] = stories;
    expect(s.ruleId).toBe("R3");
    expect(s.score).toBe(3);
    expect(s.timeWindowStart.toISOString()).toBe("2026-05-09T14:00:00.000Z");
    expect(s.timeWindowEnd.toISOString()).toBe("2026-05-09T14:55:00.000Z");
  });

  it("does not fire with only 2 critical-selector events", () => {
    const stories = detectR3([
      event({
        eventKey: "1",
        eventTime: "2026-05-09T14:00:00Z",
        selectorTags: ["S2-severe"],
      }),
      event({
        eventKey: "2",
        eventTime: "2026-05-09T14:05:00Z",
        selectorTags: ["S2-severe"],
      }),
    ]);
    expect(stories).toEqual([]);
  });

  it("ignores events whose selector_tags do not overlap the critical set", () => {
    // S3-recurring is in the §9 emission set but NOT in the v1
    // critical-selector subset — frequency/correlation patterns
    // are excluded from R3.
    const stories = detectR3([
      event({
        eventKey: "1",
        eventTime: "2026-05-09T14:00:00Z",
        selectorTags: ["S3-recurring"],
      }),
      event({
        eventKey: "2",
        eventTime: "2026-05-09T14:05:00Z",
        selectorTags: ["S3-recurring"],
      }),
      event({
        eventKey: "3",
        eventTime: "2026-05-09T14:10:00Z",
        selectorTags: ["S3-recurring"],
      }),
    ]);
    expect(stories).toEqual([]);
  });

  it("skips events with NULL orig_addr", () => {
    const stories = detectR3([
      event({
        eventKey: "1",
        eventTime: "2026-05-09T14:00:00Z",
        selectorTags: ["S2-severe"],
        origAddr: null,
      }),
      event({
        eventKey: "2",
        eventTime: "2026-05-09T14:05:00Z",
        selectorTags: ["S2-severe"],
        origAddr: null,
      }),
      event({
        eventKey: "3",
        eventTime: "2026-05-09T14:10:00Z",
        selectorTags: ["S2-severe"],
        origAddr: null,
      }),
    ]);
    expect(stories).toEqual([]);
  });

  it("sliding-window: a valid 1-hour window starting inside a prior greedy bucket still fires", () => {
    // Regression for the greedy-partition bug: events at 00:00,
    // 00:59, 01:01, 01:02 contain a valid 1-hour window at
    // [00:59, 01:02] with 3 critical-selector hits. A greedy
    // partition resets at 01:01 (because 01:01 − 00:00 = 61 min >
    // 60 min) and produces buckets [00:00, 00:59] (size 2) +
    // [01:01, 01:02] (size 2), missing the valid window.
    const stories = detectR3([
      event({
        eventKey: "1",
        eventTime: "2026-05-09T00:00:00Z",
        selectorTags: ["S2-severe"],
      }),
      event({
        eventKey: "2",
        eventTime: "2026-05-09T00:59:00Z",
        selectorTags: ["S2-severe"],
      }),
      event({
        eventKey: "3",
        eventTime: "2026-05-09T01:01:00Z",
        selectorTags: ["S2-severe"],
      }),
      event({
        eventKey: "4",
        eventTime: "2026-05-09T01:02:00Z",
        selectorTags: ["S2-severe"],
      }),
    ]);
    expect(stories).toHaveLength(1);
    const [s] = stories;
    expect(s.members.map((m) => m.eventKey)).toEqual(["2", "3", "4"]);
    expect(s.timeWindowStart.toISOString()).toBe("2026-05-09T00:59:00.000Z");
    expect(s.timeWindowEnd.toISOString()).toBe("2026-05-09T01:02:00.000Z");
  });
});

// Multi-source helper: defaults differ from `event()` — a fan-in /
// campaign candidate always has a victim, a critical category, and a
// critical selector unless a test overrides them.
function msEvent(
  partial: Omit<Partial<CandidateEvent>, "eventTime"> & {
    eventKey: string;
    eventTime: string;
  },
): CandidateEvent {
  return event({
    respAddr: "10.0.0.100",
    category: "IMPACT",
    selectorTags: ["S2-severe"],
    ...partial,
  });
}

describe("detectR4 — fan-in", () => {
  it("worked example: ≥3 distinct sources onto one victim sharing one critical category + selector within 1h fires", () => {
    const stories = detectR4([
      msEvent({
        eventKey: "1",
        eventTime: "2026-05-09T10:00:00Z",
        origAddr: "10.1.0.1",
      }),
      msEvent({
        eventKey: "2",
        eventTime: "2026-05-09T10:20:00Z",
        origAddr: "10.1.0.2",
      }),
      msEvent({
        eventKey: "3",
        eventTime: "2026-05-09T10:50:00Z",
        origAddr: "10.1.0.3",
      }),
    ]);
    expect(stories).toHaveLength(1);
    const [s] = stories;
    expect(s.ruleId).toBe("R4");
    expect(s.primaryAsset).toBe("10.0.0.100");
    expect(s.correlationKey).toBe("10.0.0.100|IMPACT");
    expect(s.score).toBe(3); // distinct source count
    expect(s.members).toHaveLength(3);
    expect(s.timeWindowStart.toISOString()).toBe("2026-05-09T10:00:00.000Z");
    expect(s.timeWindowEnd.toISOString()).toBe("2026-05-09T10:50:00.000Z");
    expect(s.summary.distinctAssetCount).toBe(3); // source fan-out
  });

  it("does not fire below R4_MIN_SOURCES distinct sources (2 sources, even with many events)", () => {
    expect(R4_MIN_SOURCES).toBe(3);
    const stories = detectR4([
      msEvent({
        eventKey: "1",
        eventTime: "2026-05-09T10:00:00Z",
        origAddr: "10.1.0.1",
      }),
      msEvent({
        eventKey: "2",
        eventTime: "2026-05-09T10:10:00Z",
        origAddr: "10.1.0.1",
      }),
      msEvent({
        eventKey: "3",
        eventTime: "2026-05-09T10:20:00Z",
        origAddr: "10.1.0.2",
      }),
    ]);
    expect(stories).toEqual([]);
  });

  it("does not merge distinct victims into one fan-in", () => {
    const stories = detectR4([
      msEvent({
        eventKey: "1",
        eventTime: "2026-05-09T10:00:00Z",
        origAddr: "10.1.0.1",
        respAddr: "10.0.0.100",
      }),
      msEvent({
        eventKey: "2",
        eventTime: "2026-05-09T10:05:00Z",
        origAddr: "10.1.0.2",
        respAddr: "10.0.0.200",
      }),
      msEvent({
        eventKey: "3",
        eventTime: "2026-05-09T10:10:00Z",
        origAddr: "10.1.0.3",
        respAddr: "10.0.0.100",
      }),
    ]);
    // Each victim has < 3 distinct sources → no fan-in.
    expect(stories).toEqual([]);
  });

  it("separates two categories on the same victim into distinct correlation keys", () => {
    const mk = (key: string, src: string, cat: string, min: number) =>
      msEvent({
        eventKey: key,
        eventTime: `2026-05-09T10:${String(min).padStart(2, "0")}:00Z`,
        origAddr: src,
        category: cat,
      });
    const stories = detectR4([
      mk("a1", "10.1.0.1", "IMPACT", 0),
      mk("a2", "10.1.0.2", "IMPACT", 5),
      mk("a3", "10.1.0.3", "IMPACT", 10),
      mk("b1", "10.2.0.1", "EXFILTRATION", 1),
      mk("b2", "10.2.0.2", "EXFILTRATION", 6),
      mk("b3", "10.2.0.3", "EXFILTRATION", 11),
    ]);
    expect(stories).toHaveLength(2);
    const keys = stories.map((s) => s.correlationKey).sort();
    expect(keys).toEqual(["10.0.0.100|EXFILTRATION", "10.0.0.100|IMPACT"]);
  });

  it("excludes events failing the selector predicate", () => {
    const stories = detectR4([
      msEvent({
        eventKey: "1",
        eventTime: "2026-05-09T10:00:00Z",
        origAddr: "10.1.0.1",
        selectorTags: ["S3-recurring"],
      }),
      msEvent({
        eventKey: "2",
        eventTime: "2026-05-09T10:05:00Z",
        origAddr: "10.1.0.2",
        selectorTags: ["S3-recurring"],
      }),
      msEvent({
        eventKey: "3",
        eventTime: "2026-05-09T10:10:00Z",
        origAddr: "10.1.0.3",
        selectorTags: ["S3-recurring"],
      }),
    ]);
    expect(stories).toEqual([]);
  });

  it("excludes events with NULL resp_addr (victim cannot be attributed)", () => {
    const stories = detectR4([
      msEvent({
        eventKey: "1",
        eventTime: "2026-05-09T10:00:00Z",
        origAddr: "10.1.0.1",
        respAddr: null,
      }),
      msEvent({
        eventKey: "2",
        eventTime: "2026-05-09T10:05:00Z",
        origAddr: "10.1.0.2",
        respAddr: null,
      }),
      msEvent({
        eventKey: "3",
        eventTime: "2026-05-09T10:10:00Z",
        origAddr: "10.1.0.3",
        respAddr: null,
      }),
    ]);
    expect(stories).toEqual([]);
  });

  it("does not fire when the third source falls outside the 1-hour window", () => {
    const stories = detectR4([
      msEvent({
        eventKey: "1",
        eventTime: "2026-05-09T10:00:00Z",
        origAddr: "10.1.0.1",
      }),
      msEvent({
        eventKey: "2",
        eventTime: "2026-05-09T10:30:00Z",
        origAddr: "10.1.0.2",
      }),
      msEvent({
        eventKey: "3",
        eventTime: "2026-05-09T11:01:00Z",
        origAddr: "10.1.0.3",
      }),
    ]);
    expect(stories).toEqual([]);
  });
});

describe("detectR5 — campaign", () => {
  it("worked example: ≥5 distinct sources across ≥2 victims sharing one critical category + selector within 1h fires", () => {
    const stories = detectR5([
      msEvent({
        eventKey: "1",
        eventTime: "2026-05-09T10:00:00Z",
        origAddr: "10.1.0.1",
        respAddr: "10.0.0.100",
      }),
      msEvent({
        eventKey: "2",
        eventTime: "2026-05-09T10:10:00Z",
        origAddr: "10.1.0.2",
        respAddr: "10.0.0.100",
      }),
      msEvent({
        eventKey: "3",
        eventTime: "2026-05-09T10:20:00Z",
        origAddr: "10.1.0.3",
        respAddr: "10.0.0.200",
      }),
      msEvent({
        eventKey: "4",
        eventTime: "2026-05-09T10:30:00Z",
        origAddr: "10.1.0.4",
        respAddr: "10.0.0.200",
      }),
      msEvent({
        eventKey: "5",
        eventTime: "2026-05-09T10:40:00Z",
        origAddr: "10.1.0.5",
        respAddr: "10.0.0.300",
      }),
    ]);
    expect(stories).toHaveLength(1);
    const [s] = stories;
    expect(s.ruleId).toBe("R5");
    expect(s.primaryAsset).toBeNull();
    expect(s.correlationKey).toBe("IMPACT");
    expect(s.score).toBe(5); // distinct source count
    expect(s.summary.distinctAssetCount).toBe(5);
  });

  it("does not fire below R5_MIN_SOURCES distinct sources", () => {
    expect(R5_MIN_SOURCES).toBe(5);
    const stories = detectR5([
      msEvent({
        eventKey: "1",
        eventTime: "2026-05-09T10:00:00Z",
        origAddr: "10.1.0.1",
        respAddr: "10.0.0.100",
      }),
      msEvent({
        eventKey: "2",
        eventTime: "2026-05-09T10:10:00Z",
        origAddr: "10.1.0.2",
        respAddr: "10.0.0.100",
      }),
      msEvent({
        eventKey: "3",
        eventTime: "2026-05-09T10:20:00Z",
        origAddr: "10.1.0.3",
        respAddr: "10.0.0.200",
      }),
      msEvent({
        eventKey: "4",
        eventTime: "2026-05-09T10:30:00Z",
        origAddr: "10.1.0.4",
        respAddr: "10.0.0.200",
      }),
    ]);
    expect(stories).toEqual([]);
  });

  it("does not fire when ≥5 sources converge on a SINGLE victim (that is an R4 fan-in, not a campaign)", () => {
    expect(R5_MIN_VICTIMS).toBe(2);
    const events: CandidateEvent[] = [];
    for (let i = 0; i < 6; i += 1) {
      events.push(
        msEvent({
          eventKey: String(i),
          eventTime: `2026-05-09T10:${String(i * 5).padStart(2, "0")}:00Z`,
          origAddr: `10.1.0.${i + 1}`,
          respAddr: "10.0.0.100", // single victim
        }),
      );
    }
    expect(detectR5(events)).toEqual([]);
  });

  it("excludes events with NULL resp_addr from victim accounting", () => {
    const events: CandidateEvent[] = [];
    // 5 sources, but all null-victim → no victims to count.
    for (let i = 0; i < 5; i += 1) {
      events.push(
        msEvent({
          eventKey: String(i),
          eventTime: `2026-05-09T10:${String(i * 5).padStart(2, "0")}:00Z`,
          origAddr: `10.1.0.${i + 1}`,
          respAddr: null,
        }),
      );
    }
    expect(detectR5(events)).toEqual([]);
  });
});

describe("applyMemberCap", () => {
  it("returns the input unchanged when ≤ cap", () => {
    const events = [
      event({ eventKey: "1", eventTime: "2026-05-09T12:00:00Z" }),
      event({ eventKey: "2", eventTime: "2026-05-09T12:01:00Z" }),
    ];
    expect(applyMemberCap(events, 5)).toEqual(events);
  });

  it("orders by cardinality(selector_tags) DESC then event_time DESC then event_key ASC", () => {
    const events = [
      // Two tags, late time
      event({
        eventKey: "A",
        eventTime: "2026-05-09T12:05:00Z",
        selectorTags: ["S2-severe", "unlabeled-cluster"],
      }),
      // One tag, latest time
      event({
        eventKey: "B",
        eventTime: "2026-05-09T12:10:00Z",
        selectorTags: ["S2-severe"],
      }),
      // One tag, earliest time
      event({
        eventKey: "C",
        eventTime: "2026-05-09T12:00:00Z",
        selectorTags: ["S2-severe"],
      }),
      // Zero tags
      event({ eventKey: "D", eventTime: "2026-05-09T12:30:00Z" }),
    ];
    expect(applyMemberCap(events, 3).map((e) => e.eventKey)).toEqual([
      "A", // cardinality 2 wins
      "B", // tied at 1; later time wins
      "C", // tied at 1; earlier — last
    ]);
  });

  it("R3 with 60 candidates produces exactly 50 admitted members, with score reflecting the cap", () => {
    const events: CandidateEvent[] = [];
    for (let i = 0; i < 60; i += 1) {
      const minutes = i; // 0..59 minutes apart, all within 1 hour
      events.push(
        event({
          eventKey: String(1000 + i),
          eventTime: `2026-05-09T14:${String(minutes).padStart(2, "0")}:00Z`,
          selectorTags: ["S2-severe"],
        }),
      );
    }
    const stories = detectR3(events);
    expect(stories).toHaveLength(1);
    const [s] = stories;
    expect(s.members).toHaveLength(STORY_MEMBER_CAP);
    expect(s.score).toBe(STORY_MEMBER_CAP);
  });
});

describe("buildSummaryPayload", () => {
  it("emits every fixed key from §7", () => {
    const members = [
      event({
        eventKey: "1",
        eventTime: "2026-05-09T12:00:00Z",
        kind: "HttpThreat",
        category: "IMPACT",
        rawScore: 2.5,
        selectorTags: ["S2-severe"],
      }),
      event({
        eventKey: "2",
        eventTime: "2026-05-09T12:05:00Z",
        kind: "DnsCovertChannel",
        category: "EXFILTRATION",
        rawScore: 3.0,
        selectorTags: [],
      }),
    ];
    const payload = buildSummaryPayload(members);
    expect(Object.keys(payload).sort()).toEqual([
      "categoryHistogram",
      "distinctAssetCount",
      "durationMs",
      "kindHistogram",
      "memberCount",
      "topRawScore",
    ]);
    expect(payload.kindHistogram).toEqual({
      HttpThreat: 1,
      DnsCovertChannel: 1,
    });
    expect(payload.categoryHistogram).toEqual({ IMPACT: 1, EXFILTRATION: 1 });
    expect(payload.memberCount).toBe(2);
    expect(payload.durationMs).toBe(5 * 60 * 1000);
    expect(payload.distinctAssetCount).toBe(1);
    expect(payload.topRawScore).toBe(3.0);
  });

  it("does not bucket NULL categories", () => {
    const payload = buildSummaryPayload([
      event({
        eventKey: "1",
        eventTime: "2026-05-09T12:00:00Z",
        category: null,
      }),
    ]);
    expect(payload.categoryHistogram).toEqual({});
  });
});

describe("detectAllStories — same-event multiple rules (option A)", () => {
  it("a fixture matching both R1 and R3 produces exactly two stories (one per rule)", () => {
    const events: CandidateEvent[] = [
      event({
        eventKey: "20",
        eventTime: "2026-05-09T09:00:00Z",
        category: "CREDENTIAL_ACCESS",
        selectorTags: ["S2-severe"],
      }),
      event({
        eventKey: "21",
        eventTime: "2026-05-09T09:02:00Z",
        category: "COMMAND_AND_CONTROL",
        selectorTags: ["S2-severe"],
      }),
      event({
        eventKey: "22",
        eventTime: "2026-05-09T09:09:00Z",
        category: "EXFILTRATION",
        selectorTags: ["S2-severe"],
      }),
    ];
    const stories = detectAllStories(events);
    const rules = stories.map((s) => s.ruleId).sort();
    expect(rules).toEqual(["R1", "R3"]);
  });
});
