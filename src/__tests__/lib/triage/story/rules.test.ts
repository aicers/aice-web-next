import { describe, expect, it } from "vitest";

import {
  applyMemberCap,
  buildSummaryPayload,
  type CandidateEvent,
  CRITICAL_SELECTOR_SET,
  detectAllStories,
  detectR1,
  detectR3,
  R1_LAMBDA,
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
