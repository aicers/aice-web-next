import { describe, expect, it } from "vitest";

import { buildPivotIndex } from "@/lib/triage/pivot";
import { storyMembersToScoredEvents } from "@/lib/triage/story/pivot-adapter";
import type { TriageStoryMemberDetail } from "@/lib/triage/story/types";

function makeMember(
  overrides: Partial<TriageStoryMemberDetail>,
): TriageStoryMemberDetail {
  return {
    eventKey: "ev-1",
    eventTimeIso: "2026-05-01T12:00:00.000Z",
    kind: "BlocklistTls",
    sensor: "sensor-a",
    origAddr: "10.0.0.1",
    respAddr: "203.0.113.5",
    origPort: 49152,
    respPort: 443,
    host: null,
    dnsQuery: null,
    uri: null,
    category: "EXFILTRATION",
    baselineScore: 0.42,
    protectedByStory: false,
    ...overrides,
  };
}

describe("storyMembersToScoredEvents (#553 adapter)", () => {
  it("maps required ScoredTriageEvent fields from a member row", () => {
    const [adapted] = storyMembersToScoredEvents(
      [makeMember({ eventKey: "abc" })],
      7,
    );
    expect(adapted.id).toBe("abc");
    expect(adapted.__typename).toBe("BlocklistTls");
    expect(adapted.time).toBe("2026-05-01T12:00:00.000Z");
    expect(adapted.customerId).toBe(7);
    expect(adapted.score).toBe(0.42);
    expect(adapted.origAddr).toBe("10.0.0.1");
    expect(adapted.respAddr).toBe("203.0.113.5");
    expect(adapted.respPort).toBe(443);
    expect(adapted.category).toBe("EXFILTRATION");
    // The synthetic rowKey carries the customer prefix so downstream
    // index inspection can still tell tenants apart.
    expect(adapted.rowKey).toBe("7/abc");
  });

  it("renders a null baselineScore as score 0 without dropping the row (#553 AC)", () => {
    const members = [
      makeMember({
        eventKey: "in-period",
        baselineScore: 0.7,
      }),
      makeMember({
        eventKey: "out-of-period",
        baselineScore: null,
      }),
    ];
    const events = storyMembersToScoredEvents(members, 1);
    expect(events).toHaveLength(2);
    const nullRow = events.find((e) => e.id === "out-of-period");
    expect(nullRow?.score).toBe(0);
    // Tier 1 grouping must handle the null row without crashing.
    // Build an index over the adapted set and verify the null-score
    // member still appears in its (dimension, value) bucket.
    const index = buildPivotIndex(events, "baseline");
    const respPortBucket = index.byDimension.get("port");
    expect(
      respPortBucket
        ?.get("443")
        ?.events.map((e) => e.id)
        .sort(),
    ).toEqual(["in-period", "out-of-period"].sort());
    // …and the score-desc sort places the non-null score first;
    // null-scored rows participate but rank at the bottom.
    expect(respPortBucket?.get("443")?.events[0].id).toBe("in-period");
  });

  it("preserves protectedByStory through the adapter so pivot-from-Story keeps the chain-link marker (#596 Round 2 item 2)", () => {
    // Story detail already computes `protectedByStory` per the
    // four-condition rule against the active slider cutoff. The pivot
    // related-events panel renders the marker directly from
    // `event.protectedByStory`, so dropping the flag here would
    // silently un-mark a protected member the moment the analyst
    // pivots from their Story.
    const adapted = storyMembersToScoredEvents(
      [
        makeMember({
          eventKey: "marked",
          baselineScore: 0.3,
          protectedByStory: true,
        }),
        makeMember({
          eventKey: "unmarked",
          baselineScore: 0.97,
          protectedByStory: false,
        }),
        makeMember({
          eventKey: "out-of-period",
          baselineScore: null,
          protectedByStory: false,
        }),
      ],
      1,
    );
    const byId = new Map(adapted.map((e) => [e.id, e]));
    expect(byId.get("marked")?.protectedByStory).toBe(true);
    expect(byId.get("unmarked")?.protectedByStory).toBe(false);
    // Out-of-period members carry baselineScore=null and Story detail
    // sets protectedByStory=false (condition (b) fails). That decision
    // must travel through the adapter — pivot must not re-introduce a
    // marker on a null-scored row.
    expect(byId.get("out-of-period")?.protectedByStory).toBe(false);
  });

  it("narrows unknown ThreatCategory strings to null (defensive)", () => {
    const [adapted] = storyMembersToScoredEvents(
      [
        makeMember({
          category: "SOMETHING_UNRECOGNIZED" as unknown as null,
        }),
      ],
      0,
    );
    expect(adapted.category).toBeNull();
  });
});
