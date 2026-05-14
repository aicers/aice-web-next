import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  TriageStoriesView,
  type TriageStoriesViewLabels,
} from "@/components/triage/story/stories-view";
import type { TriagePeriod } from "@/lib/triage";
import type {
  TriageStory,
  TriageStoryMemberDetail,
} from "@/lib/triage/story/types";

const LABELS: TriageStoriesViewLabels = {
  heading: "Stories",
  empty: "No stories in this period",
  truncatedTemplate: "Truncated",
  emptyUnsentOnly: "No unsent stories",
  showOnlyUnsentLabel: "Show only unsent",
  sortLabel: "Sort",
  sortByTimeWindowEnd: "Recent first",
  sortByScore: "Score",
  staleHashFallback: "Stale Story link — open from the list",
  card: {
    ruleBadgeAuto: "auto",
    ruleBadgeAnalyst: "analyst-curated",
    scoreLabel: "Score",
    memberCountTemplate: "{count} events",
    open: "Open",
    sendToAimerWeb: "Send to aimer-web",
    sendToAimerWebTooltip: "LLM analysis not yet available",
    sentIndicatorTemplate: "Sent {relative}",
    sentMultiTemplate: "{count}×",
    timeColumn: "Time",
    kindColumn: "Kind",
    categoryColumn: "Category",
    topMembersHeading: "Top members",
    relative: {
      justNow: "just now",
      secondsTemplate: "{n}s ago",
      minutesTemplate: "{n} min ago",
      hoursTemplate: "{n} h ago",
      daysTemplate: "{n} d ago",
    },
    duration: {
      lessThanMinute: "< 1 min",
      minutesTemplate: "{n} min",
      hoursTemplate: "{n} h",
      hoursMinutesTemplate: "{h} h {m} min",
    },
  },
  detail: {
    heading: "Story detail",
    emptySelection: "Pick a story",
    emptyMembers: "No members visible",
    customerLabel: "Customer",
    scoreLabel: "Score",
    ruleLabel: "Rule",
    danglingNoticeTemplate:
      "{shown} of {stored} events shown — {aged} aged past corpus A retention",
    timeColumn: "Time",
    kindColumn: "Kind",
    categoryColumn: "Category",
    scoreColumn: "Score",
    loading: "Loading members…",
    close: "Close",
  },
};

function makeStory(overrides: Partial<TriageStory> = {}): TriageStory {
  return {
    customerId: 7,
    customerName: "Acme",
    storyId: "1",
    kind: "auto_correlated",
    ruleId: "R1",
    storyVersion: "v1",
    timeWindowStartIso: "2026-05-09T12:00:00.000Z",
    timeWindowEndIso: "2026-05-09T12:30:00.000Z",
    primaryAsset: "10.0.0.5",
    score: 4.25,
    summary: {
      kindHistogram: { HttpThreat: 2 },
      categoryHistogram: { IMPACT: 2, EXFILTRATION: 1 },
      memberCount: 3,
      durationMs: 30 * 60 * 1000,
      distinctAssetCount: 1,
      topRawScore: 4.5,
    },
    createdAtIso: "2026-05-09T12:31:00.000Z",
    lastSentAtIso: null,
    sendCount: 0,
    topMembers: [
      {
        eventKey: "1",
        eventTimeIso: "2026-05-09T12:10:00.000Z",
        kind: "HttpThreat",
        category: "IMPACT",
        rawScore: 4.5,
      },
    ],
    ...overrides,
  };
}

describe("TriageStoriesView — empty / list / sort / unsent-only filter", () => {
  it("renders the empty-period copy when the list is empty", () => {
    render(
      <TriageStoriesView
        stories={[]}
        truncated={false}
        focused={null}
        onFocus={() => {}}
        labels={LABELS}
      />,
    );
    expect(screen.getByText(LABELS.empty)).toBeTruthy();
  });

  it("renders one card per story keyed on (customerId/storyId)", () => {
    const a = makeStory({ customerId: 7, storyId: "1" });
    const b = makeStory({
      customerId: 8,
      storyId: "1",
      customerName: "Beta",
      score: 3,
    });
    render(
      <TriageStoriesView
        stories={[a, b]}
        truncated={false}
        focused={null}
        onFocus={() => {}}
        labels={LABELS}
      />,
    );
    const cards = screen.getAllByTestId("triage-story-card");
    expect(cards).toHaveLength(2);
    // Same storyId in different tenants must produce two distinct
    // entries — composite identity is the key.
    expect(cards[0].getAttribute("data-story-id")).toBe("7/1");
    expect(cards[1].getAttribute("data-story-id")).toBe("8/1");
  });

  it("filters by unsent when 'Show only unsent' is enabled", () => {
    const sent = makeStory({
      storyId: "1",
      lastSentAtIso: "2026-05-09T12:35:00.000Z",
      sendCount: 1,
    });
    const unsent = makeStory({
      storyId: "2",
      lastSentAtIso: null,
      sendCount: 0,
    });
    render(
      <TriageStoriesView
        stories={[sent, unsent]}
        truncated={false}
        focused={null}
        onFocus={() => {}}
        labels={LABELS}
      />,
    );
    fireEvent.click(screen.getByTestId("triage-stories-unsent-only"));
    const cards = screen.getAllByTestId("triage-story-card");
    expect(cards).toHaveLength(1);
    expect(cards[0].getAttribute("data-story-id")).toBe("7/2");
  });

  it("Open button forwards the clicked story to onFocus", () => {
    const onFocus = vi.fn();
    const story = makeStory();
    render(
      <TriageStoriesView
        stories={[story]}
        truncated={false}
        focused={null}
        onFocus={onFocus}
        labels={LABELS}
      />,
    );
    fireEvent.click(screen.getByTestId("triage-story-open"));
    expect(onFocus).toHaveBeenCalledTimes(1);
    expect(onFocus.mock.calls[0][0]).toEqual(story);
  });

  it("surfaces the stale-hash toast when the URL carried a bare storyId", () => {
    render(
      <TriageStoriesView
        stories={[]}
        truncated={false}
        focused={null}
        onFocus={() => {}}
        showStaleHashWarning={true}
        labels={LABELS}
      />,
    );
    expect(screen.getByTestId("triage-stories-stale-hash")).toBeTruthy();
  });
});

/**
 * #490 acceptance: the Send-to-aimer-web button is the inert shape
 * #490 ships — `disabled=true`, `aria-disabled="true"`, the documented
 * tooltip, and the stable `data-action="send-to-aimer-web"` hook
 * regardless of environment. The disabled-state flip is owned by #493.
 */
describe("Send-to-aimer-web button — inert shape (#490 ships, #493 wires)", () => {
  it("renders disabled with the stable data-action hook and tooltip", () => {
    render(
      <TriageStoriesView
        stories={[makeStory()]}
        truncated={false}
        focused={null}
        onFocus={() => {}}
        labels={LABELS}
      />,
    );
    const btn = screen.getByTestId("triage-story-send");
    expect(btn.hasAttribute("disabled")).toBe(true);
    expect(btn.getAttribute("aria-disabled")).toBe("true");
    expect(btn.getAttribute("data-action")).toBe("send-to-aimer-web");
    expect(btn.getAttribute("title")).toBe(LABELS.card.sendToAimerWebTooltip);
  });
});

/**
 * #490 acceptance: "a fixture where `summary_payload.memberCount = 12`
 * but the join produces only `11` rows ... renders the detail panel
 * with the 11 visible members plus the one-line '11 of 12 events shown
 * — 1 aged past corpus A retention' notice. A fixture with no aged-out
 * members renders no notice."
 */
describe("Story detail — dangling-member notice", () => {
  it("renders the notice only after the loader returns hasDanglingMembers=true with the authoritative join count", async () => {
    const story = makeStory({
      summary: {
        kindHistogram: {},
        categoryHistogram: {},
        memberCount: 12,
        durationMs: 0,
        distinctAssetCount: 0,
        topRawScore: 0,
      },
      topMembers: [
        {
          eventKey: "1",
          eventTimeIso: "2026-05-09T12:10:00.000Z",
          kind: "HttpThreat",
          category: "IMPACT",
          rawScore: 4.5,
        },
      ],
    });
    // The full join produced 11 rows (1 aged out of corpus A) — the
    // notice renders the authoritative "11 of 12 — 1 aged" copy, NOT
    // the misleading "1 of 12 — 11 aged" derived from the top-3
    // preview before the join lands.
    const fullMembers: TriageStoryMemberDetail[] = Array.from(
      { length: 11 },
      (_, i) => ({
        eventKey: String(i + 1),
        eventTimeIso: "2026-05-09T12:10:00.000Z",
        kind: "HttpThreat",
        sensor: "sensor-a",
        origAddr: "10.0.0.5",
        respAddr: "8.8.8.8",
        origPort: 12345,
        respPort: 443,
        host: null,
        dnsQuery: null,
        uri: null,
        category: "IMPACT",
        baselineScore: 0.92,
      }),
    );
    const loadDetail = vi.fn(async () => ({
      members: fullMembers,
      hasDanglingMembers: true,
      storedMemberCount: 12,
    }));
    const period: TriagePeriod = {
      startIso: "2026-05-08T00:00:00.000Z",
      endIso: "2026-05-09T00:00:00.000Z",
    };
    await act(async () => {
      render(
        <TriageStoriesView
          stories={[story]}
          truncated={false}
          focused={story}
          onFocus={() => {}}
          period={period}
          loadDetail={loadDetail}
          labels={LABELS}
        />,
      );
    });
    await waitFor(() => {
      const notice = screen.getByTestId("triage-story-dangling-notice");
      expect(notice.textContent).toBe(
        "11 of 12 events shown — 1 aged past corpus A retention",
      );
    });
  });

  it("does NOT render the notice while the loader is in flight (preview omissions are not retention loss)", async () => {
    const story = makeStory({
      summary: {
        kindHistogram: {},
        categoryHistogram: {},
        memberCount: 12,
        durationMs: 0,
        distinctAssetCount: 0,
        topRawScore: 0,
      },
      topMembers: [
        {
          eventKey: "1",
          eventTimeIso: "2026-05-09T12:10:00.000Z",
          kind: "HttpThreat",
          category: "IMPACT",
          rawScore: 4.5,
        },
      ],
    });
    // A loader that never resolves keeps the panel in `loading`.
    const loadDetail = vi.fn(
      () =>
        new Promise<{
          members: TriageStoryMemberDetail[];
          hasDanglingMembers: boolean;
          storedMemberCount: number;
        }>(() => {}),
    );
    const period: TriagePeriod = {
      startIso: "2026-05-08T00:00:00.000Z",
      endIso: "2026-05-09T00:00:00.000Z",
    };
    render(
      <TriageStoriesView
        stories={[story]}
        truncated={false}
        focused={story}
        onFocus={() => {}}
        period={period}
        loadDetail={loadDetail}
        labels={LABELS}
      />,
    );
    expect(screen.queryByTestId("triage-story-dangling-notice")).toBeNull();
  });

  it("does NOT render the notice when the loader fails (no authoritative signal)", async () => {
    const story = makeStory({
      summary: {
        kindHistogram: {},
        categoryHistogram: {},
        memberCount: 12,
        durationMs: 0,
        distinctAssetCount: 0,
        topRawScore: 0,
      },
      topMembers: [
        {
          eventKey: "1",
          eventTimeIso: "2026-05-09T12:10:00.000Z",
          kind: "HttpThreat",
          category: "IMPACT",
          rawScore: 4.5,
        },
      ],
    });
    const loadDetail = vi.fn(async () => null);
    const period: TriagePeriod = {
      startIso: "2026-05-08T00:00:00.000Z",
      endIso: "2026-05-09T00:00:00.000Z",
    };
    await act(async () => {
      render(
        <TriageStoriesView
          stories={[story]}
          truncated={false}
          focused={story}
          onFocus={() => {}}
          period={period}
          loadDetail={loadDetail}
          labels={LABELS}
        />,
      );
    });
    await waitFor(() => {
      expect(loadDetail).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByTestId("triage-story-dangling-notice")).toBeNull();
  });

  it("does NOT render the notice when no loader is supplied (unit-test path lacks dangling signal)", () => {
    const story = makeStory({
      summary: {
        kindHistogram: {},
        categoryHistogram: {},
        memberCount: 12,
        durationMs: 0,
        distinctAssetCount: 0,
        topRawScore: 0,
      },
      topMembers: [
        {
          eventKey: "1",
          eventTimeIso: "2026-05-09T12:10:00.000Z",
          kind: "HttpThreat",
          category: "IMPACT",
          rawScore: 4.5,
        },
      ],
    });
    render(
      <TriageStoriesView
        stories={[story]}
        truncated={false}
        focused={story}
        onFocus={() => {}}
        labels={LABELS}
      />,
    );
    expect(screen.queryByTestId("triage-story-dangling-notice")).toBeNull();
  });

  it("calls loadDetail with composite identity and swaps top-3 preview for the full join", async () => {
    const story = makeStory({
      summary: {
        kindHistogram: {},
        categoryHistogram: {},
        memberCount: 4,
        durationMs: 0,
        distinctAssetCount: 0,
        topRawScore: 0,
      },
      topMembers: [
        {
          eventKey: "1",
          eventTimeIso: "2026-05-09T12:10:00.000Z",
          kind: "HttpThreat",
          category: "IMPACT",
          rawScore: 4.5,
        },
      ],
    });
    const fullMembers: TriageStoryMemberDetail[] = [
      {
        eventKey: "1",
        eventTimeIso: "2026-05-09T12:10:00.000Z",
        kind: "HttpThreat",
        sensor: "sensor-a",
        origAddr: "10.0.0.5",
        respAddr: "8.8.8.8",
        origPort: 12345,
        respPort: 443,
        host: null,
        dnsQuery: null,
        uri: null,
        category: "IMPACT",
        baselineScore: 0.92,
      },
      {
        eventKey: "2",
        eventTimeIso: "2026-05-09T12:11:00.000Z",
        kind: "DnsCovertChannel",
        sensor: "sensor-a",
        origAddr: "10.0.0.5",
        respAddr: "1.1.1.1",
        origPort: null,
        respPort: 53,
        host: null,
        dnsQuery: "evil.example",
        uri: null,
        category: "EXFILTRATION",
        baselineScore: 0.71,
      },
      {
        eventKey: "3",
        eventTimeIso: "2026-05-09T12:12:00.000Z",
        kind: "HttpThreat",
        sensor: "sensor-a",
        origAddr: "10.0.0.5",
        respAddr: "8.8.8.8",
        origPort: 12346,
        respPort: 443,
        host: null,
        dnsQuery: null,
        uri: null,
        category: "IMPACT",
        baselineScore: 0.65,
      },
    ];
    const loadDetail = vi.fn(async (args: unknown) => ({
      members: fullMembers,
      hasDanglingMembers: true,
      storedMemberCount: 4,
      _input: args,
    }));
    const period: TriagePeriod = {
      startIso: "2026-05-08T00:00:00.000Z",
      endIso: "2026-05-09T00:00:00.000Z",
    };
    await act(async () => {
      render(
        <TriageStoriesView
          stories={[story]}
          truncated={false}
          focused={story}
          onFocus={() => {}}
          period={period}
          loadDetail={loadDetail}
          labels={LABELS}
        />,
      );
    });
    expect(loadDetail).toHaveBeenCalledTimes(1);
    expect(loadDetail.mock.calls[0][0]).toEqual({
      customerId: 7,
      storyId: "1",
      storedMemberCount: 4,
    });
    // After the fetch resolves, the table shows 3 rows (the full
    // join) and the dangling notice reads "3 of 4 events shown — 1
    // aged" rather than the list-time top-3 preview's "1 of 4".
    await waitFor(() => {
      const notice = screen.getByTestId("triage-story-dangling-notice");
      expect(notice.textContent).toBe(
        "3 of 4 events shown — 1 aged past corpus A retention",
      );
    });
  });

  it("falls back to the top-3 preview when no loader is supplied", () => {
    const story = makeStory();
    render(
      <TriageStoriesView
        stories={[story]}
        truncated={false}
        focused={story}
        onFocus={() => {}}
        labels={LABELS}
      />,
    );
    // Without a loader the panel must still render the preview rows
    // it has — important for any embedded harness or test that
    // skips wiring the server action.
    const detail = screen.getByTestId("triage-story-detail");
    expect(detail.textContent).toContain("HttpThreat");
  });

  it("renders no notice when shown count equals stored count", () => {
    const story = makeStory({
      summary: {
        kindHistogram: {},
        categoryHistogram: {},
        memberCount: 1,
        durationMs: 0,
        distinctAssetCount: 0,
        topRawScore: 0,
      },
    });
    render(
      <TriageStoriesView
        stories={[story]}
        truncated={false}
        focused={story}
        onFocus={() => {}}
        labels={LABELS}
      />,
    );
    expect(screen.queryByTestId("triage-story-dangling-notice")).toBeNull();
  });
});

/**
 * Round 5 finding: a quick sort-toggle → unsent-toggle sequence
 * dispatches two server refreshes. If the older one resolves second
 * (network reorder, congested transition queue), it must NOT overwrite
 * the newer response — otherwise the controls show the newer state
 * while the list is the older slice.
 */
describe("TriageStoriesView — refresh ordering guard", () => {
  it("drops a stale server response when a newer toggle has superseded it", async () => {
    const newer = makeStory({
      customerId: 7,
      storyId: "newer",
      score: 9,
    });
    const older = makeStory({
      customerId: 7,
      storyId: "older",
      score: 1,
    });

    // Two refresh calls; the FIRST resolves AFTER the SECOND. Each
    // returns a single-row slice so the test can read which response
    // actually committed to the list.
    let resolveFirst: (v: {
      stories: ReadonlyArray<TriageStory>;
      truncated: boolean;
    }) => void = () => {};
    let resolveSecond: (v: {
      stories: ReadonlyArray<TriageStory>;
      truncated: boolean;
    }) => void = () => {};
    let call = 0;
    const refreshStories = vi.fn(
      () =>
        new Promise<{
          stories: ReadonlyArray<TriageStory>;
          truncated: boolean;
        }>((resolve) => {
          call += 1;
          if (call === 1) resolveFirst = resolve;
          else resolveSecond = resolve;
        }),
    );

    const period: TriagePeriod = {
      startIso: "2026-05-08T00:00:00.000Z",
      endIso: "2026-05-09T00:00:00.000Z",
    };
    await act(async () => {
      render(
        <TriageStoriesView
          stories={[older]}
          truncated={false}
          focused={null}
          onFocus={() => {}}
          period={period}
          refreshStories={refreshStories}
          labels={LABELS}
        />,
      );
    });

    // Toggle the sort first — kicks off request #1.
    await act(async () => {
      fireEvent.change(screen.getByTestId("triage-stories-sort"), {
        target: { value: "score" },
      });
    });
    // Toggle the unsent filter — kicks off request #2 BEFORE #1
    // resolves.
    await act(async () => {
      fireEvent.click(screen.getByTestId("triage-stories-unsent-only"));
    });

    // Resolve #2 first. The list should switch to the `newer` slice.
    await act(async () => {
      resolveSecond({ stories: [newer], truncated: false });
    });
    await waitFor(() => {
      const cards = screen.getAllByTestId("triage-story-card");
      expect(cards[0].getAttribute("data-story-id")).toBe("7/newer");
    });

    // Now resolve #1 (the stale one). The list must NOT revert to its
    // payload — the older request was superseded.
    await act(async () => {
      resolveFirst({ stories: [older], truncated: false });
    });
    const cards = screen.getAllByTestId("triage-story-card");
    expect(cards).toHaveLength(1);
    expect(cards[0].getAttribute("data-story-id")).toBe("7/newer");

    expect(refreshStories).toHaveBeenCalledTimes(2);
  });

  /**
   * Round 7 finding: focus reconciliation in the parent watches the
   * parent `stories` prop, but a SQL-side sort/filter refresh rotates
   * the effective list inside this view without touching the prop.
   * After enabling "Show only unsent", a focused sent Story must not
   * survive in the detail panel — the refresh path clears focus when
   * the focused composite key is absent from the refreshed slice.
   */
  it("clears focus when the focused Story is filtered out by a refresh", async () => {
    const sent = makeStory({
      customerId: 7,
      storyId: "sent",
      lastSentAtIso: "2026-05-09T12:35:00.000Z",
      sendCount: 1,
    });
    const unsent = makeStory({
      customerId: 7,
      storyId: "unsent",
      lastSentAtIso: null,
      sendCount: 0,
    });
    const onFocus = vi.fn();
    const refreshStories = vi.fn(async () => ({
      stories: [unsent],
      truncated: false,
    }));
    const period: TriagePeriod = {
      startIso: "2026-05-08T00:00:00.000Z",
      endIso: "2026-05-09T00:00:00.000Z",
    };
    await act(async () => {
      render(
        <TriageStoriesView
          stories={[sent, unsent]}
          truncated={false}
          focused={sent}
          onFocus={onFocus}
          period={period}
          refreshStories={refreshStories}
          labels={LABELS}
        />,
      );
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("triage-stories-unsent-only"));
    });
    await waitFor(() => {
      expect(refreshStories).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(onFocus).toHaveBeenCalledWith(null);
    });
  });

  /**
   * Round 7: a focus that IS still present in the refreshed slice
   * must NOT be cleared — otherwise toggling sort would close a Story
   * the analyst is still reading.
   */
  it("preserves focus when the focused Story is still present after a refresh", async () => {
    const a = makeStory({ customerId: 7, storyId: "a" });
    const b = makeStory({ customerId: 7, storyId: "b" });
    const onFocus = vi.fn();
    const refreshStories = vi.fn(async () => ({
      stories: [b, a],
      truncated: false,
    }));
    const period: TriagePeriod = {
      startIso: "2026-05-08T00:00:00.000Z",
      endIso: "2026-05-09T00:00:00.000Z",
    };
    await act(async () => {
      render(
        <TriageStoriesView
          stories={[a, b]}
          truncated={false}
          focused={a}
          onFocus={onFocus}
          period={period}
          refreshStories={refreshStories}
          labels={LABELS}
        />,
      );
    });
    await act(async () => {
      fireEvent.change(screen.getByTestId("triage-stories-sort"), {
        target: { value: "score" },
      });
    });
    await waitFor(() => {
      expect(refreshStories).toHaveBeenCalledTimes(1);
    });
    expect(onFocus).not.toHaveBeenCalled();
  });

  /**
   * Round 8 finding: the refresh resolver must reconcile against the
   * focus *at commit time*, not the focus captured when the refresh was
   * dispatched. Scenario: no Story is focused, the analyst enables
   * "Show only unsent" (kicks off a refresh), and then opens a sent
   * Story before the response returns. The resolver must observe the
   * newly-focused Story (via a ref tracking the latest prop) and clear
   * it because the refreshed slice no longer contains it — without the
   * ref, the closed-over `focused === null` would leave the now-absent
   * sent Story focused.
   */
  it("clears a focus opened after dispatch when it is absent from the refreshed slice", async () => {
    const sent = makeStory({
      customerId: 7,
      storyId: "sent",
      lastSentAtIso: "2026-05-09T12:35:00.000Z",
      sendCount: 1,
    });
    const unsent = makeStory({
      customerId: 7,
      storyId: "unsent",
      lastSentAtIso: null,
      sendCount: 0,
    });
    let resolveRefresh: (v: {
      stories: ReadonlyArray<TriageStory>;
      truncated: boolean;
    }) => void = () => {};
    const refreshStories = vi.fn(
      () =>
        new Promise<{
          stories: ReadonlyArray<TriageStory>;
          truncated: boolean;
        }>((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    const onFocus = vi.fn();
    const period: TriagePeriod = {
      startIso: "2026-05-08T00:00:00.000Z",
      endIso: "2026-05-09T00:00:00.000Z",
    };
    // Stable prop array so a rerender that only changes `focused`
    // does not trip the "prop rotation invalidates refresh" guard.
    const storiesProp: ReadonlyArray<TriageStory> = [sent, unsent];
    const view = (focused: TriageStory | null) => (
      <TriageStoriesView
        stories={storiesProp}
        truncated={false}
        focused={focused}
        onFocus={onFocus}
        period={period}
        refreshStories={refreshStories}
        labels={LABELS}
      />
    );
    type Rerender = ReturnType<typeof render>["rerender"];
    let rerender: Rerender = () => {};
    await act(async () => {
      ({ rerender } = render(view(null)));
    });
    // Dispatch the refresh with focused === null.
    await act(async () => {
      fireEvent.click(screen.getByTestId("triage-stories-unsent-only"));
    });
    await waitFor(() => {
      expect(refreshStories).toHaveBeenCalledTimes(1);
    });
    // Analyst opens the sent Story before the response returns. The
    // render-time `focusedRef.current = focused` assignment (not a
    // passive effect) makes the new focus visible to the resolver as
    // soon as the rerender commits, so no waiting for the effect tick.
    rerender(view(sent));
    await act(async () => {
      resolveRefresh({ stories: [unsent], truncated: false });
    });
    await waitFor(() => {
      expect(onFocus).toHaveBeenCalledWith(null);
    });
  });

  /**
   * Round 8 finding (inverse): if Story A was focused when the refresh
   * was dispatched and the analyst opens Story B before the response
   * returns, a response that drops A must NOT clear B. The resolver
   * reads the focus at commit time — B is present in the refreshed
   * slice, so focus is preserved.
   */
  it("preserves a focus rotated after dispatch when it is present in the refreshed slice", async () => {
    const a = makeStory({ customerId: 7, storyId: "a" });
    const b = makeStory({ customerId: 7, storyId: "b" });
    let resolveRefresh: (v: {
      stories: ReadonlyArray<TriageStory>;
      truncated: boolean;
    }) => void = () => {};
    const refreshStories = vi.fn(
      () =>
        new Promise<{
          stories: ReadonlyArray<TriageStory>;
          truncated: boolean;
        }>((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    const onFocus = vi.fn();
    const period: TriagePeriod = {
      startIso: "2026-05-08T00:00:00.000Z",
      endIso: "2026-05-09T00:00:00.000Z",
    };
    const storiesProp: ReadonlyArray<TriageStory> = [a, b];
    const view = (focused: TriageStory | null) => (
      <TriageStoriesView
        stories={storiesProp}
        truncated={false}
        focused={focused}
        onFocus={onFocus}
        period={period}
        refreshStories={refreshStories}
        labels={LABELS}
      />
    );
    type Rerender = ReturnType<typeof render>["rerender"];
    let rerender: Rerender = () => {};
    await act(async () => {
      ({ rerender } = render(view(a)));
    });
    await act(async () => {
      fireEvent.change(screen.getByTestId("triage-stories-sort"), {
        target: { value: "score" },
      });
    });
    await waitFor(() => {
      expect(refreshStories).toHaveBeenCalledTimes(1);
    });
    // Analyst opens B before the response returns. The render-time
    // ref-sync makes B visible to the resolver as soon as this
    // rerender commits — no passive-effect tick needed.
    rerender(view(b));
    await act(async () => {
      resolveRefresh({ stories: [b], truncated: false });
    });
    // Focus must stay on B — the resolver checks the latest prop.
    await waitFor(() => {
      expect(refreshStories).toHaveBeenCalledTimes(1);
    });
    expect(onFocus).not.toHaveBeenCalled();
  });
});

/**
 * Round 7 finding: opening a Story's detail panel must show the same
 * Story title the card displayed, the stored member count from
 * `summary_payload.memberCount`, and the Story time window — otherwise
 * the analyst loses the identity that distinguishes adjacent Stories
 * for the same asset/customer once the card is replaced by the panel.
 */
describe("TriageStoryDetail — header identity", () => {
  it("renders title, member count, time window, rule badge, and customer in the detail header", () => {
    const story = makeStory({
      customerId: 7,
      storyId: "story-1",
      primaryAsset: "10.0.0.5",
      timeWindowStartIso: "2026-05-09T12:00:00.000Z",
      timeWindowEndIso: "2026-05-09T12:30:00.000Z",
      summary: {
        kindHistogram: { HttpThreat: 12 },
        categoryHistogram: { IMPACT: 12 },
        memberCount: 12,
        durationMs: 30 * 60 * 1000,
        distinctAssetCount: 1,
        topRawScore: 4.5,
      },
    });
    render(
      <TriageStoriesView
        stories={[story]}
        truncated={false}
        focused={story}
        onFocus={() => {}}
        labels={LABELS}
      />,
    );
    const title = screen.getByTestId("triage-story-detail-title");
    expect(title.textContent).toBe("10.0.0.5 · 30 min · IMPACT");
    const memberCount = screen.getByTestId("triage-story-detail-member-count");
    expect(memberCount.textContent).toBe("12 events");
    const timeWindow = screen.getByTestId("triage-story-detail-time-window");
    expect(timeWindow.textContent).toBe(
      "2026-05-09T12:00:00.000Z ~ 2026-05-09T12:30:00.000Z",
    );
    const detail = screen.getByTestId("triage-story-detail");
    // Rule badge ("R1" by default) and customer name remain.
    expect(detail.textContent).toContain("R1");
    expect(detail.textContent).toContain("Acme");
  });

  it("uses the analyst-curated badge for curated stories", () => {
    const story = makeStory({
      kind: "analyst_curated",
      ruleId: null,
      summary: {
        kindHistogram: {},
        categoryHistogram: {},
        memberCount: 5,
        durationMs: 0,
        distinctAssetCount: 1,
        topRawScore: 0,
        manualTitle: "Phishing campaign on 10.0.0.5",
      },
    });
    render(
      <TriageStoriesView
        stories={[story]}
        truncated={false}
        focused={story}
        onFocus={() => {}}
        labels={LABELS}
      />,
    );
    const title = screen.getByTestId("triage-story-detail-title");
    expect(title.textContent).toBe("Phishing campaign on 10.0.0.5");
    const detail = screen.getByTestId("triage-story-detail");
    expect(detail.textContent).toContain(LABELS.card.ruleBadgeAnalyst);
  });
});
