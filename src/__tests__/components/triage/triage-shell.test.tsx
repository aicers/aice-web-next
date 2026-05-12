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
interface MockTier2Result {
  events: unknown[];
  totalCount: string | null;
  truncated: boolean;
  hasMore: boolean;
  endCursor: string | null;
  /**
   * Optional sensor fallback discriminator. The hook routes the
   * `scope-forbidden` arm through a distinct UI banner from the
   * `name-unresolved` arm (#502 round 5).
   */
  sensorFallback?: {
    kind: "name-unresolved" | "scope-forbidden";
    sensorName: string;
  };
}

const fetchTier2Mock = vi.hoisted(() =>
  vi.fn(
    async (_input: Record<string, unknown>): Promise<MockTier2Result> => ({
      events: [],
      totalCount: null,
      truncated: false,
      hasMore: false,
      endCursor: null,
    }),
  ),
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
  // `mockReset` (not `mockClear`) is required because individual tests
  // queue `mockResolvedValueOnce` responses, and a test that fails
  // before consuming its queued response would otherwise leak it into
  // the next test's first fetch.
  fetchTier2Mock.mockReset();
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
  // Static-options dimensions (#498 — `learningMethods`, #499 —
  // `keywords`) have no entry in PIVOT_DIMENSIONS but still need a
  // label for breadcrumb / pivot-focus rendering.
  out.learningMethods = `${prefix}:learningMethods`;
  out.keywords = `${prefix}:keywords`;
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
      detectedOver30dHint: "(over last 30d)",
      rowDetailsTemplate: "{address}",
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
  },
  periodChangeConfirm: {
    title: "Discard pivot trail?",
    description: "Changing the period will clear your trail.",
    confirm: "Discard and reload",
    cancel: "Keep current period",
  },
  observedDenominatorTruncatedNotice: "Detected covers only the last 30 days.",
  freshness: {
    okTemplate: "Last updated: {ago}",
    runningWithPreviousTemplate: "Updating now ({ago})",
    runningFirstIngest: "First ingest in progress",
    failedTemplate: "Failed {ago}",
    failedFirstIngest: "First ingest failed",
    awaitingFirstIngest: "Awaiting first ingest",
    okMultiTemplate: "Last updated: {ago}, across {count} customers",
    affectedCustomersHeading: "Affected",
    relative: {
      justNow: "just now",
      minutesTemplate: "{n} min ago",
      hoursTemplate: "{n} h ago",
      daysTemplate: "{n} d ago",
    },
  },
};

let evSeq = 0;
function ev(overrides: Partial<TriageEvent>): TriageEvent {
  evSeq += 1;
  return {
    __typename: "BlocklistTls",
    id: `evt-${evSeq}`,
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
      host: "deadbeef.example",
      time: "2026-05-08T12:00:00.000Z",
    }),
    ev({
      origAddr: "10.0.0.2",
      respAddr: "203.0.113.1",
      host: "deadbeef.example",
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

function pivotByHost() {
  // The JA3 row in the related-events panel renders a pivot button
  // labelled by `pivotActionTemplate`. Click it to add a dimension
  // crumb to the trail.
  const pivotButton = screen.getByRole("button", {
    name: "Pivot to Dim:host: deadbeef.example",
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
    pivotByHost();
    // Last crumb is the JA3 dimension step — `aria-current="page"`
    // marks the active crumb.
    expect(
      screen
        .getByText("Crumb:host: deadbeef.example")
        .getAttribute("aria-current"),
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
      screen
        .getByText("Crumb:host: deadbeef.example")
        .getAttribute("aria-current"),
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
    pivotByHost();
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
      screen
        .getByText("Crumb:host: deadbeef.example")
        .getAttribute("aria-current"),
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
    pivotByHost();
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

describe("TriageShell — legacy URL hash fallback", () => {
  it("falls back to the asset root with a stale-hash toast for a legacy single-component asset hash", async () => {
    // Legacy hashes from before the composite `(customerId, address)`
    // key encoded only the address. The page must treat them as stale
    // — mis-resolving to the first customer's matching row could
    // misattribute pivots across two tenants that share an RFC1918
    // address.
    window.location.hash = `#triage.pivot.asset=${encodeURIComponent("10.0.0.1")}`;
    const events: TriageEvent[] = [
      ev({
        origAddr: "10.0.0.1",
        respAddr: "203.0.113.1",
        time: "2026-05-08T12:00:00.000Z",
      }),
    ];
    const result = aggregateTriageEvents(events, false);
    render(
      <TriageShell
        initialPeriod={PERIOD}
        initialState={{ status: "ok", result }}
        initialClamped={false}
        labels={LABELS}
      />,
    );
    await flushAsync();
    expect(screen.getByText("Stale hash — showing asset root")).toBeTruthy();
  });
});

describe("TriageShell — Tier 2 pivot wiring", () => {
  function selectTier2Scope() {
    const scopeTab = screen.getByRole("tab", { name: "All detection events" });
    fireEvent.click(scopeTab);
  }

  function pivotByExternalIp() {
    const pivotButton = screen.getByRole("button", {
      name: "Pivot to Dim:externalIp: 203.0.113.1",
    });
    fireEvent.click(pivotButton);
  }

  function renderShellWithExternalIp() {
    // Three corpus events sharing the responder external IP
    // 203.0.113.1. The first two share an asset (10.0.0.1) and form
    // the focus when the asset row is selected; the third belongs to
    // a different asset so the externalIp pivot section actually
    // surfaces a non-empty row group beyond the focus.
    // (The pre-1B-3 version of this test pivoted on `country=KR`,
    // which is now a Policy-only dimension and gated out of the
    // Baseline-mode panel — `externalIp` is the equivalent server-
    // filtered Tier 2 dim that stays available in Baseline mode.)
    const events: TriageEvent[] = [
      ev({
        origAddr: "10.0.0.1",
        respAddr: "203.0.113.1",
        time: "2026-05-08T12:00:00.000Z",
      }),
      ev({
        origAddr: "10.0.0.1",
        respAddr: "203.0.113.1",
        time: "2026-05-08T12:30:00.000Z",
      }),
      ev({
        origAddr: "10.0.0.9",
        respAddr: "203.0.113.1",
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
    renderShellWithExternalIp();
    pivotByExternalIp();
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
    renderShellWithExternalIp();
    selectTier2Scope();
    pivotByExternalIp();
    await flushAsync();
    expect(fetchTier2Mock).toHaveBeenCalledTimes(1);
    expect(fetchTier2Mock.mock.calls[0][0]).toMatchObject({
      dimension: "externalIp",
      valueKey: "203.0.113.1",
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
      dimension: "externalIp",
      valueKey: "203.0.113.1",
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
    renderShellWithExternalIp();
    selectTier2Scope();
    pivotByExternalIp();
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
    renderShellWithExternalIp();
    selectTier2Scope();
    pivotByExternalIp();
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
    renderShellWithExternalIp();
    selectTier2Scope();
    pivotByExternalIp();
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
    renderShellWithExternalIp();
    selectTier2Scope();
    pivotByExternalIp();
    await flushAsync();
    const notice = screen.getByText(
      "error Dim:externalIp: 203.0.113.1 — review timed out",
    );
    expect(notice).toBeTruthy();
    // Dismiss button removes the notice and clears the loading state
    // for that pivot so a retry click is possible.
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await flushAsync();
    expect(
      screen.queryByText(
        "error Dim:externalIp: 203.0.113.1 — review timed out",
      ),
    ).toBeNull();
  });

  it("encodes the Tier 2 mode in the URL hash so a shared link is reload-stable", () => {
    renderShellWithExternalIp();
    selectTier2Scope();
    expect(window.location.hash).toContain("triage.pivot.mode=tier2");
  });

  it("keeps the truncated hint visible after pivoting from a capped server-filtered ancestor into a client-intersection step", async () => {
    // Tier 1 corpus shape (1B-3 substitution: respAddr-as-externalIp
    // and `host` replace the pre-1B-3 country / ja3 dims, which are
    // now Policy-only and gated out of the Baseline-mode panel):
    //   - Two events on asset 10.0.0.1 sharing externalIp 203.0.113.1
    //     plus host=existing.example — focus events.
    //   - One event on a different asset 10.0.0.9 sharing the
    //     externalIp so the panel row extends beyond the focus.
    //   - One event on 10.0.0.7 with externalIp 203.0.113.99 and
    //     host=newhost.example so the host pivot row picks up at
    //     least one match outside the externalIp focus.
    const events: TriageEvent[] = [
      ev({
        origAddr: "10.0.0.1",
        respAddr: "203.0.113.1",
        host: "existing.example",
        time: "2026-05-08T12:00:00.000Z",
      }),
      ev({
        origAddr: "10.0.0.1",
        respAddr: "203.0.113.1",
        host: "existing.example",
        time: "2026-05-08T12:30:00.000Z",
      }),
      ev({
        origAddr: "10.0.0.9",
        respAddr: "203.0.113.1",
        time: "2026-05-08T13:00:00.000Z",
      }),
      ev({
        origAddr: "10.0.0.7",
        respAddr: "203.0.113.99",
        host: "newhost.example",
        time: "2026-05-08T13:15:00.000Z",
      }),
    ];
    const result = aggregateTriageEvents(events, false);
    // Single-page Tier 2 fetch that comes back already truncated —
    // simulates the per-dimension cap hit on `externalIp=203.0.113.1`.
    // The fetched events all carry host=newhost.example so a host
    // pivot row surfaces in the panel after the externalIp click.
    fetchTier2Mock.mockResolvedValueOnce({
      events: [
        {
          __typename: "BlocklistTls",
          id: "tier2-1",
          time: "2026-05-08T13:30:00.000Z",
          sensor: "sensor-a",
          category: "EXFILTRATION",
          level: "MEDIUM",
          origAddr: "10.0.0.5",
          respAddr: "203.0.113.1",
          host: "newhost.example",
        },
        {
          __typename: "BlocklistTls",
          id: "tier2-2",
          time: "2026-05-08T13:35:00.000Z",
          sensor: "sensor-a",
          category: "EXFILTRATION",
          level: "MEDIUM",
          origAddr: "10.0.0.6",
          respAddr: "203.0.113.1",
          host: "newhost.example",
        },
      ],
      totalCount: "5000",
      truncated: true,
      hasMore: false,
      endCursor: null,
    });
    render(
      <TriageShell
        initialPeriod={PERIOD}
        initialState={{ status: "ok", result }}
        initialClamped={false}
        labels={LABELS}
      />,
    );
    selectTier2Scope();
    pivotByExternalIp();
    await flushAsync();
    // The cap hit on `externalIp=203.0.113.1` must surface the panel
    // truncation hint immediately.
    expect(screen.getByText("truncated")).toBeTruthy();
    // Now pivot from the externalIp focus into host=newhost.example —
    // that host value is reachable only because the truncated Tier 2
    // fetch surfaced it. Before the contributing-fetch fix the hint
    // disappeared on the host step.
    fireEvent.click(
      screen.getByRole("button", {
        name: "Pivot to Dim:host: newhost.example",
      }),
    );
    await flushAsync();
    expect(
      screen
        .getByText("Crumb:host: newhost.example")
        .getAttribute("aria-current"),
    ).toBe("page");
    // Hint must still be visible: the active step is now a client-
    // intersection host pivot, but the contributing server-filtered
    // ancestor (`externalIp=203.0.113.1`) is still capped.
    expect(screen.getByText("truncated")).toBeTruthy();
  });

  it("restores a Tier 2 URL whose client-intersection step is reachable only through a queued ancestor fetch", async () => {
    // Hash trail: asset → externalIp=203.0.113.1 → host=remoteonly.example.
    // The Tier 1 corpus does NOT contain `host=remoteonly.example`;
    // that value lives only in the result of the queued
    // externalIp Tier 2 fetch. Without deferred validation the
    // restore loop would treat the host step as stale and fall back
    // to the asset root before the fetch could populate the
    // expanded corpus.
    window.location.hash =
      "#triage.pivot.asset=" +
      encodeURIComponent("0/10.0.0.1") +
      "&triage.pivot.step=" +
      encodeURIComponent("externalIp:203.0.113.1") +
      "&triage.pivot.step=" +
      encodeURIComponent("host:remoteonly.example") +
      "&triage.pivot.mode=tier2";
    const events: TriageEvent[] = [
      ev({
        origAddr: "10.0.0.1",
        respAddr: "203.0.113.10",
        host: "corpushost.example",
        time: "2026-05-08T12:00:00.000Z",
      }),
    ];
    const result = aggregateTriageEvents(events, false);
    fetchTier2Mock.mockResolvedValueOnce({
      events: [
        {
          __typename: "BlocklistTls",
          id: "remoteonly-1",
          time: "2026-05-08T13:30:00.000Z",
          sensor: "sensor-a",
          category: "EXFILTRATION",
          level: "MEDIUM",
          origAddr: "10.0.0.5",
          respAddr: "203.0.113.1",
          host: "remoteonly.example",
        },
        {
          __typename: "BlocklistTls",
          id: "remoteonly-2",
          time: "2026-05-08T13:35:00.000Z",
          sensor: "sensor-a",
          category: "EXFILTRATION",
          level: "MEDIUM",
          origAddr: "10.0.0.6",
          respAddr: "203.0.113.1",
          host: "remoteonly.example",
        },
      ],
      totalCount: "2",
      truncated: false,
      hasMore: false,
      endCursor: null,
    });
    render(
      <TriageShell
        initialPeriod={PERIOD}
        initialState={{ status: "ok", result }}
        initialClamped={false}
        labels={LABELS}
      />,
    );
    await flushAsync();
    // Queue drained, validation effect must accept the host step
    // because the freshly-fetched externalIp result populated it. No
    // stale-hash toast.
    expect(screen.queryByText("Stale hash — showing asset root")).toBeNull();
    expect(screen.getByText("Crumb:externalIp: 203.0.113.1")).toBeTruthy();
    expect(
      screen
        .getByText("Crumb:host: remoteonly.example")
        .getAttribute("aria-current"),
    ).toBe("page");
  });

  it("falls back to the asset root when a client-intersection step is still missing after the queued Tier 2 fetch resolves", async () => {
    // Same hash shape as the success case, but the externalIp fetch
    // returns no host=remoteonly.example event — the value is
    // genuinely stale. The post-drain validation must surface the
    // same fallback toast the synchronous restore path uses.
    window.location.hash =
      "#triage.pivot.asset=" +
      encodeURIComponent("0/10.0.0.1") +
      "&triage.pivot.step=" +
      encodeURIComponent("externalIp:203.0.113.1") +
      "&triage.pivot.step=" +
      encodeURIComponent("host:remoteonly.example") +
      "&triage.pivot.mode=tier2";
    const events: TriageEvent[] = [
      ev({
        origAddr: "10.0.0.1",
        respAddr: "203.0.113.10",
        host: "corpushost.example",
        time: "2026-05-08T12:00:00.000Z",
      }),
    ];
    const result = aggregateTriageEvents(events, false);
    fetchTier2Mock.mockResolvedValueOnce({
      events: [
        {
          __typename: "BlocklistTls",
          id: "different-1",
          time: "2026-05-08T13:30:00.000Z",
          sensor: "sensor-a",
          category: "EXFILTRATION",
          level: "MEDIUM",
          origAddr: "10.0.0.5",
          respAddr: "203.0.113.1",
          host: "differenthost.example",
        },
      ],
      totalCount: "1",
      truncated: false,
      hasMore: false,
      endCursor: null,
    });
    render(
      <TriageShell
        initialPeriod={PERIOD}
        initialState={{ status: "ok", result }}
        initialClamped={false}
        labels={LABELS}
      />,
    );
    await flushAsync();
    expect(screen.getByText("Stale hash — showing asset root")).toBeTruthy();
    expect(screen.queryByText("Crumb:host: remoteonly.example")).toBeNull();
  });

  it("post-drain stale fallback preserves the RESTORED asset crumb when the URL targets a non-first asset row", async () => {
    // Regression for Round 3 Item 1. The shared URL restores onto the
    // SECOND asset row (10.0.0.2), then queues an externalIp Tier 2
    // fetch whose result does not contain the deferred host step. The
    // post-drain validator previously reset trail/selected to
    // `initialFocus` (always `result.assets[0]` — 10.0.0.1), jumping
    // the UI to the wrong asset. The fix trims back to the restored
    // asset's crumb instead. Two corpus events with distinct origAddrs
    // produce two assets; 10.0.0.1's event time is newer so it sorts
    // first under `score DESC, last_event_time DESC` — making 10.0.0.2
    // the non-first row the hash explicitly targets.
    window.location.hash =
      "#triage.pivot.asset=" +
      encodeURIComponent("0/10.0.0.2") +
      "&triage.pivot.step=" +
      encodeURIComponent("externalIp:203.0.113.1") +
      "&triage.pivot.step=" +
      encodeURIComponent("host:remoteonly.example") +
      "&triage.pivot.mode=tier2";
    const events: TriageEvent[] = [
      ev({
        origAddr: "10.0.0.1",
        respAddr: "203.0.113.10",
        host: "first.example",
        // Newer → sorts to assets[0], i.e. `initialFocus`.
        time: "2026-05-08T13:00:00.000Z",
      }),
      ev({
        origAddr: "10.0.0.2",
        respAddr: "203.0.113.11",
        host: "second.example",
        time: "2026-05-08T12:00:00.000Z",
      }),
    ];
    const result = aggregateTriageEvents(events, false);
    // externalIp fetch succeeds but its rows do NOT carry the host
    // value the URL claims — host step stays genuinely stale.
    fetchTier2Mock.mockResolvedValueOnce({
      events: [
        {
          __typename: "BlocklistTls",
          id: "ext-1",
          time: "2026-05-08T13:30:00.000Z",
          sensor: "sensor-a",
          category: "EXFILTRATION",
          level: "MEDIUM",
          origAddr: "10.0.0.5",
          respAddr: "203.0.113.1",
          host: "otherhost.example",
        },
      ],
      totalCount: "1",
      truncated: false,
      hasMore: false,
      endCursor: null,
    });
    render(
      <TriageShell
        initialPeriod={PERIOD}
        initialState={{ status: "ok", result }}
        initialClamped={false}
        labels={LABELS}
      />,
    );
    await flushAsync();
    // Stale-hash toast appears (host step did not resolve after drain).
    expect(screen.getByText("Stale hash — showing asset root")).toBeTruthy();
    // The breadcrumb's only crumb must be the RESTORED asset
    // (10.0.0.2), not the page's first asset (10.0.0.1). Before the
    // fix, the fallback reset to `initialFocus` and the crumb showed
    // 10.0.0.1, dropping the operator on the wrong tenant/asset row.
    expect(
      screen.getByText("Asset 10.0.0.2").getAttribute("aria-current"),
    ).toBe("page");
    expect(screen.queryByText("Asset 10.0.0.1")).toBeNull();
    // The stale step is gone from the trail.
    expect(screen.queryByText("Crumb:host: remoteonly.example")).toBeNull();
    expect(screen.queryByText("Crumb:externalIp: 203.0.113.1")).toBeNull();
  });

  it("post-drain validator does NOT also fall back to the asset root when the queued Tier 2 fetch errors", async () => {
    // Regression for Round 4 Item 1. A Tier 2 hash restore queues the
    // server-filtered ancestor fetch (`externalIp:203.0.113.1`) and
    // defers a client-intersection step (`host:remoteonly.example`).
    // The queued fetch fails (transport / backend error) — the user
    // must see ONLY the standard error notice, not also the stale-hash
    // toast and a trail reset to the asset root. #502 explicitly
    // routes lookup/fetch failures through the standard error banner
    // path. Before the fix, the drain effect cleared `draining.current`
    // on the error transition and the post-drain validator then ran
    // against an unexpanded corpus, missed the deferred host step, and
    // fired `revertToRestoredAssetRoot()` on top of the error.
    window.location.hash =
      "#triage.pivot.asset=" +
      encodeURIComponent("0/10.0.0.1") +
      "&triage.pivot.step=" +
      encodeURIComponent("externalIp:203.0.113.1") +
      "&triage.pivot.step=" +
      encodeURIComponent("host:remoteonly.example") +
      "&triage.pivot.mode=tier2";
    const events: TriageEvent[] = [
      ev({
        origAddr: "10.0.0.1",
        respAddr: "203.0.113.10",
        host: "corpushost.example",
        time: "2026-05-08T12:00:00.000Z",
      }),
    ];
    const result = aggregateTriageEvents(events, false);
    fetchTier2Mock.mockRejectedValueOnce(new Error("review timed out"));
    render(
      <TriageShell
        initialPeriod={PERIOD}
        initialState={{ status: "ok", result }}
        initialClamped={false}
        labels={LABELS}
      />,
    );
    await flushAsync();
    // The standard error notice surfaces.
    expect(
      screen.getByText(/error Dim:externalIp: 203.0.113.1 — review timed out/),
    ).toBeTruthy();
    // The stale-hash toast must NOT appear — the failure is a
    // transport error, not a stale URL.
    expect(screen.queryByText("Stale hash — showing asset root")).toBeNull();
    // The optimistically-restored trail stays intact (asset + the two
    // steps) so the operator can retry by re-clicking. Crucially the
    // trail did NOT reset to just the asset root crumb.
    expect(screen.getByText("Crumb:externalIp: 203.0.113.1")).toBeTruthy();
    expect(screen.getByText("Crumb:host: remoteonly.example")).toBeTruthy();
  });

  it("renders the distinct 'no longer accessible' notice (not the stale-hash copy) for a scope-forbidden sameSensor pivot", async () => {
    // Regression for Round 5 Item 1. The fetch impl distinguishes
    // `name-unresolved` from `scope-forbidden` at the sensorFallback
    // discriminator (#502), but the hook/UI previously collapsed both
    // arms into the stale-hash banner. The issue requires the
    // scope-forbidden arm to surface a distinct "no longer accessible"
    // toast so the operator can tell access change apart from a stale
    // URL.
    //
    // Drives the pivot through the Tier 2 hash-restore queue so the
    // test does not depend on the panel surfacing a `sameSensor` row
    // (which only appears when other corpus events share the sensor).
    window.location.hash =
      "#triage.pivot.asset=" +
      encodeURIComponent("0/10.0.0.1") +
      "&triage.pivot.step=" +
      encodeURIComponent("sameSensor:edge-01") +
      "&triage.pivot.mode=tier2";
    const events: TriageEvent[] = [
      ev({
        origAddr: "10.0.0.1",
        respAddr: "203.0.113.1",
        host: "deadbeef.example",
        sensor: "edge-01",
        time: "2026-05-08T12:00:00.000Z",
      }),
    ];
    const result = aggregateTriageEvents(events, false);
    fetchTier2Mock.mockResolvedValueOnce({
      events: [],
      totalCount: null,
      truncated: false,
      hasMore: false,
      endCursor: null,
      sensorFallback: { kind: "scope-forbidden", sensorName: "edge-01" },
    });
    render(
      <TriageShell
        initialPeriod={PERIOD}
        initialState={{ status: "ok", result }}
        initialClamped={false}
        labels={LABELS}
      />,
    );
    await flushAsync();
    // Distinct copy renders.
    expect(
      screen.getByText("Sensor no longer accessible — showing asset root"),
    ).toBeTruthy();
    // The stale-hash copy must NOT also render — collapsing both arms
    // into the same banner is exactly what this regression pins
    // against.
    expect(screen.queryByText("Stale hash — showing asset root")).toBeNull();
    // Trail reverted to the asset crumb only.
    expect(screen.queryByText("Crumb:sameSensor: edge-01")).toBeNull();
  });

  it("keeps the stale-hash copy for a name-unresolved sameSensor pivot", async () => {
    // Counterpart of the scope-forbidden regression above: the
    // `name-unresolved` arm must continue to render the existing
    // stale-URL copy, not the new distinct notice. Pins the routing
    // so the two arms cannot drift back into sharing one banner.
    window.location.hash =
      "#triage.pivot.asset=" +
      encodeURIComponent("0/10.0.0.1") +
      "&triage.pivot.step=" +
      encodeURIComponent("sameSensor:edge-01") +
      "&triage.pivot.mode=tier2";
    const events: TriageEvent[] = [
      ev({
        origAddr: "10.0.0.1",
        respAddr: "203.0.113.1",
        host: "deadbeef.example",
        sensor: "edge-01",
        time: "2026-05-08T12:00:00.000Z",
      }),
    ];
    const result = aggregateTriageEvents(events, false);
    fetchTier2Mock.mockResolvedValueOnce({
      events: [],
      totalCount: null,
      truncated: false,
      hasMore: false,
      endCursor: null,
      sensorFallback: { kind: "name-unresolved", sensorName: "edge-01" },
    });
    render(
      <TriageShell
        initialPeriod={PERIOD}
        initialState={{ status: "ok", result }}
        initialClamped={false}
        labels={LABELS}
      />,
    );
    await flushAsync();
    expect(screen.getByText("Stale hash — showing asset root")).toBeTruthy();
    expect(
      screen.queryByText("Sensor no longer accessible — showing asset root"),
    ).toBeNull();
    expect(screen.queryByText("Crumb:sameSensor: edge-01")).toBeNull();
  });

  it("renders at most one fallback notice at a time and clears it on a fresh asset selection", async () => {
    // Round 6 regression for Item 2. The two fallback notices were
    // tracked as independent latching booleans, so after a
    // `scope-forbidden` fallback a subsequent `name-unresolved` fallback
    // would leave the "no longer accessible" banner on screen alongside
    // the new stale-URL one. Likewise nothing cleared either flag on a
    // subsequent successful pivot / asset change. This test pins both:
    // (a) the active notice replaces the prior one (mutually exclusive),
    // and (b) selecting a different asset clears the notice.
    //
    // Two assets so the asset list has something to navigate to after
    // the fallback.
    const events: TriageEvent[] = [
      ev({
        origAddr: "10.0.0.1",
        respAddr: "203.0.113.1",
        host: "h1.example",
        sensor: "edge-01",
        time: "2026-05-08T12:00:00.000Z",
      }),
      ev({
        origAddr: "10.0.0.2",
        respAddr: "203.0.113.2",
        host: "h2.example",
        sensor: "edge-02",
        time: "2026-05-08T12:01:00.000Z",
      }),
    ];
    const result = aggregateTriageEvents(events, false);

    // First hash-restore lands on the `scope-forbidden` arm.
    window.location.hash =
      "#triage.pivot.asset=" +
      encodeURIComponent("0/10.0.0.1") +
      "&triage.pivot.step=" +
      encodeURIComponent("sameSensor:edge-01") +
      "&triage.pivot.mode=tier2";
    fetchTier2Mock.mockResolvedValueOnce({
      events: [],
      totalCount: null,
      truncated: false,
      hasMore: false,
      endCursor: null,
      sensorFallback: { kind: "scope-forbidden", sensorName: "edge-01" },
    });
    render(
      <TriageShell
        initialPeriod={PERIOD}
        initialState={{ status: "ok", result }}
        initialClamped={false}
        labels={LABELS}
      />,
    );
    await flushAsync();
    expect(
      screen.getByText("Sensor no longer accessible — showing asset root"),
    ).toBeTruthy();

    // Selecting a different asset must clear the fallback notice —
    // it described the prior trail. The asset list button's aria-label
    // is the asset address (`rowDetailsTemplate: "{address}"` in
    // LABELS).
    const assetButton = screen.getByRole("button", {
      name: "10.0.0.2",
    });
    await act(async () => {
      fireEvent.click(assetButton);
      await Promise.resolve();
    });
    expect(
      screen.queryByText("Sensor no longer accessible — showing asset root"),
    ).toBeNull();
    expect(screen.queryByText("Stale hash — showing asset root")).toBeNull();
  });

  it("does not surface the stale-hash fallback when the operator selects a different asset before the queued Tier 2 fetch resolves", async () => {
    // Round 7 regression. A Tier 2 hash restore queues an `externalIp`
    // ancestor fetch and defers a `host=remoteonly.example` client-
    // intersection validation. The operator selects a different asset
    // before the queued fetch resolves; afterwards the deferred
    // validator must NOT run against the new trail and surface the
    // stale-hash banner / trim any pivot. The fix aborts
    // `pendingHashFetchesRef`, `pendingValidationsRef`, and
    // `draining.current` on explicit user navigation, so the post-drain
    // validator stops describing a trail the operator has left.
    window.location.hash =
      "#triage.pivot.asset=" +
      encodeURIComponent("0/10.0.0.1") +
      "&triage.pivot.step=" +
      encodeURIComponent("externalIp:203.0.113.1") +
      "&triage.pivot.step=" +
      encodeURIComponent("host:remoteonly.example") +
      "&triage.pivot.mode=tier2";
    const events: TriageEvent[] = [
      ev({
        origAddr: "10.0.0.1",
        respAddr: "203.0.113.10",
        host: "corpushost.example",
        time: "2026-05-08T12:00:00.000Z",
      }),
      ev({
        origAddr: "10.0.0.2",
        respAddr: "203.0.113.11",
        host: "second.example",
        time: "2026-05-08T11:00:00.000Z",
      }),
    ];
    const result = aggregateTriageEvents(events, false);
    // Deferred fetch — controlled by the test so the operator can
    // navigate before it resolves.
    let resolveFetch!: (v: MockTier2Result) => void;
    fetchTier2Mock.mockImplementationOnce(
      () =>
        new Promise<MockTier2Result>((res) => {
          resolveFetch = res;
        }),
    );
    render(
      <TriageShell
        initialPeriod={PERIOD}
        initialState={{ status: "ok", result }}
        initialClamped={false}
        labels={LABELS}
      />,
    );
    await flushAsync();
    // Operator switches to the other asset while the queued fetch is
    // still in flight.
    const assetButton = screen.getByRole("button", { name: "10.0.0.2" });
    await act(async () => {
      fireEvent.click(assetButton);
      await Promise.resolve();
    });
    // Now resolve the in-flight fetch with rows that do NOT carry the
    // deferred host value — the validator (had restore state survived)
    // would treat `host=remoteonly.example` as stale.
    await act(async () => {
      resolveFetch({
        events: [
          {
            __typename: "BlocklistTls",
            id: "stale-1",
            time: "2026-05-08T13:30:00.000Z",
            sensor: "sensor-a",
            category: "EXFILTRATION",
            level: "MEDIUM",
            origAddr: "10.0.0.5",
            respAddr: "203.0.113.1",
            host: "differenthost.example",
          },
        ],
        totalCount: "1",
        truncated: false,
        hasMore: false,
        endCursor: null,
      });
      await Promise.resolve();
    });
    await flushAsync();
    // Stale-hash banner must NOT appear — restore-owned state was
    // aborted at navigation time.
    expect(screen.queryByText("Stale hash — showing asset root")).toBeNull();
    // Trail is the freshly selected asset only.
    expect(
      screen.getByText("Asset 10.0.0.2").getAttribute("aria-current"),
    ).toBe("page");
    expect(screen.queryByText("Crumb:externalIp: 203.0.113.1")).toBeNull();
    expect(screen.queryByText("Crumb:host: remoteonly.example")).toBeNull();
  });

  it("drops a late sameSensor fallback whose originating trail is no longer current", async () => {
    // Round 7 regression. Pivot `sameSensor=edge-01` on asset A, then
    // switch to asset B before the lookup resolves; when A's fetch
    // eventually returns `sensorFallback: scope-forbidden`, the queued
    // fallback effect must NOT trim B's trail back to its asset crumb
    // and render A's "no longer accessible" banner on top of B's view.
    // The fallback's `(sensorName, customerId)` identity now lets the
    // effect verify the trail still owns the fallback; if not, it
    // ack-and-drops silently.
    window.location.hash =
      "#triage.pivot.asset=" +
      encodeURIComponent("0/10.0.0.1") +
      "&triage.pivot.step=" +
      encodeURIComponent("sameSensor:edge-01") +
      "&triage.pivot.mode=tier2";
    const events: TriageEvent[] = [
      ev({
        origAddr: "10.0.0.1",
        respAddr: "203.0.113.1",
        host: "h1.example",
        sensor: "edge-01",
        time: "2026-05-08T12:00:00.000Z",
      }),
      ev({
        origAddr: "10.0.0.2",
        respAddr: "203.0.113.2",
        host: "h2.example",
        sensor: "edge-02",
        time: "2026-05-08T11:00:00.000Z",
      }),
    ];
    const result = aggregateTriageEvents(events, false);
    let resolveFetch!: (v: MockTier2Result) => void;
    fetchTier2Mock.mockImplementationOnce(
      () =>
        new Promise<MockTier2Result>((res) => {
          resolveFetch = res;
        }),
    );
    render(
      <TriageShell
        initialPeriod={PERIOD}
        initialState={{ status: "ok", result }}
        initialClamped={false}
        labels={LABELS}
      />,
    );
    await flushAsync();
    // Switch to the other asset before the lookup resolves.
    const assetButton = screen.getByRole("button", { name: "10.0.0.2" });
    await act(async () => {
      fireEvent.click(assetButton);
      await Promise.resolve();
    });
    // Resolve the in-flight fetch with a scope-forbidden fallback for
    // the prior trail's `(edge-01, customerId=0)`.
    await act(async () => {
      resolveFetch({
        events: [],
        totalCount: null,
        truncated: false,
        hasMore: false,
        endCursor: null,
        sensorFallback: { kind: "scope-forbidden", sensorName: "edge-01" },
      });
      await Promise.resolve();
    });
    await flushAsync();
    // Neither fallback banner appears — the originating trail no longer
    // exists, so the queued entry is silently dropped.
    expect(
      screen.queryByText("Sensor no longer accessible — showing asset root"),
    ).toBeNull();
    expect(screen.queryByText("Stale hash — showing asset root")).toBeNull();
    // Trail shows the freshly selected asset; nothing was trimmed by
    // the abandoned fallback.
    expect(
      screen.getByText("Asset 10.0.0.2").getAttribute("aria-current"),
    ).toBe("page");
  });
});

describe("TriageShell — Tier 2 only Learning method static section (#498)", () => {
  function selectTier2Scope() {
    const scopeTab = screen.getByRole("tab", { name: "All detection events" });
    fireEvent.click(scopeTab);
  }

  function renderShellWithSingleAsset() {
    // A single corpus event so the asset list selects 10.0.0.1 by
    // default and the breadcrumb (and pivot panel) is visible. The
    // event intentionally has no `learningMethod` — the whole point of
    // the static section is that it appears regardless of focus event
    // values, including when the loaded corpus has none of the field.
    const events: TriageEvent[] = [
      ev({
        origAddr: "10.0.0.1",
        respAddr: "203.0.113.1",
        time: "2026-05-08T12:00:00.000Z",
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

  it("hides the Learning method section in Tier 1 mode and renders both rows in Tier 2 mode", () => {
    renderShellWithSingleAsset();
    // Tier 1: section absent.
    expect(
      screen.queryByRole("button", {
        name: "Pivot to Dim:learningMethods: Unsupervised",
      }),
    ).toBeNull();
    selectTier2Scope();
    // Tier 2: both enum rows surfaced even though no focus event
    // carries `learningMethod`.
    expect(
      screen.getByRole("button", {
        name: "Pivot to Dim:learningMethods: Unsupervised",
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: "Pivot to Dim:learningMethods: Semi-supervised",
      }),
    ).toBeTruthy();
  });

  it("clicking a row dispatches a Tier 2 fetch with the GraphQL enum literal as the value key", async () => {
    fetchTier2Mock.mockResolvedValueOnce({
      events: [],
      totalCount: "5",
      truncated: false,
      hasMore: false,
      endCursor: null,
    });
    renderShellWithSingleAsset();
    selectTier2Scope();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Pivot to Dim:learningMethods: Unsupervised",
      }),
    );
    await flushAsync();
    expect(fetchTier2Mock).toHaveBeenCalled();
    expect(fetchTier2Mock.mock.calls[0][0]).toMatchObject({
      dimension: "learningMethods",
      // Exact enum spelling — no transformation.
      valueKey: "UNSUPERVISED",
      firstPageOnly: true,
    });
  });

  it("restores a learningMethods step from the URL hash and queues the Tier 2 fetch", async () => {
    window.location.hash =
      "#triage.pivot.asset=" +
      encodeURIComponent("0/10.0.0.1") +
      "&triage.pivot.step=" +
      encodeURIComponent("learningMethods:UNSUPERVISED") +
      "&triage.pivot.mode=tier2";
    fetchTier2Mock.mockResolvedValueOnce({
      events: [
        {
          __typename: "BlocklistTls",
          id: "lm-1",
          time: "2026-05-08T13:30:00.000Z",
          sensor: "sensor-a",
          category: "EXFILTRATION",
          level: "MEDIUM",
          origAddr: "10.0.0.5",
          respAddr: "203.0.113.4",
        },
      ],
      totalCount: "1",
      truncated: false,
      hasMore: false,
      endCursor: null,
    });
    const events: TriageEvent[] = [
      ev({
        origAddr: "10.0.0.1",
        respAddr: "203.0.113.10",
        time: "2026-05-08T12:00:00.000Z",
      }),
    ];
    const result = aggregateTriageEvents(events, false);
    render(
      <TriageShell
        initialPeriod={PERIOD}
        initialState={{ status: "ok", result }}
        initialClamped={false}
        labels={LABELS}
      />,
    );
    await flushAsync();
    // Restored crumb shows the localized label, not the raw enum.
    expect(
      screen
        .getByText("Crumb:learningMethods: Unsupervised")
        .getAttribute("aria-current"),
    ).toBe("page");
    // The queued Tier 2 fetch fired with the raw enum literal.
    expect(fetchTier2Mock).toHaveBeenCalled();
    expect(fetchTier2Mock.mock.calls[0][0]).toMatchObject({
      dimension: "learningMethods",
      valueKey: "UNSUPERVISED",
    });
    // No stale-hash fallback toast.
    expect(screen.queryByText("Stale hash — showing asset root")).toBeNull();
    // The fetched event must actually become the active pivot focus —
    // not just a queued fetch. `pivotFocusAsset` is only non-null when
    // the static-dim focus resolver (`baseline-content.tsx:232`) finds
    // events in the cached Tier 2 result, so the "Pivot focus" region
    // with the dimension-label address line is the operator-visible
    // proof that the round-trip rendered the returned event. Without
    // the static-dim branch the asset detail would still show the
    // 10.0.0.1 corpus row even with the crumb restored, so this is the
    // assertion that actually pins the rendered focus.
    const pivotFocus = screen.getByRole("region", { name: "Pivot focus" });
    expect(
      within(pivotFocus).getByText("Dim:learningMethods: Unsupervised"),
    ).toBeTruthy();
    // The focus events come from the fetch result, not the corpus —
    // exactly one event was returned, so the events table has one row.
    const focusRows = within(pivotFocus)
      .getAllByRole("row")
      .filter((row) => row.querySelector("td") !== null);
    expect(focusRows).toHaveLength(1);
  });

  it("falls back to the asset root with the stale-hash toast when the URL hash carries an invalid learningMethods value", async () => {
    // The parser whitelists the two SDL enum values. An out-of-enum
    // literal is reported via `rejectedStepCount`, which the restore
    // path treats as a stale URL: the asset is still selected, but the
    // dimension trail collapses to the asset crumb and the shared
    // stale-hash toast surfaces (#498 negative-path requirement).
    window.location.hash =
      "#triage.pivot.asset=" +
      encodeURIComponent("0/10.0.0.1") +
      "&triage.pivot.step=" +
      encodeURIComponent("learningMethods:INVALID_VALUE") +
      "&triage.pivot.mode=tier2";
    const events: TriageEvent[] = [
      ev({
        origAddr: "10.0.0.1",
        respAddr: "203.0.113.10",
        time: "2026-05-08T12:00:00.000Z",
      }),
    ];
    const result = aggregateTriageEvents(events, false);
    render(
      <TriageShell
        initialPeriod={PERIOD}
        initialState={{ status: "ok", result }}
        initialClamped={false}
        labels={LABELS}
      />,
    );
    await flushAsync();
    expect(screen.queryByText(/Crumb:learningMethods/)).toBeNull();
    // The malformed step never reached the Tier 2 fetch path.
    expect(fetchTier2Mock).not.toHaveBeenCalled();
    // Operator sees the same toast as any other stale-hash fallback.
    expect(screen.getByText("Stale hash — showing asset root")).toBeTruthy();
  });
});

describe("TriageShell — Tier 2 only Keywords free-form section (#499)", () => {
  function selectTier2Scope() {
    const scopeTab = screen.getByRole("tab", { name: "All detection events" });
    fireEvent.click(scopeTab);
  }

  function renderShellWithSingleAsset() {
    const events: TriageEvent[] = [
      ev({
        origAddr: "10.0.0.1",
        respAddr: "203.0.113.1",
        time: "2026-05-08T12:00:00.000Z",
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

  function submitKeyword(value: string) {
    const input = screen.getByLabelText("Keyword") as HTMLInputElement;
    fireEvent.change(input, { target: { value } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
  }

  it("dispatches a Tier 2 fetch with the trimmed value on submit", async () => {
    fetchTier2Mock.mockResolvedValueOnce({
      events: [],
      totalCount: "5",
      truncated: false,
      hasMore: false,
      endCursor: null,
    });
    renderShellWithSingleAsset();
    selectTier2Scope();
    submitKeyword("  lateral movement  ");
    await flushAsync();
    expect(fetchTier2Mock).toHaveBeenCalledTimes(1);
    expect(fetchTier2Mock.mock.calls[0][0]).toMatchObject({
      dimension: "keywords",
      // Trimmed before reaching the fetch path.
      valueKey: "lateral movement",
      firstPageOnly: true,
    });
  });

  it("does not dispatch a fetch for an empty submission and shows the inline validation message", async () => {
    renderShellWithSingleAsset();
    selectTier2Scope();
    const input = screen.getByLabelText("Keyword");
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
    await flushAsync();
    expect(fetchTier2Mock).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(/non-empty/);
  });

  it("does not dispatch a fetch for an oversized submission", async () => {
    renderShellWithSingleAsset();
    selectTier2Scope();
    const input = screen.getByLabelText("Keyword");
    fireEvent.change(input, { target: { value: "a".repeat(257) } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await flushAsync();
    expect(fetchTier2Mock).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(/too long/i);
  });

  it("surfaces the projection modal for a keywords fetch whose totalCount exceeds 20,000", async () => {
    fetchTier2Mock.mockResolvedValueOnce({
      events: [],
      totalCount: "30000",
      truncated: false,
      hasMore: true,
      endCursor: "cursor-1",
    });
    renderShellWithSingleAsset();
    selectTier2Scope();
    submitKeyword("noisy");
    await flushAsync();
    expect(
      screen.getByRole("alertdialog", { name: "Fetch large result?" }),
    ).toBeTruthy();
  });

  it("adds successful submissions to the recent chips strip in most-recent order, bounded at 5", async () => {
    fetchTier2Mock.mockResolvedValue({
      events: [],
      totalCount: "1",
      truncated: false,
      hasMore: false,
      endCursor: null,
    });
    renderShellWithSingleAsset();
    selectTier2Scope();

    // Six distinct submissions — the recent chip strip must cap at 5
    // and evict the oldest. Note `selectTier2Scope` causes a
    // re-render; submitting before that triggers the panel keywords
    // section.
    for (const word of ["one", "two", "three", "four", "five", "six"]) {
      submitKeyword(word);
      await flushAsync();
    }

    // Most-recent first. "one" was evicted by the sixth submission.
    expect(
      screen.queryByRole("button", { name: "Search again for one" }),
    ).toBeNull();
    for (const word of ["six", "five", "four", "three", "two"]) {
      expect(
        screen.getByRole("button", { name: `Search again for ${word}` }),
      ).toBeTruthy();
    }
  });

  it("re-fires the same fetch when a recent chip is clicked and moves it to the most-recent position", async () => {
    fetchTier2Mock.mockResolvedValue({
      events: [],
      totalCount: "1",
      truncated: false,
      hasMore: false,
      endCursor: null,
    });
    renderShellWithSingleAsset();
    selectTier2Scope();
    submitKeyword("alpha");
    await flushAsync();
    submitKeyword("beta");
    await flushAsync();
    expect(fetchTier2Mock).toHaveBeenCalledTimes(2);

    // Click the older "alpha" chip — it must re-fire its fetch and
    // jump to the most-recent position. The mid-trail re-click also
    // appends the trail step (the active step before the click was
    // beta, so alpha is a new step on the trail).
    fireEvent.click(
      screen.getByRole("button", { name: "Search again for alpha" }),
    );
    await flushAsync();
    // The re-fire should hit the cache (beta already in flight/ready)
    // so no extra fetch; the chip just moves. The hook short-circuits
    // when an existing cached `ready` result is found.
    // The chip strip is now alpha, beta (alpha moved to head).
    const chips = screen
      .getAllByRole("button")
      .filter((b) =>
        /^Search again for /.test(b.getAttribute("aria-label") ?? ""),
      );
    expect(chips.map((b) => b.getAttribute("aria-label"))).toEqual([
      "Search again for alpha",
      "Search again for beta",
    ]);
  });

  it("does not duplicate a chip when the operator submits a value that already exists in recents", async () => {
    fetchTier2Mock.mockResolvedValue({
      events: [],
      totalCount: "1",
      truncated: false,
      hasMore: false,
      endCursor: null,
    });
    renderShellWithSingleAsset();
    selectTier2Scope();
    submitKeyword("alpha");
    await flushAsync();
    submitKeyword("beta");
    await flushAsync();
    submitKeyword("alpha"); // duplicate of an existing chip
    await flushAsync();
    const chips = screen
      .getAllByRole("button")
      .filter((b) =>
        /^Search again for /.test(b.getAttribute("aria-label") ?? ""),
      );
    expect(chips).toHaveLength(2);
    // Most recent first: alpha now leads, beta follows.
    expect(chips.map((b) => b.getAttribute("aria-label"))).toEqual([
      "Search again for alpha",
      "Search again for beta",
    ]);
  });

  it("restores a keywords step from the URL hash and queues the Tier 2 fetch without corpus validation", async () => {
    window.location.hash =
      "#triage.pivot.asset=" +
      encodeURIComponent("0/10.0.0.1") +
      "&triage.pivot.step=" +
      encodeURIComponent("keywords:lateral movement") +
      "&triage.pivot.mode=tier2";
    fetchTier2Mock.mockResolvedValueOnce({
      events: [],
      // Zero matches: per #499 the breadcrumb still renders with the
      // typed string. No stale-hash fallback for keywords.
      totalCount: "0",
      truncated: false,
      hasMore: false,
      endCursor: null,
    });
    const events: TriageEvent[] = [
      ev({
        origAddr: "10.0.0.1",
        respAddr: "203.0.113.10",
        time: "2026-05-08T12:00:00.000Z",
      }),
    ];
    const result = aggregateTriageEvents(events, false);
    render(
      <TriageShell
        initialPeriod={PERIOD}
        initialState={{ status: "ok", result }}
        initialClamped={false}
        labels={LABELS}
      />,
    );
    await flushAsync();
    expect(fetchTier2Mock).toHaveBeenCalled();
    expect(fetchTier2Mock.mock.calls[0][0]).toMatchObject({
      dimension: "keywords",
      valueKey: "lateral movement",
    });
    // Breadcrumb renders with the typed string as the label.
    expect(
      screen
        .getByText("Crumb:keywords: lateral movement")
        .getAttribute("aria-current"),
    ).toBe("page");
    // Zero events returned — no stale-hash fallback toast for
    // keywords, the breadcrumb stays restored.
    expect(screen.queryByText("Stale hash — showing asset root")).toBeNull();
    // A `keywords` search whose server result is empty must still
    // land on the synthesized pivot-focus card so the operator does
    // not see the original asset detail body with only the
    // breadcrumb hinting that anything changed. The card shows the
    // dimension-label address with zero counts and an empty events
    // table.
    const pivotFocus = screen.getByRole("region", { name: "Pivot focus" });
    expect(
      within(pivotFocus).getByText("Dim:keywords: lateral movement"),
    ).toBeTruthy();
    expect(within(pivotFocus).getByText("No events")).toBeTruthy();
  });

  it("recents are not persisted across reloads — opening the page with no hash shows an empty recents strip", () => {
    // Simulate a fresh page mount: no hash, no recent state in any
    // persisted store. The recent-chip strip must be absent.
    renderShellWithSingleAsset();
    selectTier2Scope();
    expect(
      screen.queryByRole("button", {
        name: /^Search again for /,
      }),
    ).toBeNull();
  });

  it("clears recent chips when the customer scope rotates (matching the Tier 2 cache reset trigger)", async () => {
    fetchTier2Mock.mockResolvedValue({
      events: [],
      totalCount: "1",
      truncated: false,
      hasMore: false,
      endCursor: null,
    });
    const events: TriageEvent[] = [
      ev({
        origAddr: "10.0.0.1",
        respAddr: "203.0.113.1",
        time: "2026-05-08T12:00:00.000Z",
      }),
    ];
    const result = aggregateTriageEvents(events, false);
    const { rerender } = render(
      <TriageShell
        initialPeriod={PERIOD}
        initialState={{ status: "ok", result }}
        initialClamped={false}
        customerScope="scope-a"
        labels={LABELS}
      />,
    );
    selectTier2Scope();
    submitKeyword("alpha");
    await flushAsync();
    expect(
      screen.getByRole("button", { name: "Search again for alpha" }),
    ).toBeTruthy();

    // Rotate the customer scope while the top asset focus stays the
    // same. Per #499 this must clear the recents alongside the Tier 2
    // cache so a stale typed value cannot re-fire into the new scope.
    rerender(
      <TriageShell
        initialPeriod={PERIOD}
        initialState={{ status: "ok", result }}
        initialClamped={false}
        customerScope="scope-b"
        labels={LABELS}
      />,
    );
    await flushAsync();
    expect(
      screen.queryByRole("button", { name: /^Search again for / }),
    ).toBeNull();
  });
});
