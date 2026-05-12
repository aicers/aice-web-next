import { describe, expect, it, vi } from "vitest";

import { insertCuratedStory } from "@/lib/triage/story/repository";
import type { CandidateEvent } from "@/lib/triage/story/rules";
import { STORY_MEMBER_CAP } from "@/lib/triage/story/rules";

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

interface FakeHandles {
  client: unknown;
  queries: Array<{ sql: string; params: unknown[] | undefined }>;
}

function makeClient(): FakeHandles {
  let nextGroupId = 1;
  const queries: Array<{ sql: string; params: unknown[] | undefined }> = [];
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    queries.push({ sql, params });
    if (sql.includes("INSERT INTO event_group ")) {
      const id = String(nextGroupId);
      nextGroupId += 1;
      return { rows: [{ id }], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO event_group_member")) {
      return { rows: [], rowCount: (params?.length ?? 0) / 3 };
    }
    return { rows: [], rowCount: 0 };
  });
  return { client: { query }, queries };
}

describe("insertCuratedStory", () => {
  it("writes kind = 'analyst_curated' with NULL correlation_rule_id and no ON CONFLICT clause", async () => {
    const h = makeClient();
    await insertCuratedStory(
      // biome-ignore lint/suspicious/noExplicitAny: fake test client
      h.client as any,
      {
        primaryAsset: "10.0.0.5",
        timeWindowStart: new Date("2026-05-09T12:00:00Z"),
        timeWindowEnd: new Date("2026-05-09T12:30:00Z"),
        members: [
          event({
            eventKey: "1",
            eventTime: "2026-05-09T12:00:00Z",
            category: "IMPACT",
          }),
          event({
            eventKey: "2",
            eventTime: "2026-05-09T12:30:00Z",
            category: "EXFILTRATION",
          }),
        ],
      },
    );
    const insertGroup = h.queries.find((q) =>
      q.sql.includes("INSERT INTO event_group "),
    );
    expect(insertGroup).toBeDefined();
    // Curated rows skip the partial unique-index dedup (scoped to
    // kind = 'auto_correlated'), so the INSERT must NOT carry an
    // ON CONFLICT clause that would suppress legitimate repeat
    // saves on the same (asset, window).
    expect(insertGroup?.sql).not.toMatch(/ON CONFLICT/);
    expect(insertGroup?.sql).toContain("'analyst_curated'");
    // correlation_rule_id is a literal NULL in the VALUES clause
    // (curated rows have no rule), not a bound parameter.
    expect(insertGroup?.sql).toMatch(/'analyst_curated',\s*NULL/);
  });

  it("populates the §7 fixed-key summary_payload from members", async () => {
    const h = makeClient();
    await insertCuratedStory(
      // biome-ignore lint/suspicious/noExplicitAny: fake test client
      h.client as any,
      {
        primaryAsset: "10.0.0.5",
        timeWindowStart: new Date("2026-05-09T12:00:00Z"),
        timeWindowEnd: new Date("2026-05-09T12:30:00Z"),
        members: [
          event({
            eventKey: "1",
            eventTime: "2026-05-09T12:00:00Z",
            kind: "HttpThreat",
            category: "IMPACT",
            rawScore: 1.5,
            selectorTags: ["S2-severe"],
          }),
          event({
            eventKey: "2",
            eventTime: "2026-05-09T12:30:00Z",
            kind: "DnsCovertChannel",
            category: "EXFILTRATION",
            rawScore: 2.5,
            selectorTags: [],
          }),
        ],
      },
    );
    const insertGroup = h.queries.find((q) =>
      q.sql.includes("INSERT INTO event_group "),
    );
    // summary_payload is the last positional parameter on the
    // curated INSERT (param $6 — STORY_VERSION, start, end, asset,
    // score, summary).
    const summaryJson = insertGroup?.params?.[5] as string;
    const summary = JSON.parse(summaryJson);
    expect(Object.keys(summary).sort()).toEqual([
      "categoryHistogram",
      "distinctAssetCount",
      "durationMs",
      "kindHistogram",
      "memberCount",
      "topRawScore",
    ]);
    expect(summary.memberCount).toBe(2);
    expect(summary.topRawScore).toBe(2.5);
  });

  it("enforces the §8 member cap (curated saves cannot exceed STORY_MEMBER_CAP)", async () => {
    const h = makeClient();
    const members: CandidateEvent[] = [];
    for (let i = 0; i < STORY_MEMBER_CAP + 10; i += 1) {
      members.push(
        event({
          eventKey: String(1000 + i),
          eventTime: `2026-05-09T12:${String(i % 60).padStart(2, "0")}:00Z`,
        }),
      );
    }
    await insertCuratedStory(
      // biome-ignore lint/suspicious/noExplicitAny: fake test client
      h.client as any,
      {
        primaryAsset: "10.0.0.5",
        timeWindowStart: new Date("2026-05-09T12:00:00Z"),
        timeWindowEnd: new Date("2026-05-09T13:00:00Z"),
        members,
      },
    );
    const insertMembers = h.queries.find((q) =>
      q.sql.includes("INSERT INTO event_group_member"),
    );
    // 3 params per member row.
    expect((insertMembers?.params?.length ?? 0) / 3).toBe(STORY_MEMBER_CAP);
    const insertGroup = h.queries.find((q) =>
      q.sql.includes("INSERT INTO event_group "),
    );
    const summary = JSON.parse(insertGroup?.params?.[5] as string);
    expect(summary.memberCount).toBe(STORY_MEMBER_CAP);
  });

  it("accepts a NULL primary_asset (analyst curated rows are not subject to the partial-index NULL exclusion)", async () => {
    const h = makeClient();
    await expect(
      insertCuratedStory(
        // biome-ignore lint/suspicious/noExplicitAny: fake test client
        h.client as any,
        {
          primaryAsset: null,
          timeWindowStart: new Date("2026-05-09T12:00:00Z"),
          timeWindowEnd: new Date("2026-05-09T12:30:00Z"),
          members: [
            event({
              eventKey: "1",
              eventTime: "2026-05-09T12:00:00Z",
              origAddr: null,
              category: "IMPACT",
            }),
          ],
        },
      ),
    ).resolves.toEqual({ groupId: "1" });
  });
});
