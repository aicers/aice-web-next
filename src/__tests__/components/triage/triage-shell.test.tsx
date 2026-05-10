/**
 * Component-level coverage for the period-change confirmation flow
 * around the Triage breadcrumb. The pure breadcrumb helpers are
 * already exercised in `breadcrumb.test.ts`; this file pins the
 * user-facing requirement that pivoting and then changing the
 * period must surface an `AlertDialog`, that Cancel preserves the
 * trail, and that Confirm clears it and triggers the period reload.
 */

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Drain microtasks under fake timers so a chain of awaits inside the
// hook (peek → decide → continuation) settles before assertions.
async function flushAsync(cycles = 6) {
  for (let i = 0; i < cycles; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

const replaceMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock, push: vi.fn() }),
  usePathname: () => "/triage",
  useSearchParams: () => new URLSearchParams(),
}));

// Tier 2 fetches go through a "use server" action that crosses to the
// BFF. The component-level tests mock the boundary so the assertions
// can pin the call shape and the cache write without standing up a
// GraphQL transport.
const fetchTier2Mock = vi.hoisted(() =>
  vi.fn(async (_input: Record<string, unknown>) => ({
    events: [] as unknown[],
    totalCount: null as string | null,
    truncated: false,
    hasMore: false,
    endCursor: null as string | null,
  })),
);
vi.mock("@/lib/triage/tier2-fetch", () => ({
  fetchTier2Dimension: fetchTier2Mock,
}));

// `TriagePeriodPicker` validates the submitted start against the real
// `Date.now()` and rejects anything older than `TRIAGE_MAX_LOOKBACK_MS`
// (30 days). Freezing the clock keeps the fixed period below from
// ageing past that window, which would otherwise turn this suite into
// a CI time bomb that fails 30 days after the fixture date.
const FROZEN_NOW = new Date("2026-05-09T12:00:00.000Z");

import {
  TriageShell,
  type TriageShellLabels,
} from "@/components/triage/triage-shell";
import { aggregateTriageEvents, type TriageEvent } from "@/lib/triage";
import { PIVOT_DIMENSIONS, type PivotDimensionId } from "@/lib/triage/pivot";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FROZEN_NOW);
  // The Triage breadcrumb persists pivot state in `location.hash`
  // (see baseline-content.tsx). Clear between tests so a previous
  // case's pivot trail doesn't leak into the next render.
  if (typeof window !== "undefined") window.location.hash = "";
  fetchTier2Mock.mockClear();
  fetchTier2Mock.mockResolvedValue({
    events: [],
    totalCount: null,
    truncated: false,
    hasMore: false,
    endCursor: null,
  });
});

afterEach(() => {
  vi.useRealTimers();
  replaceMock.mockReset();
  if (typeof window !== "undefined") window.location.hash = "";
});

const PERIOD = {
  startIso: "2026-05-08T00:00:00.000Z",
  endIso: "2026-05-09T00:00:00.000Z",
};

function dimensionsMap(prefix: string): Record<PivotDimensionId, string> {
  const out = {} as Record<PivotDimensionId, string>;
  for (const dim of PIVOT_DIMENSIONS) out[dim.id] = `${prefix}:${dim.id}`;
  return out;
}

const LABELS: TriageShellLabels = {
  title: "Triage",
  intro: "intro",
  errorBanner: "error",
  forbiddenBanner: "forbidden",
  forbiddenScopeBanner: "forbidden-scope",
  truncatedBannerTemplate: "Showing {loaded} of {cap}",
  clampedNotice: "clamped",
  periodPicker: {
    legend: "Period",
    startLabel: "Start",
    endLabel: "End",
    apply: "Apply",
    invalidRange: "Invalid range",
    durationCapHint: "Too long",
    lookbackHint: "Too far back",
  },
  modeToggle: {
    legend: "Mode",
    baseline: "Baseline",
    policies: "Policies",
    policiesUnavailable: "Coming soon",
  },
  scopeToggle: {
    legend: "Scope",
    tier1: "Triaged only",
    tier2: "All detection events",
    tier1Hint: "Tier 1",
    tier2Hint: "Tier 2",
  },
  baseline: {
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
      rowDetailsTemplate: "{address}",
    },
    assetDetail: {
      title: "Asset detail",
      pivotFocusTitle: "Pivot focus",
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
  },
  periodChangeConfirm: {
    title: "Discard pivot trail?",
    description: "Changing the period will clear your trail.",
    confirm: "Discard and reload",
    cancel: "Keep current period",
  },
};

function ev(overrides: Partial<TriageEvent>): TriageEvent {
  return {
    __typename: "BlocklistTls",
    time: "2026-05-08T12:00:00.000Z",
    sensor: "sensor-a",
    category: "EXFILTRATION",
    level: "MEDIUM",
    ...overrides,
  };
}

function renderShell() {
  // Two assets sharing a JA3 so the pivot panel surfaces an actionable
  // section the test can click.
  const events: TriageEvent[] = [
    ev({
      origAddr: "10.0.0.1",
      respAddr: "203.0.113.1",
      ja3: "deadbeef",
      time: "2026-05-08T12:00:00.000Z",
    }),
    ev({
      origAddr: "10.0.0.2",
      respAddr: "203.0.113.1",
      ja3: "deadbeef",
      time: "2026-05-08T12:30:00.000Z",
    }),
  ];
  const result = aggregateTriageEvents(events, false);
  return render(
    <TriageShell
      initialPeriod={PERIOD}
      initialState={{ status: "ok", result }}
      initialClamped={false}
      labels={LABELS}
    />,
  );
}

function pivotByJa3() {
  // The JA3 row in the related-events panel renders a pivot button
  // labelled by `pivotActionTemplate`. Click it to add a dimension
  // crumb to the trail.
  const pivotButton = screen.getByRole("button", {
    name: "Pivot to Dim:ja3: deadbeef",
  });
  fireEvent.click(pivotButton);
}

function submitNewPeriod() {
  // Submit a different period via the picker. The form's <input>s are
  // datetime-local; setting their values before form submission is
  // enough — TriagePeriodPicker reads from controlled state.
  const start = screen.getByLabelText("Start") as HTMLInputElement;
  const end = screen.getByLabelText("End") as HTMLInputElement;
  fireEvent.change(start, { target: { value: "2026-05-07T00:00" } });
  fireEvent.change(end, { target: { value: "2026-05-08T00:00" } });
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
}

describe("TriageShell — period-change confirmation", () => {
  it("commits the new period directly when the trail has no dimension steps", () => {
    renderShell();
    submitNewPeriod();
    expect(
      screen.queryByRole("alertdialog", { name: "Discard pivot trail?" }),
    ).toBeNull();
    expect(replaceMock).toHaveBeenCalledTimes(1);
  });

  it("opens the AlertDialog when the trail has a dimension pivot, and Cancel preserves the trail", () => {
    renderShell();
    pivotByJa3();
    // Last crumb is the JA3 dimension step — `aria-current="page"`
    // marks the active crumb.
    expect(
      screen.getByText("Crumb:ja3: deadbeef").getAttribute("aria-current"),
    ).toBe("page");

    const startBefore = (screen.getByLabelText("Start") as HTMLInputElement)
      .value;
    const endBefore = (screen.getByLabelText("End") as HTMLInputElement).value;

    submitNewPeriod();
    const dialog = screen.getByRole("alertdialog", {
      name: "Discard pivot trail?",
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Keep current period" }),
    );
    expect(replaceMock).not.toHaveBeenCalled();
    // Trail still has the JA3 step.
    expect(
      screen.getByText("Crumb:ja3: deadbeef").getAttribute("aria-current"),
    ).toBe("page");
    // Picker draft was rejected — Start / End must snap back to the
    // currently loaded period rather than continuing to display the
    // values the operator just typed.
    expect((screen.getByLabelText("Start") as HTMLInputElement).value).toBe(
      startBefore,
    );
    expect((screen.getByLabelText("End") as HTMLInputElement).value).toBe(
      endBefore,
    );
  });

  it("treats Escape (and other non-confirm dismissals) as Cancel: keeps trail and resets picker draft", () => {
    renderShell();
    pivotByJa3();
    const startBefore = (screen.getByLabelText("Start") as HTMLInputElement)
      .value;
    const endBefore = (screen.getByLabelText("End") as HTMLInputElement).value;

    submitNewPeriod();
    const dialog = screen.getByRole("alertdialog", {
      name: "Discard pivot trail?",
    });
    // Simulate any non-confirm dismissal (Escape, programmatic close)
    // by firing the Radix-controlled `onOpenChange(false)` path. We do
    // it through `keyDown` Escape on the dialog so the assertion
    // mirrors the keyboard behavior the reviewer flagged.
    fireEvent.keyDown(dialog, { key: "Escape", code: "Escape" });

    expect(replaceMock).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("alertdialog", { name: "Discard pivot trail?" }),
    ).toBeNull();
    expect(
      screen.getByText("Crumb:ja3: deadbeef").getAttribute("aria-current"),
    ).toBe("page");
    expect((screen.getByLabelText("Start") as HTMLInputElement).value).toBe(
      startBefore,
    );
    expect((screen.getByLabelText("End") as HTMLInputElement).value).toBe(
      endBefore,
    );
  });

  it("clears the trail and reloads when the operator confirms the period change", () => {
    renderShell();
    pivotByJa3();
    submitNewPeriod();
    const dialog = screen.getByRole("alertdialog", {
      name: "Discard pivot trail?",
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Discard and reload" }),
    );
    expect(replaceMock).toHaveBeenCalledTimes(1);
    expect(replaceMock.mock.calls[0][0]).toContain("start=");
    expect(replaceMock.mock.calls[0][0]).toContain("end=");
  });
});

describe("TriageShell — Tier 2 pivot wiring", () => {
  function selectTier2Scope() {
    const scopeTab = screen.getByRole("tab", { name: "All detection events" });
    fireEvent.click(scopeTab);
  }

  function pivotByCountry() {
    const pivotButton = screen.getByRole("button", {
      name: "Pivot to Dim:country: KR",
    });
    fireEvent.click(pivotButton);
  }

  function renderShellWithCountry() {
    // Three corpus events sharing country=KR. The first two share an
    // asset (10.0.0.1) and form the focus when the asset row is
    // selected; the third belongs to a different asset so the
    // country pivot section actually surfaces a non-empty row group.
    // Without that third event the section is hidden by
    // `buildPivotPanel`'s "matches must extend beyond the focus" rule.
    const events: TriageEvent[] = [
      ev({
        origAddr: "10.0.0.1",
        respAddr: "203.0.113.1",
        respCountry: "KR",
        time: "2026-05-08T12:00:00.000Z",
      }),
      ev({
        origAddr: "10.0.0.1",
        respAddr: "203.0.113.2",
        respCountry: "KR",
        time: "2026-05-08T12:30:00.000Z",
      }),
      ev({
        origAddr: "10.0.0.9",
        respAddr: "203.0.113.3",
        respCountry: "KR",
        time: "2026-05-08T13:00:00.000Z",
      }),
    ];
    const result = aggregateTriageEvents(events, false);
    return render(
      <TriageShell
        initialPeriod={PERIOD}
        initialState={{ status: "ok", result }}
        initialClamped={false}
        labels={LABELS}
      />,
    );
  }

  it("does not call fetchTier2Dimension while in Tier 1 mode", async () => {
    renderShellWithCountry();
    pivotByCountry();
    await flushAsync();
    expect(fetchTier2Mock).not.toHaveBeenCalled();
  });

  it("issues a peek and shows the modal when projection exceeds the threshold, then continues on confirm", async () => {
    // Peek: first page filled with totalCount over 20k → modal opens.
    fetchTier2Mock.mockResolvedValueOnce({
      events: [],
      totalCount: "30000",
      truncated: false,
      hasMore: true,
      endCursor: "cursor-1",
    });
    // Continuation after confirm.
    fetchTier2Mock.mockResolvedValueOnce({
      events: [],
      totalCount: "30000",
      truncated: false,
      hasMore: false,
      endCursor: null,
    });
    renderShellWithCountry();
    selectTier2Scope();
    pivotByCountry();
    await flushAsync();
    expect(fetchTier2Mock).toHaveBeenCalledTimes(1);
    expect(fetchTier2Mock.mock.calls[0][0]).toMatchObject({
      dimension: "country",
      valueKey: "KR",
      firstPageOnly: true,
    });
    // Modal blocks the continuation until the operator confirms.
    const modal = screen.getByRole("alertdialog", {
      name: "Fetch large result?",
    });
    fireEvent.click(within(modal).getByRole("button", { name: "Fetch" }));
    await flushAsync();
    expect(fetchTier2Mock).toHaveBeenCalledTimes(2);
    expect(fetchTier2Mock.mock.calls[1][0]).toMatchObject({
      dimension: "country",
      valueKey: "KR",
      afterCursor: "cursor-1",
    });
  });

  it("skips the modal when projection is below the threshold", async () => {
    fetchTier2Mock.mockResolvedValueOnce({
      events: [],
      totalCount: "10",
      truncated: false,
      hasMore: true,
      endCursor: "cursor-1",
    });
    fetchTier2Mock.mockResolvedValueOnce({
      events: [],
      totalCount: "10",
      truncated: false,
      hasMore: false,
      endCursor: null,
    });
    renderShellWithCountry();
    selectTier2Scope();
    pivotByCountry();
    await flushAsync();
    expect(fetchTier2Mock).toHaveBeenCalledTimes(2);
    expect(
      screen.queryByRole("alertdialog", { name: "Fetch large result?" }),
    ).toBeNull();
    // Continuation resumes from the peek's cursor — no redundant first-page fetch.
    expect(fetchTier2Mock.mock.calls[1][0]).toMatchObject({
      afterCursor: "cursor-1",
    });
  });

  it("skips both the modal and the continuation when peek says hasMore=false", async () => {
    fetchTier2Mock.mockResolvedValueOnce({
      events: [],
      totalCount: "5",
      truncated: false,
      hasMore: false,
      endCursor: null,
    });
    renderShellWithCountry();
    selectTier2Scope();
    pivotByCountry();
    await flushAsync();
    expect(fetchTier2Mock).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole("alertdialog", { name: "Fetch large result?" }),
    ).toBeNull();
  });

  it("does not continue fetching when the operator cancels the modal", async () => {
    fetchTier2Mock.mockResolvedValueOnce({
      events: [],
      totalCount: "30000",
      truncated: false,
      hasMore: true,
      endCursor: "cursor-1",
    });
    renderShellWithCountry();
    selectTier2Scope();
    pivotByCountry();
    await flushAsync();
    const modal = screen.getByRole("alertdialog", {
      name: "Fetch large result?",
    });
    fireEvent.click(within(modal).getByRole("button", { name: "Cancel" }));
    await flushAsync();
    // Only the peek call — cancel must not dispatch the continuation.
    expect(fetchTier2Mock).toHaveBeenCalledTimes(1);
  });

  it("surfaces a fetch error notice and clears it on dismiss", async () => {
    fetchTier2Mock.mockRejectedValueOnce(new Error("review timed out"));
    renderShellWithCountry();
    selectTier2Scope();
    pivotByCountry();
    await flushAsync();
    const notice = screen.getByText("error Dim:country: KR — review timed out");
    expect(notice).toBeTruthy();
    // Dismiss button removes the notice and clears the loading state
    // for that pivot so a retry click is possible.
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await flushAsync();
    expect(
      screen.queryByText("error Dim:country: KR — review timed out"),
    ).toBeNull();
  });

  it("encodes the Tier 2 mode in the URL hash so a shared link is reload-stable", () => {
    renderShellWithCountry();
    selectTier2Scope();
    expect(window.location.hash).toContain("triage.pivot.mode=tier2");
  });
});
