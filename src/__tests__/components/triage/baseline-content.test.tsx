/**
 * Direct coverage for {@link TriageBaselineContent}. The wrapper
 * `TriageShell` tests pin the period-change + Tier 2 wiring; this
 * file pins the multi-customer behaviors that only become visible
 * when the loaded result carries assets from more than one tenant.
 */

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/triage",
  useSearchParams: () => new URLSearchParams(),
}));

const storyActionsMocks = vi.hoisted(() => ({
  fetchStoryDetail: vi.fn(),
  refreshTriageStories: vi.fn(),
  submitSaveAnalystCuratedStory: vi.fn(),
}));

vi.mock("@/app/[locale]/(dashboard)/triage/story-actions", () => ({
  fetchStoryDetail: storyActionsMocks.fetchStoryDetail,
  refreshTriageStories: storyActionsMocks.refreshTriageStories,
  submitSaveAnalystCuratedStory:
    storyActionsMocks.submitSaveAnalystCuratedStory,
}));

// #571 R4: the periodic-drain controller is mounted from baseline-
// content; mock it so the focused scope test below can observe what
// (kind, customerId) tuples the component spins up controllers for
// without standing up a real fetch transport.
const createPeriodicDrainMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/aimer/phase2/transport.client", () => ({
  createPeriodicDrain: createPeriodicDrainMock,
}));

// #588 R4: the client emit must choose `pivotValueJoinId` for natural-
// join dimensions (sameSensor / learningMethods / port / …) and
// `pivotValue` for raw-ish dimensions. Mock the engagement module so
// the focused test below can observe the wire shape without standing
// up a real fetch transport.
const postEngagementActionMock = vi.hoisted(() => vi.fn());
const postImpressionBatchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/triage/engagement", async () => {
  const types = await vi.importActual<
    typeof import("@/lib/triage/engagement/types")
  >("@/lib/triage/engagement/types");
  return {
    ...types,
    postEngagementAction: postEngagementActionMock,
    postImpressionBatch: postImpressionBatchMock,
  };
});

import {
  TriageBaselineContent,
  type TriageBaselineLabels,
} from "@/components/triage/baseline-content";
import type {
  ScoredTriageEvent,
  TriageAsset,
  TriageLoadResult,
} from "@/lib/triage";
import { PIVOT_DIMENSIONS, type PivotDimensionId } from "@/lib/triage/pivot";
import type {
  TriageStory,
  TriageStoryMemberDetail,
} from "@/lib/triage/story/types";

function dimensionsMap(prefix: string): Record<PivotDimensionId, string> {
  const out = {} as Record<PivotDimensionId, string>;
  for (const dim of PIVOT_DIMENSIONS) out[dim.id] = `${prefix}:${dim.id}`;
  return out;
}

const LABELS: TriageBaselineLabels = {
  funnel: {
    title: "Funnel",
    detected: "Detected",
    triaged: "Triaged",
    triagedHint: "triaged hint",
    shown: "Shown",
    shownHint: "shown hint",
    passThrough: "Pass-through",
    passThroughHint: "hint",
  },
  assetList: {
    title: "Assets",
    empty: "No assets",
    addressColumn: "Address",
    scoreColumn: "Score",
    triagedColumn: "Triaged",
    detectedColumn: "Detected",
    detectedOver30dHint: "(over last 30d)",
    rowDetailsTemplate: "row-{address}",
  },
  assetDetail: {
    title: "Asset detail",
    pivotFocusTitle: "Pivot focus",
    customerLabel: "Customer",
    emptySelection: "Select an asset",
    emptyEvents: "No events",
    scoreLabel: "Score",
    triagedLabel: "Triaged",
    detectedLabel: "Detected",
    eventsHeading: "Events",
    timeColumn: "Time",
    kindColumn: "Kind",
    categoryColumn: "Category",
    scoreColumn: "Score",
    protectedByStoryMarker: {
      template: "Kept because of Story membership (score: {score})",
    },
  },
  pivotPanel: {
    title: "Related events",
    empty: "No related events",
    truncatedHint: "truncated",
    noFocusHint: "Select an asset",
    showMore: "Show more",
    showLess: "Show less",
    showingOfTemplate: "Showing {visible} of {total}",
    pivotActionTemplate: "Pivot to {dimension}: {value}",
    focusValuesTemplate: "Focus: {values}",
    family: {
      network: "Network",
      application: "Application",
      tls: "TLS",
      dns: "DNS",
      "time-structure": "Time/structure",
      "tier2-only": "Tier 2 only",
    },
    dimensions: dimensionsMap("Dim"),
    timeColumn: "Time",
    kindColumn: "Kind",
    scoreColumn: "Score",
    pivotColumn: "Pivot",
    weakSignal: {
      badge: "weak",
      hint: "Tier 2 only",
    },
  },
  pivotBreadcrumb: {
    ariaLabel: "Pivot trail",
    rootCrumbPrefix: "Asset",
    dimensionCrumbTemplate: "{dimension}: {value}",
    dimensions: dimensionsMap("Crumb"),
  },
  tier2Modal: {
    title: "Fetch large result?",
    descriptionTemplate: "{count} > {threshold}",
    descriptionApproximateTemplate: "≥ {count} (over {threshold})",
    descriptionUnknown: "Projection unknown",
    confirm: "Fetch",
    cancel: "Cancel",
  },
  tier2Eviction: {
    template: "evicted {dimension}: {value}",
    dismiss: "Dismiss",
    dimensions: dimensionsMap("Dim"),
  },
  tier2Error: {
    template: "error {dimension}: {value} — {message}",
    fallbackMessage: "no message",
    dismiss: "Dismiss",
    dimensions: dimensionsMap("Dim"),
  },
  tier2Progress: {
    progress: "Fetching…",
    progressTemplate: "Fetching {dimension}: {value}…",
    dimensions: dimensionsMap("Dim"),
  },
  staleHashFallback: "Stale hash — showing asset root",
  sensorScopeForbiddenFallback:
    "Sensor no longer accessible — showing asset root",
  tabStrip: {
    legend: "Triage views",
    assetList: "Asset list",
    stories: "Stories",
    pivot: "Pivot",
  },
  stories: {
    heading: "Stories",
    empty: "No stories",
    truncatedTemplate: "Truncated",
    emptyUnsentOnly: "No unsent",
    showOnlyUnsentLabel: "Unsent only",
    sortLabel: "Sort",
    sortByTimeWindowEnd: "Recent",
    sortByScore: "Score",
    staleHashFallback: "Stale story",
    card: {
      ruleBadgeAuto: "auto",
      ruleBadgeAnalyst: "analyst",
      scoreLabel: "Score",
      memberCountTemplate: "{count} events",
      open: "Open",
      sendToAimerWeb: "Send",
      sendToAimerWebTooltip: "not yet",
      sentIndicatorTemplate: "Sent {relative}",
      sentMultiTemplate: "{count}×",
      timeColumn: "Time",
      kindColumn: "Kind",
      categoryColumn: "Category",
      topMembersHeading: "Top",
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
      heading: "Detail",
      emptySelection: "Pick",
      emptyMembers: "Empty",
      customerLabel: "Customer",
      scoreLabel: "Score",
      ruleLabel: "Rule",
      danglingNoticeTemplate: "{shown}/{stored} (aged {aged})",
      timeColumn: "Time",
      kindColumn: "Kind",
      categoryColumn: "Category",
      scoreColumn: "Score",
      loading: "Loading",
      close: "Close",
      pivotActionsColumn: "Pivot",
      pivotActionTemplate: "Pivot to {dimension}: {value}",
      pivotDimensions: dimensionsMap("Dim"),
    },
  },
  saveAsStory: {
    button: "Save as Story",
    disabledMultiCustomer: "narrow first",
    modalTitle: "Save",
    titleLabel: "Title",
    titlePlaceholder: "placeholder",
    membersHeading: "Members",
    confirm: "Confirm",
    cancel: "Cancel",
    successToast: "Saved",
    errorOverCap: "over",
    errorEmpty: "empty",
    errorMemberNotFound: "missing",
    errorAssetMismatch: "mismatch",
    errorCustomerOutOfScope: "scope",
    errorMultiCustomer: "multi",
    errorGeneric: "generic",
  },
};

const PERIOD = {
  startIso: "2026-05-08T00:00:00.000Z",
  endIso: "2026-05-09T00:00:00.000Z",
};

function makeEvent(
  customerId: number,
  hostValue: string,
  eventId: string,
  timeOffsetSec: number,
): ScoredTriageEvent {
  return {
    __typename: "BlocklistHttp",
    id: eventId,
    time: new Date(Date.UTC(2026, 4, 8, 12, 0, timeOffsetSec)).toISOString(),
    sensor: "sensor-a",
    category: "EXFILTRATION",
    level: null,
    origAddr: "10.0.0.1",
    host: hostValue,
    score: 1,
    customerId,
    rowKey: `${customerId}/${eventId}`,
  };
}

function makeMultiCustomerResult(): TriageLoadResult {
  // Two customers hosting the SAME RFC1918 address. Each customer
  // contributes:
  //   - A per-customer-unique host event (so the host pivot section
  //     has a focus value when the operator selects that customer's
  //     asset).
  //   - A `shared.example` host event (so pivoting onto
  //     `host=shared.example` surfaces the OTHER customer's events
  //     in the focus set — that pivot triggers the synthetic
  //     pivotFocusAsset render whose customerName label is what this
  //     test pins).
  const assetAEvents: ScoredTriageEvent[] = [
    makeEvent(7, "host-acme.example", "acme-1", 0),
    makeEvent(7, "shared.example", "acme-2", 1),
  ];
  const assetBEvents: ScoredTriageEvent[] = [
    makeEvent(8, "host-beta.example", "beta-1", 2),
    makeEvent(8, "shared.example", "beta-2", 3),
  ];
  const assetA: TriageAsset = {
    customerId: 7,
    customerName: "Acme",
    address: "10.0.0.1",
    detectedCount: 2,
    detectedCountUnavailable: false,
    triagedCount: 2,
    score: 2,
    lastEventTimeIso: assetAEvents[1].time,
    events: assetAEvents,
  };
  const assetB: TriageAsset = {
    customerId: 8,
    customerName: "Beta",
    address: "10.0.0.1",
    detectedCount: 2,
    detectedCountUnavailable: false,
    triagedCount: 2,
    score: 2,
    lastEventTimeIso: assetBEvents[1].time,
    events: assetBEvents,
  };
  return {
    funnel: { detected: 4, triaged: 4, shown: 4, passThroughRate: 1 },
    assets: [assetA, assetB],
    truncated: false,
    storyProtectedTruncated: false,
    storyProtectedDroppedCount: 0,
    eligibleByStop: {},
    loadedEventCount: 4,
    events: [...assetAEvents, ...assetBEvents],
    observedDenominatorTruncated: false,
    freshness: { worst: null, customers: [] },
    strictness: "top50",
    // #589 / RFC 0003 §2.2: row-bound engagement actions
    // (`pivot_click`, `story_pivot_click`) require `menuLoadId` so
    // the §7 aggregate's `(menu_load_id, event_key)` JOIN can
    // recover the impression's authoritative `slot_bucket`. The
    // production loader always emits one; the test fixture mirrors
    // that so pivot-click capture tests post their action.
    menuLoadId: "00000000-0000-4000-8000-000000000001",
  };
}

describe("TriageBaselineContent — multi-customer pivot focus", () => {
  it("shows the SELECTED asset's customerName on the pivot-focus detail header (not the page's first asset)", () => {
    // Regression for Round 2 Item 2: the synthetic `pivotFocusAsset`
    // previously sourced its `customerName` from `initialFocus`, which
    // is always `result.assets[0]`. After selecting a non-first row
    // and pivoting away from the asset crumb, the header would
    // continue to display the first customer's name. The fix derives
    // the synthetic row's customer from the current trail's asset
    // crumb (set by `onSelectAsset`).
    render(
      <TriageBaselineContent
        result={makeMultiCustomerResult()}
        resetSignal={0}
        period={PERIOD}
        scope="tier1"
        mode="baseline"
        labels={LABELS}
      />,
    );

    // Initial state: first asset (Acme) is the default selection, so
    // the detail header shows "Customer: Acme".
    expect(screen.getByText("Acme")).toBeTruthy();

    // Select the SECOND row (Beta). `rowDetailsTemplate` is
    // `row-{address}`; both assets share the same address, so the two
    // rows produce identical accessible names. Pick by index.
    const rows = screen.getAllByRole("button", { name: "row-10.0.0.1" });
    expect(rows).toHaveLength(2);
    fireEvent.click(rows[1]);

    // After selection, the detail header reflects Beta.
    expect(screen.getByText("Beta")).toBeTruthy();

    // Switch to the Pivot tab — Round 4 split moved the pivot
    // breadcrumb/panel off the Asset list tab; the pivot button is
    // only rendered when the analyst is on the Pivot peer view.
    fireEvent.click(screen.getByTestId("triage-tab-pivot"));

    // Pivot to host=shared.example — that value appears on both
    // Beta's focus event AND on the (non-focus) Acme event, so the
    // pivot panel renders an Acme row whose pivot button targets
    // `shared.example`. Clicking it activates the synthetic
    // pivotFocusAsset. The header must keep showing Beta — Beta is
    // the trail's asset crumb (the operator's selection), even
    // though the pivot's focusEvents now span both customers.
    fireEvent.click(
      screen.getByRole("button", {
        name: "Pivot to Dim:host: shared.example",
      }),
    );
    expect(screen.getByText("Beta")).toBeTruthy();
    expect(screen.queryByText("Acme")).toBeNull();
  });
});

describe("TriageBaselineContent — Asset list vs Pivot peer view isolation", () => {
  it("clears the pivot-focus override from the detail panel when the user switches back to Asset list", () => {
    // Round 5 finding: the Round 4 split hid the breadcrumb / related-
    // events panel outside the Pivot tab, but the right-hand detail
    // panel still preferred `pivotFocusAsset` regardless of tab. As a
    // peer view, Asset list must reflect the selected asset row, not
    // the now-hidden pivot focus.
    render(
      <TriageBaselineContent
        result={makeMultiCustomerResult()}
        resetSignal={0}
        period={PERIOD}
        scope="tier1"
        mode="baseline"
        labels={LABELS}
      />,
    );

    // Select Beta and pivot on the shared host so a pivotFocusAsset is
    // active.
    const rows = screen.getAllByRole("button", { name: "row-10.0.0.1" });
    fireEvent.click(rows[1]);
    fireEvent.click(screen.getByTestId("triage-tab-pivot"));
    fireEvent.click(
      screen.getByRole("button", {
        name: "Pivot to Dim:host: shared.example",
      }),
    );
    // On the Pivot tab the detail header carries the pivot-focus title.
    expect(screen.getByText("Pivot focus")).toBeTruthy();

    // Switch back to Asset list. The detail panel must drop the
    // pivot-focus override and reflect the selected asset row instead.
    fireEvent.click(screen.getByTestId("triage-tab-asset-list"));
    expect(screen.queryByText("Pivot focus")).toBeNull();
    expect(screen.getByText("Asset detail")).toBeTruthy();
    // The selected asset (Beta) still shows in the header — the trail
    // is preserved across tab toggles, just not surfaced as a focus.
    expect(screen.getByText("Beta")).toBeTruthy();
  });
});

function makeStory(overrides: Partial<TriageStory> = {}): TriageStory {
  return {
    customerId: 9,
    customerName: "Gamma Corp",
    storyId: "42",
    kind: "auto_correlated",
    ruleId: "R1",
    storyVersion: "v1",
    timeWindowStartIso: "2026-05-08T12:00:00.000Z",
    timeWindowEndIso: "2026-05-08T12:30:00.000Z",
    primaryAsset: "10.0.0.9",
    score: 4.25,
    summary: {
      kindHistogram: { HttpThreat: 1 },
      categoryHistogram: { IMPACT: 1 },
      memberCount: 1,
      durationMs: 0,
      distinctAssetCount: 1,
      topRawScore: 4.5,
    },
    createdAtIso: "2026-05-08T12:31:00.000Z",
    lastSentAtIso: null,
    sendCount: 0,
    topMembers: [
      {
        eventKey: "m1",
        eventTimeIso: "2026-05-08T12:10:00.000Z",
        kind: "HttpThreat",
        category: "IMPACT",
        rawScore: 4.5,
      },
    ],
    ...overrides,
  };
}

function makeStoryMember(
  overrides: Partial<TriageStoryMemberDetail> = {},
): TriageStoryMemberDetail {
  return {
    eventKey: "m1",
    eventTimeIso: "2026-05-08T12:10:00.000Z",
    kind: "HttpThreat",
    sensor: "sensor-a",
    origAddr: "10.0.0.9",
    respAddr: "203.0.113.4",
    origPort: 12345,
    respPort: 443,
    host: "story-host.example",
    dnsQuery: null,
    uri: null,
    category: "IMPACT",
    baselineScore: 0.91,
    baselineVersion: "v1",
    protectedByStory: false,
    ...overrides,
  };
}

describe("TriageBaselineContent — Story-origin pivot focus customer label (#553)", () => {
  afterEach(() => {
    storyActionsMocks.fetchStoryDetail.mockReset();
    storyActionsMocks.refreshTriageStories.mockReset();
    storyActionsMocks.submitSaveAnalystCuratedStory.mockReset();
  });

  it("derives the synthetic pivot-focus customerName from the Story origin, not from the asset-root fallback", async () => {
    // Reviewer Round 1 Item 1: a Story-origin trail has no asset
    // crumb, so the previous `assetCrumb?.customerId ?? 0` fallback
    // labeled every Story-origin pivot focus as customer `0`. The fix
    // resolves the customer label from the matching Story (here
    // "Gamma Corp"), not the asset crumb.
    const story = makeStory();
    const member = makeStoryMember();
    storyActionsMocks.fetchStoryDetail.mockResolvedValue({
      members: [member],
      hasDanglingMembers: false,
      storedMemberCount: 1,
    });

    await act(async () => {
      render(
        <TriageBaselineContent
          result={makeMultiCustomerResult()}
          resetSignal={0}
          period={PERIOD}
          scope="tier1"
          mode="baseline"
          stories={[story]}
          labels={LABELS}
        />,
      );
    });

    // Drive the Pivot-from-Story flow: open the story card, wait for
    // the per-row pivot button, then click the host pivot.
    fireEvent.click(screen.getByTestId("triage-tab-stories"));
    await act(async () => {
      fireEvent.click(screen.getByText(LABELS.stories.card.open));
    });
    await waitFor(() => {
      expect(storyActionsMocks.fetchStoryDetail).toHaveBeenCalled();
    });
    // Flush microtasks so the loader's `.then(...)` lands and the
    // detail status flips to "ready" — only then does the per-row
    // pivot actions column render.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    let pivotButton: HTMLElement | null = null;
    await waitFor(() => {
      const buttons = screen.queryAllByTestId(
        "triage-story-member-pivot-action",
      );
      pivotButton =
        buttons.find((b) => b.getAttribute("data-dimension") === "host") ??
        null;
      expect(pivotButton).not.toBeNull();
    });
    if (!pivotButton) throw new Error("pivot button never rendered");
    await act(async () => {
      fireEvent.click(pivotButton as HTMLElement);
    });

    // Pivot tab is active, and the detail header reads the Story
    // origin's customerName (Gamma Corp), not "0" — the asset crumb
    // is intentionally absent on a Story-origin trail.
    expect(screen.getByText("Pivot focus")).toBeTruthy();
    expect(screen.getByText("Gamma Corp")).toBeTruthy();
    expect(screen.queryByText("Customer: 0")).toBeNull();
  });
});

describe("TriageBaselineContent — Story-origin hash-restore cancellation (#553)", () => {
  afterEach(() => {
    storyActionsMocks.fetchStoryDetail.mockReset();
    storyActionsMocks.refreshTriageStories.mockReset();
    storyActionsMocks.submitSaveAnalystCuratedStory.mockReset();
    window.location.hash = "";
  });

  it("ignores a late `fetchStoryDetail` rejection after the user has navigated away from the restored state", async () => {
    // Reviewer Round 1 Item 2: the Story-origin hash restore awaits
    // `fetchStoryDetail` and its `.then` / `.catch` branches
    // unconditionally rewrote `pivotOrigin` / `trail` / `tab` after
    // resolve. A slow restore could therefore overwrite a fresh
    // asset selection. `abortHashRestore()` now bumps a token that
    // the resolve branches check before applying any state.
    window.location.hash =
      "#triage.tab=pivot&triage.pivot.story=9/42&triage.pivot.step=host:story-host.example";

    // Promise that never resolves until we explicitly reject below —
    // the user's asset click must happen WHILE the fetch is still
    // pending so the cancellation guard is the only mechanism
    // preventing the late branch from overwriting the new state.
    let rejectStory: (err: Error) => void = () => {};
    const storyPromise = new Promise<null>((_, reject) => {
      rejectStory = reject;
    });
    storyActionsMocks.fetchStoryDetail.mockReturnValue(storyPromise);

    await act(async () => {
      render(
        <TriageBaselineContent
          result={makeMultiCustomerResult()}
          resetSignal={0}
          period={PERIOD}
          scope="tier1"
          mode="baseline"
          stories={[]}
          labels={LABELS}
        />,
      );
    });

    // Hash restore seeds Pivot tab synchronously. The detail panel
    // still renders (asset-rooted fallback is suppressed for Story
    // origin), but the header is empty until the fetch resolves.
    expect(screen.getByTestId("triage-tab-pivot")).toBeTruthy();

    // User abandons the restored state: switch back to Asset list and
    // pick the second asset (Beta). `onSelectAsset` calls
    // `abortHashRestore()`, which bumps the cancellation token.
    fireEvent.click(screen.getByTestId("triage-tab-asset-list"));
    const rows = screen.getAllByRole("button", { name: "row-10.0.0.1" });
    fireEvent.click(rows[1]);
    expect(screen.getByText("Beta")).toBeTruthy();

    // Now resolve the deferred `fetchStoryDetail` with a rejection —
    // the `.catch` branch would otherwise reset state to
    // `initialFocus` (Acme) and surface the stale-hash banner.
    await act(async () => {
      rejectStory(new Error("simulated late rejection"));
      await Promise.resolve();
      await Promise.resolve();
    });

    // The user's selection survives: Beta still shows, Acme does not,
    // and the stale-hash banner did not appear.
    expect(screen.getByText("Beta")).toBeTruthy();
    expect(screen.queryByText("Acme")).toBeNull();
    expect(screen.queryByText(LABELS.staleHashFallback)).toBeNull();
  });
});

describe("TriageBaselineContent — Story-origin lifts Tier 2 onto member corpus (#561)", () => {
  afterEach(() => {
    storyActionsMocks.fetchStoryDetail.mockReset();
    storyActionsMocks.refreshTriageStories.mockReset();
    storyActionsMocks.submitSaveAnalystCuratedStory.mockReset();
  });

  it("renders the Tier 2 Learning method + Keywords sections on a Story-origin pivot panel", async () => {
    // Per #561 (supersedes the #559 Round 2 Item 1 suppression): the
    // static Tier 2 sections (Learning method, Keywords) now render
    // under a Story-origin trail because the dispatch is bounded by
    // the Story corpus seed. Clicking them issues a Tier 2 fetch
    // through the member-keyed resolver against the Story's member
    // event-key set, not the asset's period-wide events. This test
    // pins the panel-level reachability — the resolver-side cohort
    // walk is covered in the tier2-fetch impl tests.
    const story = makeStory();
    const member = makeStoryMember();
    storyActionsMocks.fetchStoryDetail.mockResolvedValue({
      members: [member],
      hasDanglingMembers: false,
      storedMemberCount: 1,
    });
    // Augment LABELS with the optional Tier 2 static-section labels —
    // without these the panel hides the sections regardless of scope,
    // which would mask the gating logic under test. The
    // `dimensionsMap` helper at the top of the file iterates
    // PIVOT_DIMENSIONS only; the static-options dimensions
    // (`learningMethods`, `keywords`) have no entry there, so the
    // dimension labels are added explicitly here.
    const tier2Labels: TriageBaselineLabels = {
      ...LABELS,
      pivotPanel: {
        ...LABELS.pivotPanel,
        dimensions: {
          ...LABELS.pivotPanel.dimensions,
          learningMethods: "Dim:learningMethods",
          keywords: "Dim:keywords",
        },
        learningMethodValues: {
          UNSUPERVISED: "Unsupervised",
          SEMI_SUPERVISED: "Semi-supervised",
        },
        keywords: {
          hint: "Free-text search",
          inputLabel: "Keyword",
          inputPlaceholder: "Type a keyword",
          submit: "Search",
          recentHeading: "Recent",
          recentChipTemplate: "Search again for {value}",
          errorEmpty: "Enter a non-empty keyword.",
          errorTooLongTemplate: "Keyword too long — under {max} characters.",
        },
      },
    };

    await act(async () => {
      render(
        <TriageBaselineContent
          result={makeMultiCustomerResult()}
          resetSignal={0}
          period={PERIOD}
          scope="tier2"
          mode="baseline"
          stories={[story]}
          labels={tier2Labels}
        />,
      );
    });

    // Sanity-check the precondition: with an asset-rooted Tier 2 panel,
    // the Learning method + Keywords sections render. (This is the
    // baseline that would be wrong if the gate fired on the asset root.)
    fireEvent.click(screen.getByTestId("triage-tab-pivot"));
    expect(screen.getByText("Dim:learningMethods")).toBeTruthy();
    expect(screen.getByLabelText("Keyword")).toBeTruthy();

    // Drive the Pivot-from-Story flow.
    fireEvent.click(screen.getByTestId("triage-tab-stories"));
    await act(async () => {
      fireEvent.click(screen.getByText(LABELS.stories.card.open));
    });
    await waitFor(() => {
      expect(storyActionsMocks.fetchStoryDetail).toHaveBeenCalled();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    let pivotButton: HTMLElement | null = null;
    await waitFor(() => {
      const buttons = screen.queryAllByTestId(
        "triage-story-member-pivot-action",
      );
      pivotButton =
        buttons.find((b) => b.getAttribute("data-dimension") === "host") ??
        null;
      expect(pivotButton).not.toBeNull();
    });
    if (!pivotButton) throw new Error("pivot button never rendered");
    await act(async () => {
      fireEvent.click(pivotButton as HTMLElement);
    });

    // Story-origin trail is active on the Pivot peer view. Per #561
    // the Tier 2 static sections REMAIN visible — clicking them now
    // dispatches against the Story member corpus via the member-keyed
    // resolver, so the affordances are no longer no-ops.
    expect(screen.getByText("Dim:learningMethods")).toBeTruthy();
    expect(screen.getByLabelText("Keyword")).toBeTruthy();
  });
});

describe("TriageBaselineContent — Story-origin Tier 2 hash restore (#561)", () => {
  afterEach(() => {
    storyActionsMocks.fetchStoryDetail.mockReset();
    storyActionsMocks.refreshTriageStories.mockReset();
    storyActionsMocks.submitSaveAnalystCuratedStory.mockReset();
    window.location.hash = "";
  });

  it("restores a Story-origin trail with a static Tier 2 step (`learningMethods`) without clearing the trail", async () => {
    // Per #561 the static Tier 2 sections (Learning method, Keywords)
    // are reachable from a Pivot-from-Story state. A URL captured
    // after clicking one of those sections must restore — not be
    // rejected as stale just because the static dim has no
    // `PivotDimension` extractor (the previous Story-restore branch
    // called `getPivotDimension` unconditionally and cleared the trail
    // on the throw). The restore validation now mirrors the asset
    // path: static / Tier 2-only / server-filtered dims skip the
    // corpus-presence check in Tier 2 mode and rely on the queued
    // cohort fetch to populate.
    //
    // Render with `scope="tier1"` to keep the queued cohort fetch
    // un-drained — the parent owns the scope flip via
    // `onScopeRestoredFromHash` and there is no real fetch path in
    // jsdom. The validation contract under test fires synchronously
    // before any drain, so the stale-hash absence + the surviving
    // crumb pin the behavior regardless of dispatch.
    window.location.hash =
      "#triage.tab=pivot&triage.pivot.story=9/42" +
      "&triage.pivot.mode=tier2" +
      "&triage.pivot.step=learningMethods:UNSUPERVISED";
    storyActionsMocks.fetchStoryDetail.mockResolvedValue({
      members: [makeStoryMember()],
      hasDanglingMembers: false,
      storedMemberCount: 1,
    });

    await act(async () => {
      render(
        <TriageBaselineContent
          result={makeMultiCustomerResult()}
          resetSignal={0}
          period={PERIOD}
          scope="tier1"
          mode="baseline"
          stories={[makeStory()]}
          labels={LABELS}
        />,
      );
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // Trail validation succeeded: the static Tier 2 step is NOT
    // treated as stale. (Pre-#561 the trail was cleared and the
    // stale-hash toast surfaced because `getPivotDimension` threw on
    // the static id.) The breadcrumb still carries the restored
    // crumb's value, and the stale-hash toast is absent.
    expect(screen.queryByText(LABELS.staleHashFallback)).toBeNull();
    expect(screen.getByText(/UNSUPERVISED/)).toBeTruthy();
  });

  it("clears the trail and surfaces the stale-hash notice when a Tier 1 step value is absent from the Story member set", async () => {
    // The other half of the validation contract: a step that is NOT
    // server-filtered / Tier 2-only must still be present in the
    // cohort. A `host` value the cohort cannot back is genuinely
    // stale, same as the pre-#561 behavior — the restore now uses
    // the asset-path validation pattern uniformly so this case keeps
    // its expected behavior.
    window.location.hash =
      "#triage.tab=pivot&triage.pivot.story=9/42" +
      "&triage.pivot.step=host:nope.example";
    storyActionsMocks.fetchStoryDetail.mockResolvedValue({
      members: [makeStoryMember({ host: "story-host.example" })],
      hasDanglingMembers: false,
      storedMemberCount: 1,
    });

    await act(async () => {
      render(
        <TriageBaselineContent
          result={makeMultiCustomerResult()}
          resetSignal={0}
          period={PERIOD}
          scope="tier1"
          mode="baseline"
          stories={[makeStory()]}
          labels={LABELS}
        />,
      );
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByText("Crumb:host: nope.example")).toBeNull();
    expect(screen.getByText(LABELS.staleHashFallback)).toBeTruthy();
  });
});

describe("TriageBaselineContent — Story-origin restore respects triage.tab=stories (#553 Round 2)", () => {
  afterEach(() => {
    storyActionsMocks.fetchStoryDetail.mockReset();
    storyActionsMocks.refreshTriageStories.mockReset();
    storyActionsMocks.submitSaveAnalystCuratedStory.mockReset();
    window.location.hash = "";
  });

  it("does not flip the active tab to Pivot when the hash carries triage.tab=stories alongside triage.pivot.story", async () => {
    // Reviewer Round 2 Item 2: after a Pivot-from-Story drill-in, the
    // analyst may navigate back to the Stories tab — the Stories↔Pivot
    // swap preserves `triage.pivot.story` in the hash by design (Pivot
    // origin survives the swap). On reload, the Stories restore first
    // applies `triage.tab=stories`, but the prior pivot-restore code
    // unconditionally set `tab` back to `"pivot"` whenever
    // `triage.pivot.story` was present. The reload acceptance is
    // specifically for `triage.tab=pivot + story origin`; when the hash
    // says the active tab is Stories, the Pivot-origin marker must be
    // seeded without forcing Pivot.
    window.location.hash =
      "#triage.tab=stories&triage.pivot.story=9/42&triage.pivot.step=host:story-host.example";
    storyActionsMocks.fetchStoryDetail.mockResolvedValue({
      members: [makeStoryMember()],
      hasDanglingMembers: false,
      storedMemberCount: 1,
    });

    await act(async () => {
      render(
        <TriageBaselineContent
          result={makeMultiCustomerResult()}
          resetSignal={0}
          period={PERIOD}
          scope="tier1"
          mode="baseline"
          stories={[makeStory()]}
          labels={LABELS}
        />,
      );
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // Stories tab is the active tab (the hash's authoritative
    // `triage.tab=stories` survives, not overridden by the pivot
    // restore branch).
    expect(
      screen.getByTestId("triage-tab-stories").getAttribute("data-state"),
    ).toBe("active");
    expect(
      screen.getByTestId("triage-tab-pivot").getAttribute("data-state"),
    ).toBe("inactive");

    // The Pivot-origin marker still landed: switching to the Pivot tab
    // restores the Story-origin breadcrumb without a fresh round of
    // hash parsing (the restore already populated `pivotOrigin`).
    fireEvent.click(screen.getByTestId("triage-tab-pivot"));
    expect(screen.getByText("Pivot focus")).toBeTruthy();
    expect(screen.getByText("Gamma Corp")).toBeTruthy();
  });

  it("still forces the Pivot tab on restore when the hash explicitly says triage.tab=pivot", async () => {
    // Counter-test for the gate: when the hash IS rooted at the Pivot
    // tab (the documented `tab=pivot + story origin + pivot trail`
    // reload acceptance), the restore must still seed the Pivot tab.
    window.location.hash =
      "#triage.tab=pivot&triage.pivot.story=9/42&triage.pivot.step=host:story-host.example";
    storyActionsMocks.fetchStoryDetail.mockResolvedValue({
      members: [makeStoryMember()],
      hasDanglingMembers: false,
      storedMemberCount: 1,
    });

    await act(async () => {
      render(
        <TriageBaselineContent
          result={makeMultiCustomerResult()}
          resetSignal={0}
          period={PERIOD}
          scope="tier1"
          mode="baseline"
          stories={[makeStory()]}
          labels={LABELS}
        />,
      );
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      screen.getByTestId("triage-tab-pivot").getAttribute("data-state"),
    ).toBe("active");
  });
});

describe("TriageBaselineContent — Story-origin marker stripped on Asset list (#553 Round 3)", () => {
  afterEach(() => {
    storyActionsMocks.fetchStoryDetail.mockReset();
    storyActionsMocks.refreshTriageStories.mockReset();
    storyActionsMocks.submitSaveAnalystCuratedStory.mockReset();
    window.location.hash = "";
  });

  it("removes `triage.pivot.story` from the hash when the analyst switches from a Pivot-from-Story trail back to Asset list", async () => {
    // Reviewer Round 3: the hash-sync effect serialized
    // `triage.pivot.story` whenever `pivotOrigin.kind === "story"`,
    // regardless of `tab`. Because Asset list is encoded by omitting
    // `triage.tab`, a reload of the resulting hash (no `triage.tab`,
    // `triage.pivot.story` present) bounced the analyst back to the
    // Pivot tab even though they had explicitly left to Asset list.
    // The marker must be stripped when `tab === "asset-list"`;
    // Stories↔Pivot swap preservation remains intact (covered by the
    // Round 2 tests above).
    const story = makeStory();
    const member = makeStoryMember();
    storyActionsMocks.fetchStoryDetail.mockResolvedValue({
      members: [member],
      hasDanglingMembers: false,
      storedMemberCount: 1,
    });

    await act(async () => {
      render(
        <TriageBaselineContent
          result={makeMultiCustomerResult()}
          resetSignal={0}
          period={PERIOD}
          scope="tier1"
          mode="baseline"
          stories={[story]}
          labels={LABELS}
        />,
      );
    });

    // Drive the Pivot-from-Story flow so `pivotOrigin.kind === "story"`.
    fireEvent.click(screen.getByTestId("triage-tab-stories"));
    await act(async () => {
      fireEvent.click(screen.getByText(LABELS.stories.card.open));
    });
    await waitFor(() => {
      expect(storyActionsMocks.fetchStoryDetail).toHaveBeenCalled();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    let pivotButton: HTMLElement | null = null;
    await waitFor(() => {
      const buttons = screen.queryAllByTestId(
        "triage-story-member-pivot-action",
      );
      pivotButton =
        buttons.find((b) => b.getAttribute("data-dimension") === "host") ??
        null;
      expect(pivotButton).not.toBeNull();
    });
    if (!pivotButton) throw new Error("pivot button never rendered");
    await act(async () => {
      fireEvent.click(pivotButton as HTMLElement);
    });

    // Sanity-check the precondition: while on the Pivot tab with the
    // Story origin active, the hash carries `triage.pivot.story` so a
    // reload (or Stories tab swap) lands the analyst back on the Story
    // origin.
    expect(window.location.hash).toContain("triage.pivot.story=9%2F42");

    // The analyst leaves the pivot for Asset list — Asset list omits
    // `triage.tab` from the hash, so leaving the Story-origin marker
    // in place would forcibly route the next reload back to Pivot.
    await act(async () => {
      fireEvent.click(screen.getByTestId("triage-tab-asset-list"));
    });
    expect(window.location.hash).not.toContain("triage.pivot.story");
    // Defense in depth: the dimension steps are likewise stripped while
    // the trail is hidden (this was the existing Pivot-tab gate).
    expect(window.location.hash).not.toContain("triage.pivot.step");

    // And swapping back to Pivot re-serializes the marker (the in-
    // memory `pivotOrigin` is unchanged), so the Story-origin breadcrumb
    // returns without re-parsing the hash.
    await act(async () => {
      fireEvent.click(screen.getByTestId("triage-tab-pivot"));
    });
    expect(window.location.hash).toContain("triage.pivot.story=9%2F42");
  });

  it("keeps `triage.pivot.story` in the hash when the analyst switches from Pivot to Stories", async () => {
    // Counter-test for the Asset-list strip: the Stories tab swap must
    // still preserve the Pivot-origin marker (Round 2 acceptance). The
    // Stories tab encodes `triage.tab=stories` explicitly, so a reload
    // of `triage.tab=stories&triage.pivot.story=<id>` still lands the
    // analyst on Stories with the Pivot origin ready for a later swap.
    const story = makeStory();
    const member = makeStoryMember();
    storyActionsMocks.fetchStoryDetail.mockResolvedValue({
      members: [member],
      hasDanglingMembers: false,
      storedMemberCount: 1,
    });

    await act(async () => {
      render(
        <TriageBaselineContent
          result={makeMultiCustomerResult()}
          resetSignal={0}
          period={PERIOD}
          scope="tier1"
          mode="baseline"
          stories={[story]}
          labels={LABELS}
        />,
      );
    });

    fireEvent.click(screen.getByTestId("triage-tab-stories"));
    await act(async () => {
      fireEvent.click(screen.getByText(LABELS.stories.card.open));
    });
    await waitFor(() => {
      expect(storyActionsMocks.fetchStoryDetail).toHaveBeenCalled();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    let pivotButton: HTMLElement | null = null;
    await waitFor(() => {
      const buttons = screen.queryAllByTestId(
        "triage-story-member-pivot-action",
      );
      pivotButton =
        buttons.find((b) => b.getAttribute("data-dimension") === "host") ??
        null;
      expect(pivotButton).not.toBeNull();
    });
    if (!pivotButton) throw new Error("pivot button never rendered");
    await act(async () => {
      fireEvent.click(pivotButton as HTMLElement);
    });
    expect(window.location.hash).toContain("triage.pivot.story=9%2F42");

    await act(async () => {
      fireEvent.click(screen.getByTestId("triage-tab-stories"));
    });
    // Stories tab encodes itself explicitly; the Pivot-origin marker
    // survives the swap.
    expect(window.location.hash).toContain("triage.tab=stories");
    expect(window.location.hash).toContain("triage.pivot.story=9%2F42");
  });
});

describe("TriageBaselineContent — Pivot panel truncation hint reflects active corpus (#553 Round 4)", () => {
  afterEach(() => {
    storyActionsMocks.fetchStoryDetail.mockReset();
    storyActionsMocks.refreshTriageStories.mockReset();
    storyActionsMocks.submitSaveAnalystCuratedStory.mockReset();
    window.location.hash = "";
  });

  it("suppresses the truncation hint on a Story-origin pivot panel even when the period-wide result is truncated", async () => {
    // Reviewer Round 4: the Pivot panel previously surfaced the
    // truncation banner whenever `result.truncated === true`, regardless
    // of origin. On a Story-origin trail the panel actually reads from
    // the Story member set (a complete corpus), not the period-wide
    // 5,000-row asset corpus that the flag describes. Showing the
    // banner there falsely implies the Story-scoped pivots are partial
    // — contradicting the #553 data-source decision that only the asset
    // list stays period-wide. The fix gates `panelTruncated` on
    // `pivotOrigin.kind !== "story"`.
    const truncatedResult: TriageLoadResult = {
      ...makeMultiCustomerResult(),
      truncated: true,
    };
    const story = makeStory();
    const member = makeStoryMember();
    storyActionsMocks.fetchStoryDetail.mockResolvedValue({
      members: [member],
      hasDanglingMembers: false,
      storedMemberCount: 1,
    });

    await act(async () => {
      render(
        <TriageBaselineContent
          result={truncatedResult}
          resetSignal={0}
          period={PERIOD}
          scope="tier1"
          mode="baseline"
          stories={[story]}
          labels={LABELS}
        />,
      );
    });

    // Precondition: with the asset-rooted Pivot tab (the period-wide
    // corpus actually drove the panel), the truncation banner renders.
    // This sanity-checks that the gate fires on origin, not on a stale
    // result.truncated read.
    fireEvent.click(screen.getByTestId("triage-tab-pivot"));
    expect(screen.getByText(LABELS.pivotPanel.truncatedHint)).toBeTruthy();

    // Drive Pivot-from-Story so `pivotOrigin.kind === "story"`.
    fireEvent.click(screen.getByTestId("triage-tab-stories"));
    await act(async () => {
      fireEvent.click(screen.getByText(LABELS.stories.card.open));
    });
    await waitFor(() => {
      expect(storyActionsMocks.fetchStoryDetail).toHaveBeenCalled();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    let pivotButton: HTMLElement | null = null;
    await waitFor(() => {
      const buttons = screen.queryAllByTestId(
        "triage-story-member-pivot-action",
      );
      pivotButton =
        buttons.find((b) => b.getAttribute("data-dimension") === "host") ??
        null;
      expect(pivotButton).not.toBeNull();
    });
    if (!pivotButton) throw new Error("pivot button never rendered");
    await act(async () => {
      fireEvent.click(pivotButton as HTMLElement);
    });

    // Story-origin trail is active on the Pivot peer view. The Pivot
    // panel reads from the Story member set (complete), so the period-
    // wide truncation hint must NOT render even though
    // `result.truncated === true`.
    expect(screen.queryByText(LABELS.pivotPanel.truncatedHint)).toBeNull();
  });
});

// #588 R4: the client emit must choose `pivotValueJoinId` for natural-
// join dimensions and `pivotValue` for raw-ish dimensions. Pre-fix,
// every pivot click posted `pivotValue` unconditionally, so a
// `sameSensor` click landed HMAC-only on the server even though the
// issue calls for the natural id to go directly into
// `engagement_action.pivot_value_join_id`.
describe("TriageBaselineContent — pivot_value wire shape by dimension (#588 R4)", () => {
  beforeEach(() => {
    // Earlier describes in this file do not reset the engagement
    // mocks, so prior `host` clicks would otherwise leak into the
    // first `find(... === "story_pivot_click")` lookup below.
    postEngagementActionMock.mockReset();
    postImpressionBatchMock.mockReset();
  });
  afterEach(() => {
    storyActionsMocks.fetchStoryDetail.mockReset();
    storyActionsMocks.refreshTriageStories.mockReset();
    storyActionsMocks.submitSaveAnalystCuratedStory.mockReset();
    postEngagementActionMock.mockReset();
    postImpressionBatchMock.mockReset();
  });

  it("a sameSensor pivot click posts pivotValueJoinId (not pivotValue)", async () => {
    const story = makeStory();
    const member = makeStoryMember({ sensor: "sensor-alpha" });
    storyActionsMocks.fetchStoryDetail.mockResolvedValue({
      members: [member],
      hasDanglingMembers: false,
      storedMemberCount: 1,
    });

    await act(async () => {
      render(
        <TriageBaselineContent
          result={makeMultiCustomerResult()}
          resetSignal={0}
          period={PERIOD}
          scope="tier1"
          mode="baseline"
          stories={[story]}
          labels={LABELS}
        />,
      );
    });

    fireEvent.click(screen.getByTestId("triage-tab-stories"));
    await act(async () => {
      fireEvent.click(screen.getByText(LABELS.stories.card.open));
    });
    await waitFor(() => {
      expect(storyActionsMocks.fetchStoryDetail).toHaveBeenCalled();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    let sensorButton: HTMLElement | null = null;
    await waitFor(() => {
      const buttons = screen.queryAllByTestId(
        "triage-story-member-pivot-action",
      );
      sensorButton =
        buttons.find(
          (b) => b.getAttribute("data-dimension") === "sameSensor",
        ) ?? null;
      expect(sensorButton).not.toBeNull();
    });
    if (!sensorButton) throw new Error("sameSensor button never rendered");
    await act(async () => {
      fireEvent.click(sensorButton as HTMLElement);
    });

    const calls = postEngagementActionMock.mock.calls;
    const storyPivot = calls.find(
      ([action]) => action?.type === "story_pivot_click",
    );
    expect(storyPivot).toBeDefined();
    const payload = storyPivot?.[0];
    expect(payload.dimension).toBe("sameSensor");
    expect(payload.pivotValueJoinId).toBe("sensor-alpha");
    expect(payload).not.toHaveProperty("pivotValue");
  });

  it("a host (raw-ish) pivot click posts pivotValue (not pivotValueJoinId)", async () => {
    const story = makeStory();
    const member = makeStoryMember({ host: "story-host.example" });
    storyActionsMocks.fetchStoryDetail.mockResolvedValue({
      members: [member],
      hasDanglingMembers: false,
      storedMemberCount: 1,
    });

    await act(async () => {
      render(
        <TriageBaselineContent
          result={makeMultiCustomerResult()}
          resetSignal={0}
          period={PERIOD}
          scope="tier1"
          mode="baseline"
          stories={[story]}
          labels={LABELS}
        />,
      );
    });

    fireEvent.click(screen.getByTestId("triage-tab-stories"));
    await act(async () => {
      fireEvent.click(screen.getByText(LABELS.stories.card.open));
    });
    await waitFor(() => {
      expect(storyActionsMocks.fetchStoryDetail).toHaveBeenCalled();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    let hostButton: HTMLElement | null = null;
    await waitFor(() => {
      const buttons = screen.queryAllByTestId(
        "triage-story-member-pivot-action",
      );
      hostButton =
        buttons.find((b) => b.getAttribute("data-dimension") === "host") ??
        null;
      expect(hostButton).not.toBeNull();
    });
    if (!hostButton) throw new Error("host button never rendered");
    await act(async () => {
      fireEvent.click(hostButton as HTMLElement);
    });

    const calls = postEngagementActionMock.mock.calls;
    const storyPivot = calls.find(
      ([action]) => action?.type === "story_pivot_click",
    );
    expect(storyPivot).toBeDefined();
    const payload = storyPivot?.[0];
    expect(payload.dimension).toBe("host");
    expect(payload.pivotValue).toBe("story-host.example");
    expect(payload).not.toHaveProperty("pivotValueJoinId");
  });
});

describe("TriageBaselineContent — periodic drain scope source", () => {
  beforeEach(() => {
    createPeriodicDrainMock.mockReset();
    createPeriodicDrainMock.mockImplementation(() => ({
      start: vi.fn(),
      stop: vi.fn(),
    }));
    storyActionsMocks.fetchStoryDetail.mockReset();
    storyActionsMocks.refreshTriageStories.mockReset();
    storyActionsMocks.fetchStoryDetail.mockResolvedValue(null);
    storyActionsMocks.refreshTriageStories.mockResolvedValue([]);
  });

  function makeFreshness(customerIds: number[]) {
    return {
      worst: null,
      customers: customerIds.map((customerId) => ({
        customerId,
        status: "ok" as const,
        lastIngestedAtIso: "2026-05-08T00:00:00.000Z",
        rowAbsent: false,
        lastError: null,
      })),
    };
  }

  it("starts one drain controller per customer in result.freshness.customers (not per row in result.events)", () => {
    // Round 4 Item 1: the drain scope must come from
    // `result.freshness.customers` so admin views with queued
    // backlog for a tenant that has no visible rows in the current
    // slice still get a drain started. Anchoring scope to
    // `result.events` would tie the trigger to row visibility and
    // leave queue notices undrained.
    const result: TriageLoadResult = {
      funnel: { detected: 0, triaged: 0, shown: 0, passThroughRate: 0 },
      assets: [],
      truncated: false,
      storyProtectedTruncated: false,
      storyProtectedDroppedCount: 0,
      eligibleByStop: {},
      loadedEventCount: 1,
      // Single row from customer 7 only — customer 9 has no visible
      // rows but IS in scope (e.g. queue-only customer with pending
      // refresh / backfill / withdraw notices).
      events: [makeEvent(7, "x.example", "e1", 0)],
      observedDenominatorTruncated: false,
      freshness: makeFreshness([7, 9]),
      strictness: "top50",
    };

    render(
      <TriageBaselineContent
        result={result}
        resetSignal={0}
        period={PERIOD}
        scope="tier1"
        mode="baseline"
        labels={LABELS}
      />,
    );

    const customerArgs = createPeriodicDrainMock.mock.calls
      .map((call) => call[1] as number)
      .sort((a, b) => a - b);
    expect(customerArgs).toEqual([7, 9]);
    for (const call of createPeriodicDrainMock.mock.calls) {
      expect(call[0]).toBe("baseline_event");
    }
  });

  it("does NOT start a drain for a customer whose events appear but who is not in freshness.customers", () => {
    // Inverse of the above — `freshness.customers` is the source of
    // truth. A stray event whose customer is not in the loaded scope
    // (rare, but possible during scope flips) must not spin up an
    // unrequested controller.
    const result: TriageLoadResult = {
      funnel: { detected: 0, triaged: 0, shown: 0, passThroughRate: 0 },
      assets: [],
      truncated: false,
      storyProtectedTruncated: false,
      storyProtectedDroppedCount: 0,
      eligibleByStop: {},
      loadedEventCount: 1,
      events: [makeEvent(99, "x.example", "e1", 0)],
      observedDenominatorTruncated: false,
      freshness: makeFreshness([7]),
      strictness: "top50",
    };

    render(
      <TriageBaselineContent
        result={result}
        resetSignal={0}
        period={PERIOD}
        scope="tier1"
        mode="baseline"
        labels={LABELS}
      />,
    );

    const customerArgs = createPeriodicDrainMock.mock.calls.map(
      (call) => call[1] as number,
    );
    expect(customerArgs).toEqual([7]);
  });
});
