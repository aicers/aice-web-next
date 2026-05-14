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
import { afterEach, describe, expect, it, vi } from "vitest";

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
    funnel: { detected: 4, triaged: 4, passThroughRate: 1 },
    assets: [assetA, assetB],
    truncated: false,
    loadedEventCount: 4,
    events: [...assetAEvents, ...assetBEvents],
    observedDenominatorTruncated: false,
    freshness: { worst: null, customers: [] },
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
