/**
 * Direct coverage for {@link TriageBaselineContent}. The wrapper
 * `TriageShell` tests pin the period-change + Tier 2 wiring; this
 * file pins the multi-customer behaviors that only become visible
 * when the loaded result carries assets from more than one tenant.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/triage",
  useSearchParams: () => new URLSearchParams(),
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
