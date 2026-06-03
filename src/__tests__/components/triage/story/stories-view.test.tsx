import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { manualSendToAimerWebMock, ManualSendErrorStub } = vi.hoisted(() => {
  class ManualSendErrorStub extends Error {
    readonly stage: string;
    readonly code?: string;
    constructor(args: { stage: string; code?: string; message: string }) {
      super(args.message);
      this.name = "ManualSendError";
      this.stage = args.stage;
      this.code = args.code;
    }
  }
  return {
    manualSendToAimerWebMock: vi.fn(),
    ManualSendErrorStub,
  };
});

vi.mock("@/lib/aimer/phase2/manual-send.client", () => ({
  manualSendToAimerWeb: manualSendToAimerWebMock,
  ManualSendError: ManualSendErrorStub,
}));

import {
  AI_ANALYSIS_MAX_IN_FLIGHT,
  AI_ANALYSIS_NEGATIVE_TTL_MS,
  TriageStoriesView,
  type TriageStoriesViewLabels,
} from "@/components/triage/story/stories-view";
import { formatDateTime } from "@/lib/format-date";
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
    sendToAimerWeb: "Send to Insight",
    sendToAimerWebTooltip: "LLM analysis not yet available",
    sendToAimerWebDisabledTooltip: "Clumit Insight integration not configured",
    sentIndicatorTemplate: "Sent {relative}",
    sentMultiTemplate: "{count}×",
    sendMoreMenuLabel: "More send options",
    sendForceRefresh: "Send (force refresh)",
    forceRefreshConfirmMessage: "Bypass cache?",
    forceRefreshConfirmButton: "Send",
    forceRefreshCancelButton: "Cancel",
    sendInFlight: "Sending…",
    sendSuccessToast: "Sent to Insight",
    sendErrorPrefix: "Could not send to Insight:",
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
    aiAnalysisBadge: {
      tierCritical: "AI · CRITICAL",
      tierHigh: "AI · HIGH",
      tooltipTemplate:
        "AI analysis ({tier}) · severity {severity} · likelihood {likelihood}",
      linkAriaLabel: "Open AI analysis ({tier})",
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
describe("Send-to-aimer-web button — wired in #493", () => {
  it("renders enabled with the stable data-action hook and tooltip when the Aimer integration is configured", () => {
    render(
      <TriageStoriesView
        stories={[makeStory()]}
        truncated={false}
        aimerIntegrationConfigured={true}
        focused={null}
        onFocus={() => {}}
        labels={LABELS}
      />,
    );
    const btn = screen.getByTestId("triage-story-send");
    expect(btn.hasAttribute("disabled")).toBe(false);
    expect(btn.getAttribute("aria-disabled")).toBe("false");
    expect(btn.getAttribute("data-action")).toBe("send-to-aimer-web");
    expect(btn.getAttribute("title")).toBe(LABELS.card.sendToAimerWebTooltip);
  });

  it("greys out the Send button + kebab menu and surfaces the disabled tooltip when the Aimer integration is not configured", () => {
    render(
      <TriageStoriesView
        stories={[makeStory()]}
        truncated={false}
        // `aimerIntegrationConfigured` omitted — the default is
        // `false`, matching what a fresh page render sees when the
        // admin has not filled in the `aice_id` / bridge URL / signing
        // key triple. The Send affordance must surface the
        // explanatory tooltip rather than letting the user click and
        // hit a route error.
        focused={null}
        onFocus={() => {}}
        labels={LABELS}
      />,
    );
    const btn = screen.getByTestId("triage-story-send");
    expect(btn.hasAttribute("disabled")).toBe(true);
    expect(btn.getAttribute("aria-disabled")).toBe("true");
    expect(btn.getAttribute("title")).toBe(
      LABELS.card.sendToAimerWebDisabledTooltip,
    );
    const menuTrigger = screen.getByTestId("triage-story-send-menu");
    expect(menuTrigger.hasAttribute("disabled")).toBe(true);
  });

  it("does not invoke manualSendToAimerWeb when the Send button is clicked while the integration is not configured", async () => {
    manualSendToAimerWebMock.mockReset();
    render(
      <TriageStoriesView
        stories={[makeStory()]}
        truncated={false}
        focused={null}
        onFocus={() => {}}
        labels={LABELS}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("triage-story-send"));
    });
    expect(manualSendToAimerWebMock).not.toHaveBeenCalled();
  });
});

/**
 * Manual Send UX wiring (#493):
 *  - Clicking Send routes to `manualSendToAimerWeb`, the success path
 *    pops a toast and overrides the β indicator on the card.
 *  - Errors surface the structured code via the error-toast path.
 *  - Force-refresh requires confirming a dialog, then forwards
 *    `forceRefresh: true`.
 *
 * The per-customer periodic drain is no longer mounted here (#651) — it
 * moved to the app-shell `AimerPhase2CadenceManager`.
 */
describe("TriageStoriesView — manual Send wiring (#493)", () => {
  beforeEach(() => {
    manualSendToAimerWebMock.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("on success: fires manualSendToAimerWeb, shows the success toast, overrides β on the card", async () => {
    manualSendToAimerWebMock.mockResolvedValue({
      lastSentAtIso: "2026-05-17T12:00:00.000Z",
      sendCount: 4,
      duplicatesSkipped: 0,
    });
    const story = makeStory({ lastSentAtIso: null, sendCount: 0 });
    render(
      <TriageStoriesView
        stories={[story]}
        truncated={false}
        aimerIntegrationConfigured={true}
        focused={null}
        onFocus={() => {}}
        labels={LABELS}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId("triage-story-send"));
    });

    expect(manualSendToAimerWebMock).toHaveBeenCalledWith({
      customerId: 7,
      storyId: "1",
      forceRefresh: false,
    });
    await waitFor(() => {
      expect(
        screen.getByTestId("triage-story-send-toast-success"),
      ).toBeTruthy();
    });
    // β indicator should re-render against the override without a
    // full menu refresh — `sentMultiTemplate` is appended once
    // `sendCount > 1`.
    const indicator = screen.getByTestId("triage-story-sent-indicator");
    expect(indicator.textContent ?? "").toContain("4×");
  });

  it("on failure: shows the error toast carrying the structured code, β untouched", async () => {
    manualSendToAimerWebMock.mockRejectedValue(
      new ManualSendErrorStub({
        stage: "ack_manual",
        code: "replay_or_unknown_jti",
        message: "boom",
      }),
    );
    const story = makeStory({ lastSentAtIso: null, sendCount: 0 });
    render(
      <TriageStoriesView
        stories={[story]}
        truncated={false}
        aimerIntegrationConfigured={true}
        focused={null}
        onFocus={() => {}}
        labels={LABELS}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId("triage-story-send"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("triage-story-send-toast-error")).toBeTruthy();
    });
    const errorToast = screen.getByTestId("triage-story-send-toast-error");
    expect(errorToast.textContent ?? "").toContain("replay_or_unknown_jti");
    // β indicator never rendered because the original story had
    // lastSentAtIso === null and no override committed on failure.
    expect(screen.queryByTestId("triage-story-sent-indicator")).toBeNull();
  });

  it("force-refresh path: confirm dialog gates the send, then forwards forceRefresh=true", async () => {
    manualSendToAimerWebMock.mockResolvedValue({
      lastSentAtIso: "2026-05-17T12:00:00.000Z",
      sendCount: 1,
      duplicatesSkipped: 1,
    });
    const story = makeStory({ lastSentAtIso: null, sendCount: 0 });
    render(
      <TriageStoriesView
        stories={[story]}
        truncated={false}
        aimerIntegrationConfigured={true}
        focused={null}
        onFocus={() => {}}
        labels={LABELS}
      />,
    );

    fireEvent.click(screen.getByTestId("triage-story-send-menu"));
    fireEvent.click(screen.getByTestId("triage-story-send-force-refresh"));

    // The confirm dialog is required before manualSendToAimerWeb fires.
    expect(manualSendToAimerWebMock).not.toHaveBeenCalled();
    expect(screen.getByTestId("triage-story-send-force-confirm")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByTestId("triage-story-send-force-confirm-ok"));
    });

    expect(manualSendToAimerWebMock).toHaveBeenCalledWith({
      customerId: 7,
      storyId: "1",
      forceRefresh: true,
    });
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
        baselineVersion: "v1",
        protectedByStory: false,
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
        baselineVersion: "v1",
        protectedByStory: false,
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
        baselineVersion: "v1",
        protectedByStory: false,
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
        baselineVersion: "v1",
        protectedByStory: false,
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
    // #684: the time window now renders in the operator's configured
    // timezone via `formatDateTime`, not raw UTC ISO. Compute the
    // expectation through the same helper so the assertion stays
    // independent of the runtime test timezone.
    const timeWindow = screen.getByTestId("triage-story-detail-time-window");
    expect(timeWindow.textContent).toBe(
      `${formatDateTime("2026-05-09T12:00:00.000Z")} ~ ${formatDateTime(
        "2026-05-09T12:30:00.000Z",
      )}`,
    );
    const detail = screen.getByTestId("triage-story-detail");
    // Rule badge ("R1" by default) and customer name remain.
    expect(detail.textContent).toContain("R1");
    expect(detail.textContent).toContain("Acme");
  });

  it("renders the chain-link marker on members whose protectedByStory flag is set (#471 §3, review-round-1 item 2)", async () => {
    const story = makeStory({
      summary: {
        kindHistogram: { HttpThreat: 2 },
        categoryHistogram: { IMPACT: 2 },
        memberCount: 2,
        durationMs: 0,
        distinctAssetCount: 1,
        topRawScore: 0.9,
      },
    });
    const marked: TriageStoryMemberDetail = {
      eventKey: "marked",
      eventTimeIso: "2026-05-08T12:00:00.000Z",
      kind: "HttpThreat",
      sensor: "sensor-a",
      origAddr: "10.0.0.1",
      respAddr: null,
      origPort: null,
      respPort: null,
      host: null,
      dnsQuery: null,
      uri: null,
      category: "IMPACT",
      baselineScore: 0.3,
      baselineVersion: "v1",
      protectedByStory: true,
    };
    const unmarked: TriageStoryMemberDetail = {
      eventKey: "unmarked",
      eventTimeIso: "2026-05-08T12:01:00.000Z",
      kind: "HttpThreat",
      sensor: "sensor-a",
      origAddr: "10.0.0.2",
      respAddr: null,
      origPort: null,
      respPort: null,
      host: null,
      dnsQuery: null,
      uri: null,
      category: "IMPACT",
      baselineScore: 0.97,
      baselineVersion: "v1",
      protectedByStory: false,
    };
    const loadDetail = vi.fn(async () => ({
      members: [marked, unmarked],
      hasDanglingMembers: false,
      storedMemberCount: 2,
    }));
    const period: TriagePeriod = {
      startIso: "2026-05-08T00:00:00.000Z",
      endIso: "2026-05-09T00:00:00.000Z",
    };
    const detailLabels: TriageStoriesViewLabels = {
      ...LABELS,
      detail: {
        ...LABELS.detail,
        protectedByStoryMarker: {
          template: "Kept because of Story membership (score: {score})",
        },
      },
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
          labels={detailLabels}
        />,
      );
    });
    await waitFor(() => {
      const markers = screen.getAllByTestId("triage-event-protected-marker");
      // Exactly one row carries the marker — the 0.30 row that the
      // four-condition rule keeps.
      expect(markers).toHaveLength(1);
      expect(markers[0].getAttribute("aria-label")).toBe(
        "Kept because of Story membership (score: 0.3)",
      );
    });
  });

  // #588 R3 item 2: `story_pivot_click` must be attributed to the
  // member whose pivot button the analyst clicked — using `members[0]`
  // would record a different member than the one actually clicked
  // (e.g. a DNS member's pivot recorded against an HTTP first-member's
  // row metadata). The fix threads the clicked `TriageStoryMemberDetail`
  // through the callback.
  it("threads the clicked member through onPivotFromStory (not members[0])", async () => {
    const story = makeStory();
    const members: TriageStoryMemberDetail[] = [
      {
        eventKey: "first-http-key",
        eventTimeIso: "2026-05-09T12:10:00.000Z",
        kind: "HttpThreat",
        sensor: "sensor-a",
        origAddr: "10.0.0.5",
        respAddr: "8.8.8.8",
        origPort: 12345,
        respPort: 443,
        host: "first.example.com",
        dnsQuery: null,
        uri: null,
        category: "IMPACT",
        baselineScore: 0.92,
        baselineVersion: "phase1b-four-selector",
        protectedByStory: false,
      },
      {
        eventKey: "second-dns-key",
        eventTimeIso: "2026-05-09T12:11:00.000Z",
        kind: "DnsCovertChannel",
        sensor: "sensor-a",
        origAddr: "10.0.0.5",
        respAddr: "9.9.9.9",
        origPort: 33333,
        respPort: 53,
        host: null,
        dnsQuery: "exfil.example.net",
        uri: null,
        category: "EXFILTRATION",
        baselineScore: 0.81,
        baselineVersion: "phase1b-four-selector",
        protectedByStory: false,
      },
    ];
    const loadDetail = vi.fn(async () => ({
      members,
      hasDanglingMembers: false,
      storedMemberCount: 2,
    }));
    const onPivotFromStory = vi.fn();
    const dimensions = {
      externalIp: "External IP",
      internalIp: "Internal IP",
      port: "Port",
      host: "Host",
      uriPattern: "URI",
      dnsQuery: "DNS query",
      sameSensor: "Sensor",
    } as unknown as Record<
      import("@/lib/triage/pivot").PivotDimensionId,
      string
    >;
    const labels: TriageStoriesViewLabels = {
      ...LABELS,
      detail: {
        ...LABELS.detail,
        pivotActionsColumn: "Pivot",
        pivotActionTemplate: "Pivot {dimension}={value}",
        pivotDimensions: dimensions,
      },
    };
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
          onPivotFromStory={onPivotFromStory}
          labels={labels}
        />,
      );
    });
    // The `dnsQuery` button only exists on the second (DNS) member —
    // the first (HTTP) member has no dnsQuery — so clicking it
    // unambiguously targets that row.
    let dnsButton: HTMLElement | null = null;
    await waitFor(() => {
      const buttons = screen.queryAllByTestId(
        "triage-story-member-pivot-action",
      );
      dnsButton =
        buttons.find((b) => b.getAttribute("data-dimension") === "dnsQuery") ??
        null;
      expect(dnsButton).not.toBeNull();
    });
    if (!dnsButton) throw new Error("dnsQuery pivot button never rendered");
    fireEvent.click(dnsButton as HTMLElement);
    expect(onPivotFromStory).toHaveBeenCalledTimes(1);
    const args = onPivotFromStory.mock.calls[0][0];
    expect(args.member.eventKey).toBe("second-dns-key");
    expect(args.member.kind).toBe("DnsCovertChannel");
    expect(args.member.baselineVersion).toBe("phase1b-four-selector");
    // members[0] is the HTTP row — the bug was attributing the click
    // there. Guard against a regression.
    expect(args.member.eventKey).not.toBe(args.members[0].eventKey);
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

/**
 * Bounded-concurrency contract for the AI-analysis summary fan-out
 * (#645 "Fetch fan-out and concurrency"). The Stories page caps at
 * 200 rows; a naive per-card fetch would issue 200 simultaneous
 * internal requests and 200 onward requests against aimer-web. The
 * stories-view container must cap in-flight requests at
 * `AI_ANALYSIS_MAX_IN_FLIGHT`.
 */
describe("TriageStoriesView — AI-analysis fan-out is bounded (#645)", () => {
  it("never exceeds AI_ANALYSIS_MAX_IN_FLIGHT simultaneous loadAiAnalysis calls", async () => {
    const STORY_COUNT = 30;
    const stories: TriageStory[] = Array.from({ length: STORY_COUNT }, (_, i) =>
      makeStory({ customerId: 7, storyId: String(i + 1) }),
    );

    let inFlight = 0;
    let maxInFlight = 0;
    const resolvers: Array<() => void> = [];
    const loadAiAnalysis = vi.fn(async () => {
      inFlight += 1;
      if (inFlight > maxInFlight) maxInFlight = inFlight;
      await new Promise<void>((resolve) => {
        resolvers.push(() => {
          inFlight -= 1;
          resolve();
        });
      });
      return null;
    });

    await act(async () => {
      render(
        <TriageStoriesView
          stories={stories}
          truncated={false}
          focused={null}
          onFocus={() => {}}
          loadAiAnalysis={loadAiAnalysis}
          labels={LABELS}
        />,
      );
    });

    // After mount, only the bounded slice has started.
    await waitFor(() => {
      expect(resolvers.length).toBe(AI_ANALYSIS_MAX_IN_FLIGHT);
    });
    expect(loadAiAnalysis).toHaveBeenCalledTimes(AI_ANALYSIS_MAX_IN_FLIGHT);

    // Drain the queue in waves. Each resolve must allow exactly one
    // more queued request to start, never more — that is the only
    // behavior that distinguishes a bounded queue from a naive
    // unbounded fan-out.
    while (resolvers.length > 0) {
      const resolve = resolvers.shift();
      if (!resolve) break;
      await act(async () => {
        resolve();
      });
    }

    expect(loadAiAnalysis).toHaveBeenCalledTimes(STORY_COUNT);
    expect(maxInFlight).toBeLessThanOrEqual(AI_ANALYSIS_MAX_IN_FLIGHT);
    // Sanity: the constant itself must be in the documented 6–8
    // range — guard against an accidental bump that would defeat
    // the cap.
    expect(AI_ANALYSIS_MAX_IN_FLIGHT).toBeGreaterThanOrEqual(6);
    expect(AI_ANALYSIS_MAX_IN_FLIGHT).toBeLessThanOrEqual(8);
  });

  /**
   * Regression for [Reviewer Round 2] item 2: when the Stories list
   * rotates (sort / filter / unsent-only) while the first batch of
   * AI-analysis lookups is in flight, those lookups must still
   * complete and populate the badge cache. A bounded queue that
   * aborts active fetches on rotation but only releases queued
   * reservations leaves the still-visible Stories stuck without a
   * badge until some unrelated later list change.
   */
  it("still resolves in-flight stories after the list rotates", async () => {
    const a = makeStory({ customerId: 7, storyId: "10" });
    const b = makeStory({ customerId: 7, storyId: "20" });
    const c = makeStory({ customerId: 7, storyId: "30" });

    const resolversByStoryId = new Map<string, () => void>();
    const loadAiAnalysis = vi.fn(async (args: { storyId: string }) => {
      await new Promise<void>((resolve) => {
        resolversByStoryId.set(args.storyId, () => resolve());
      });
      return {
        tier: "HIGH" as const,
        href: `https://aimer.example.com/analysis/story/${args.storyId}`,
        severityScore: 0.6,
        likelihoodScore: 0.5,
        scoreKind: "leaf" as const,
      };
    });

    const { rerender } = render(
      <TriageStoriesView
        stories={[a, b, c]}
        truncated={false}
        focused={null}
        onFocus={() => {}}
        loadAiAnalysis={loadAiAnalysis}
        labels={LABELS}
      />,
    );

    await waitFor(() => {
      expect(loadAiAnalysis).toHaveBeenCalledTimes(3);
    });

    // Rotate the list while the three lookups are still in flight.
    // A reverse-sort rotation keeps the same composite keys visible,
    // which is exactly the scenario where the previous abort-and-
    // release-only-queued behaviour would orphan reservations.
    rerender(
      <TriageStoriesView
        stories={[c, b, a]}
        truncated={false}
        focused={null}
        onFocus={() => {}}
        loadAiAnalysis={loadAiAnalysis}
        labels={LABELS}
      />,
    );

    // The rotation must not have triggered a second call for any of
    // the already-in-flight Stories — they are still reserved in
    // `aiInFlightRef` and the queue must skip them.
    expect(loadAiAnalysis).toHaveBeenCalledTimes(3);

    // Resolve the original in-flight fetches and assert that every
    // Story ends up with a badge rendered.
    await act(async () => {
      for (const storyId of ["10", "20", "30"]) {
        const resolve = resolversByStoryId.get(storyId);
        resolve?.();
      }
      // Yield once for the promise chains to settle.
      await Promise.resolve();
    });

    await waitFor(() => {
      const badges = screen.getAllByTestId("triage-story-ai-analysis-badge");
      expect(badges).toHaveLength(3);
    });

    // Cache hit on a subsequent identical rotation — no extra
    // fetcher invocations.
    rerender(
      <TriageStoriesView
        stories={[a, b, c]}
        truncated={false}
        focused={null}
        onFocus={() => {}}
        loadAiAnalysis={loadAiAnalysis}
        labels={LABELS}
      />,
    );
    expect(loadAiAnalysis).toHaveBeenCalledTimes(3);
  });

  /**
   * Regression for [Reviewer Round 3]: the concurrency cap must be
   * global, not per effect generation. A list rotation that brings
   * a **disjoint** visible set into view while the first batch of
   * AI-analysis lookups is still in flight must not stack a second
   * batch of `AI_ANALYSIS_MAX_IN_FLIGHT` on top of the first — that
   * is the failure mode where `active` was a closure-local variable
   * in each effect run, so the new effect started counting from 0
   * and the new keys were not in `aiInFlightRef` to be skipped.
   */
  it("caps concurrent loadAiAnalysis calls across list rotations to a disjoint set", async () => {
    // First batch: keys 1..AI_ANALYSIS_MAX_IN_FLIGHT.
    const firstBatch: TriageStory[] = Array.from(
      { length: AI_ANALYSIS_MAX_IN_FLIGHT },
      (_, i) => makeStory({ customerId: 7, storyId: `first-${i + 1}` }),
    );
    // Second batch: a completely disjoint set of composite keys.
    // The customerId differs so even a "same storyId" coincidence
    // can't masquerade as a cache hit.
    const secondBatch: TriageStory[] = Array.from(
      { length: AI_ANALYSIS_MAX_IN_FLIGHT },
      (_, i) => makeStory({ customerId: 9, storyId: `second-${i + 1}` }),
    );

    let inFlight = 0;
    let maxInFlight = 0;
    const resolversByKey = new Map<string, () => void>();
    const loadAiAnalysis = vi.fn(
      async (args: { customerId: number; storyId: string }) => {
        inFlight += 1;
        if (inFlight > maxInFlight) maxInFlight = inFlight;
        const key = `${args.customerId}/${args.storyId}`;
        await new Promise<void>((resolve) => {
          resolversByKey.set(key, () => {
            inFlight -= 1;
            resolve();
          });
        });
        return null;
      },
    );

    const { rerender } = render(
      <TriageStoriesView
        stories={firstBatch}
        truncated={false}
        focused={null}
        onFocus={() => {}}
        loadAiAnalysis={loadAiAnalysis}
        labels={LABELS}
      />,
    );

    // Wait for the first effect to dispatch its full slot quota.
    await waitFor(() => {
      expect(loadAiAnalysis).toHaveBeenCalledTimes(AI_ANALYSIS_MAX_IN_FLIGHT);
    });

    // Rotate to a disjoint visible set while the first batch is
    // still in flight. Pre-fix, this would have spawned a second
    // batch of AI_ANALYSIS_MAX_IN_FLIGHT in parallel because the
    // new effect's local `active` started at 0.
    rerender(
      <TriageStoriesView
        stories={secondBatch}
        truncated={false}
        focused={null}
        onFocus={() => {}}
        loadAiAnalysis={loadAiAnalysis}
        labels={LABELS}
      />,
    );

    // Give the new effect a chance to (incorrectly) burst.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // The new effect must not have dispatched anything yet — every
    // slot is still held by the first batch.
    expect(loadAiAnalysis).toHaveBeenCalledTimes(AI_ANALYSIS_MAX_IN_FLIGHT);
    expect(inFlight).toBe(AI_ANALYSIS_MAX_IN_FLIGHT);
    expect(maxInFlight).toBeLessThanOrEqual(AI_ANALYSIS_MAX_IN_FLIGHT);

    // Drain the first batch one at a time. Each release must allow
    // exactly one second-batch request to start, never more, so the
    // global in-flight count stays at the cap until the second batch
    // tails off.
    for (let i = 0; i < AI_ANALYSIS_MAX_IN_FLIGHT; i += 1) {
      const key = `7/first-${i + 1}`;
      const resolve = resolversByKey.get(key);
      await act(async () => {
        resolve?.();
        await Promise.resolve();
      });
      expect(maxInFlight).toBeLessThanOrEqual(AI_ANALYSIS_MAX_IN_FLIGHT);
    }

    // By now every second-batch entry must be in flight (queue
    // drained, all slots still saturated by the second batch).
    expect(loadAiAnalysis).toHaveBeenCalledTimes(2 * AI_ANALYSIS_MAX_IN_FLIGHT);
    expect(inFlight).toBe(AI_ANALYSIS_MAX_IN_FLIGHT);

    // Drain the second batch and assert the cap held throughout.
    for (let i = 0; i < AI_ANALYSIS_MAX_IN_FLIGHT; i += 1) {
      const key = `9/second-${i + 1}`;
      const resolve = resolversByKey.get(key);
      await act(async () => {
        resolve?.();
        await Promise.resolve();
      });
    }
    expect(maxInFlight).toBeLessThanOrEqual(AI_ANALYSIS_MAX_IN_FLIGHT);
    expect(inFlight).toBe(0);
  });
});

/**
 * #653 item 1 acceptance: a Story whose AI-analysis lookup resolves to a
 * negative result (no badge) must be cached as such so a later
 * sort/filter rotation does NOT re-queue it. Before the negative-result
 * cache, only positive summaries were stored — a `null` resolution was
 * dropped, leaving the composite key absent from `aiSummariesRef` and so
 * re-fetched on every rotation (the queue builder skips keys only via
 * the cached-resolution check).
 *
 * The fan-out effect depends on `effectiveStories` (and `loadAiAnalysis`),
 * so a meaningful rotation must change that array's identity while
 * preserving the same composite keys. A new array with the same Stories
 * — the shape a sort re-order or a `refreshStories` resolution produces —
 * re-runs the effect; only the negative-result cache then stops a
 * re-fetch. This would have failed before the cache landed (each Story
 * re-queued, doubling the call count) and passes now.
 */
describe("TriageStoriesView — negative AI-analysis results are cached (#653)", () => {
  it("does not re-queue null-resolving Stories across a list rotation", async () => {
    // Keep the count at the in-flight cap so the whole list fans out in
    // a single wave.
    const stories: TriageStory[] = Array.from(
      { length: AI_ANALYSIS_MAX_IN_FLIGHT },
      (_, i) =>
        makeStory({
          customerId: 7,
          storyId: `n-${i + 1}`,
          lastSentAtIso: null,
          sendCount: 0,
        }),
    );

    // Every lookup resolves to a negative result (no badge).
    const loadAiAnalysis = vi.fn(
      async (_args: { customerId: number; storyId: string }) => null,
    );

    const view = (rows: TriageStory[]) => (
      <TriageStoriesView
        stories={rows}
        truncated={false}
        focused={null}
        onFocus={() => {}}
        loadAiAnalysis={loadAiAnalysis}
        labels={LABELS}
      />
    );

    const { rerender } = render(view(stories));

    // Initial fan-out: exactly one call per Story.
    await waitFor(() => {
      expect(loadAiAnalysis).toHaveBeenCalledTimes(stories.length);
    });

    // Rotate the list: a new array reference carrying the same Stories
    // (in a different order, as a sort toggle / refresh would). This
    // re-runs the fan-out effect because `effectiveStories` identity
    // changed; the negative-result cache is the only thing that keeps it
    // from re-queuing every key.
    const rotated = [...stories].reverse();
    rerender(view(rotated));
    // Let any (erroneously) re-queued fetch chains settle.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // The fetcher must still have been called exactly once per Story —
    // no rotation-driven re-fetch of the cached negatives.
    expect(loadAiAnalysis).toHaveBeenCalledTimes(stories.length);
    const calledKeys = loadAiAnalysis.mock.calls.map(
      (c) => `${c[0].customerId}/${c[0].storyId}`,
    );
    // Once per unique composite key — no duplicates.
    expect(new Set(calledKeys).size).toBe(stories.length);
    expect(calledKeys.sort()).toEqual(
      stories.map((s) => `${s.customerId}/${s.storyId}`).sort(),
    );
  });

  // The `null` channel also absorbs transient failures (network error,
  // session lapse, upstream outage all surface as `null`). Caching those
  // forever would hide a badge for the rest of the view, so a negative
  // resolution expires after `AI_ANALYSIS_NEGATIVE_TTL_MS` and the next
  // rotation re-fetches it. Drive `Date.now` past the TTL and assert the
  // rotation re-queues every stale negative.
  it("re-queues cached negatives once the TTL lapses", async () => {
    const base = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(base);

    const stories: TriageStory[] = Array.from(
      { length: AI_ANALYSIS_MAX_IN_FLIGHT },
      (_, i) =>
        makeStory({
          customerId: 7,
          storyId: `t-${i + 1}`,
          lastSentAtIso: null,
          sendCount: 0,
        }),
    );
    const loadAiAnalysis = vi.fn(
      async (_args: { customerId: number; storyId: string }) => null,
    );
    const view = (rows: TriageStory[]) => (
      <TriageStoriesView
        stories={rows}
        truncated={false}
        focused={null}
        onFocus={() => {}}
        loadAiAnalysis={loadAiAnalysis}
        labels={LABELS}
      />
    );

    const { rerender } = render(view(stories));
    await waitFor(() => {
      expect(loadAiAnalysis).toHaveBeenCalledTimes(stories.length);
    });

    // `waitFor` above only proves the calls were *issued* — each fetch's
    // `.then`/`.finally` (which caches the negative and clears
    // `aiInFlightRef`) still runs a microtask later. Let the initial wave
    // fully settle before rotating: a rotation that races a still-in-flight
    // key is skipped by the next effect generation (it sees the key in
    // `aiInFlightRef`), so that key gets freshly cached instead of
    // re-queued and the wave stalls below `2 * stories.length`. Flushing a
    // macrotask drains all pending microtasks deterministically — without
    // it the assertion is flaky under CI load (observed stalling at 7/12).
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // Advance the clock past the negative-cache TTL, then rotate.
    nowSpy.mockReturnValue(base + AI_ANALYSIS_NEGATIVE_TTL_MS + 1);
    rerender(view([...stories].reverse()));

    // Every stale negative is re-queued exactly once more. The re-queued
    // fetches drain through the in-flight cap over several microtask turns,
    // so poll until the full wave settles rather than flushing a fixed
    // number of ticks (which races the cap under load).
    await waitFor(() => {
      expect(loadAiAnalysis).toHaveBeenCalledTimes(2 * stories.length);
    });
    nowSpy.mockRestore();
  });

  // A successful Send-to-aimer-web can produce a fresh analysis upstream.
  // The Story must be re-fetched eagerly so a newly available badge is
  // not held back by the cached negative until the next rotation / TTL
  // (#653 item 1, force-refresh invalidation seam).
  it("re-fetches a Story's summary after a successful send", async () => {
    manualSendToAimerWebMock.mockResolvedValue({
      lastSentAtIso: "2026-05-17T12:00:00.000Z",
      sendCount: 1,
      duplicatesSkipped: 0,
    });

    const story = makeStory({
      customerId: 7,
      storyId: "1",
      lastSentAtIso: null,
      sendCount: 0,
    });
    // First lookup (initial fan-out) resolves to no badge; the second
    // (post-send re-fetch) returns a positive summary.
    let call = 0;
    const loadAiAnalysis = vi.fn(
      async (_args: { customerId: number; storyId: string }) => {
        call += 1;
        if (call === 1) return null;
        return {
          tier: "HIGH" as const,
          href: "https://aimer.example.com/analysis/story/1",
          severityScore: 0.6,
          likelihoodScore: 0.5,
          scoreKind: "leaf" as const,
        };
      },
    );

    render(
      <TriageStoriesView
        stories={[story]}
        truncated={false}
        aimerIntegrationConfigured={true}
        focused={null}
        onFocus={() => {}}
        loadAiAnalysis={loadAiAnalysis}
        labels={LABELS}
      />,
    );

    // Initial fan-out: one negative resolution, no badge.
    await waitFor(() => {
      expect(loadAiAnalysis).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByTestId("triage-story-ai-analysis-badge")).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByTestId("triage-story-send"));
    });

    // The send triggers a re-fetch that now resolves positive; the badge
    // appears without any list rotation.
    await waitFor(() => {
      expect(loadAiAnalysis).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(screen.getByTestId("triage-story-ai-analysis-badge")).toBeTruthy();
    });
  });

  // Regression for [Reviewer Round 2]: the post-send re-fetch must survive
  // the in-flight window. If the operator clicks Send while the initial
  // fan-out read for the card is still on the wire, the forced refresh used
  // to be skipped (key already reserved in `aiInFlightRef`), letting the
  // pre-send read — issued before the send produced its analysis — resolve
  // to a stale negative and hide a freshly produced badge until the next
  // rotation / TTL. The refresh is now deferred behind the in-flight read
  // and re-armed from its `.finally`, so the post-send read still happens.
  it("re-fetches after a send issued while the initial read is in flight", async () => {
    manualSendToAimerWebMock.mockResolvedValue({
      lastSentAtIso: "2026-05-17T12:00:00.000Z",
      sendCount: 1,
      duplicatesSkipped: 0,
    });

    const story = makeStory({
      customerId: 7,
      storyId: "1",
      lastSentAtIso: null,
      sendCount: 0,
    });

    const positive = {
      tier: "HIGH" as const,
      href: "https://aimer.example.com/analysis/story/1",
      severityScore: 0.6,
      likelihoodScore: 0.5,
      scoreKind: "leaf" as const,
    };
    // The first (initial fan-out) read is held open so we can click Send
    // while it is still in flight; it later resolves to a stale negative.
    // The second (deferred post-send refresh) read resolves positive.
    let call = 0;
    let resolveFirst: ((value: typeof positive | null) => void) | undefined;
    const loadAiAnalysis = vi.fn(
      async (_args: { customerId: number; storyId: string }) => {
        call += 1;
        if (call === 1) {
          return await new Promise<typeof positive | null>((resolve) => {
            resolveFirst = resolve;
          });
        }
        return positive;
      },
    );

    render(
      <TriageStoriesView
        stories={[story]}
        truncated={false}
        aimerIntegrationConfigured={true}
        focused={null}
        onFocus={() => {}}
        loadAiAnalysis={loadAiAnalysis}
        labels={LABELS}
      />,
    );

    // The initial read is on the wire (held), so no badge yet.
    await waitFor(() => {
      expect(loadAiAnalysis).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByTestId("triage-story-ai-analysis-badge")).toBeNull();

    // Click Send while that read is still unresolved. The post-send refresh
    // must be deferred (not dropped) behind the in-flight key, so no second
    // read fires yet.
    await act(async () => {
      fireEvent.click(screen.getByTestId("triage-story-send"));
    });
    expect(loadAiAnalysis).toHaveBeenCalledTimes(1);

    // Let the pre-send read resolve to a stale negative. Its `.finally`
    // re-arms the deferred refresh, which fires the second read.
    await act(async () => {
      resolveFirst?.(null);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(loadAiAnalysis).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(screen.getByTestId("triage-story-ai-analysis-badge")).toBeTruthy();
    });
  });
});
