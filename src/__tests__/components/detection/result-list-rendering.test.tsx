import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ResultList,
  type ResultListLabels,
  type ResultListState,
} from "@/components/detection/result-list";
import type { Event } from "@/lib/detection/types";

function labels(): ResultListLabels {
  return {
    countWithRange: ({ range, total }) => `Events ${range} / ${total}`,
    totalOnly: ({ total }) => `Events / ${total}`,
    download: "Download CSV",
    downloadRunning: "Exporting…",
    downloadErrorTitle: "Could not export",
    downloadErrorDismiss: "Dismiss",
    refresh: "Refresh",
    updatedJustNow: "Updated just now",
    updatedSecondsAgo: (s) => `Updated ${s} sec ago`,
    updatedMinutesAgo: (m) => `Updated ${m} min ago`,
    updatedHoursAgo: (h) => `Updated ${h} hr ago`,
    loadingTitle: "Loading",
    loadingDescription: "Loading detection events",
    errorTitle: "Error",
    errorDescription: "Error description",
    errorRetry: "Retry",
    emptyResultsTitle: "No matches",
    emptyResultsDescription: "No matches description",
    emptyFilterTitle: "Build a filter",
    emptyFilterDescription: "Open the drawer",
    emptyFilterAction: "Open filters",
    rowOpenLabel: "Open quick peek",
    rowInvestigateLabel: "Open investigation",
    quickPeekClose: "Close Quick peek",
    unknownTime: "Unknown time",
    noSensor: "Unknown sensor",
    confidenceLabel: "Conf:",
    triageSummary: ({ count, max }) => `${count} policies · ${max} max`,
    endpointSeparator: "→",
    moreCountSuffix: (count) => `+${count} more`,
    countryUnknown: "??",
    countryUnavailable: "—",
    levelLabels: { LOW: "Low", MEDIUM: "Medium", HIGH: "High" },
    categoryLabels: {
      RECONNAISSANCE: "Reconnaissance",
      INITIAL_ACCESS: "Initial Access",
      EXECUTION: "Execution",
      CREDENTIAL_ACCESS: "Credential Access",
      DISCOVERY: "Discovery",
      LATERAL_MOVEMENT: "Lateral Movement",
      COMMAND_AND_CONTROL: "Command and Control",
      EXFILTRATION: "Exfiltration",
      IMPACT: "Impact",
      COLLECTION: "Collection",
      DEFENSE_EVASION: "Defense Evasion",
      PERSISTENCE: "Persistence",
      PRIVILEGE_ESCALATION: "Privilege Escalation",
      RESOURCE_DEVELOPMENT: "Resource Development",
    },
    attackKindLabel: "Attack:",
    pivotActivate: ({ label, value }) => `Filter by ${label}: ${value}`,
    pivotColumnLabels: {
      origAddr: "Source IP",
      respAddr: "Destination IP",
      origCountry: "Source country",
      respCountry: "Destination country",
      level: "Level",
      category: "Category",
      kind: "Kind",
    },
  };
}

function baseEvent(overrides: Partial<Event> = {}): Event {
  return {
    __typename: "HttpThreat",
    time: "2026-04-22T00:00:00.000Z",
    sensor: "sensor-1",
    confidence: 0.8,
    category: "LATERAL_MOVEMENT",
    level: "HIGH",
    triageScores: null,
    ...overrides,
  } as Event;
}

function state(events: Event[]): ResultListState {
  return {
    status: "ready",
    events,
    eventKeys: events.map((_, i) => `cursor-${i}`),
    totalCount: String(events.length),
    range: { start: "1", end: String(events.length) },
    lastUpdatedMs: null,
  };
}

describe("ResultList row rendering", () => {
  it("renders the friendly category label, not the raw enum value", () => {
    const html = renderToStaticMarkup(
      <ResultList
        state={state([
          baseEvent({ category: "LATERAL_MOVEMENT" }),
          baseEvent({ category: "COMMAND_AND_CONTROL" }),
        ])}
        labels={labels()}
        locale="en"
        onRefresh={() => {}}
      />,
    );

    expect(html).toContain("Lateral Movement");
    expect(html).toContain("Command and Control");
    // Raw enum keys must not leak into the UI.
    expect(html).not.toContain("LATERAL_MOVEMENT");
    expect(html).not.toContain("COMMAND_AND_CONTROL");
  });

  it("omits the category badge when the event has no category", () => {
    const html = renderToStaticMarkup(
      <ResultList
        state={state([baseEvent({ category: null })])}
        labels={labels()}
        locale="en"
        onRefresh={() => {}}
      />,
    );
    // None of the friendly labels should appear when category is null.
    expect(html).not.toContain("Lateral Movement");
    expect(html).not.toContain("Reconnaissance");
  });

  it("renders the +N more trigger with aria-expanded=false initially", () => {
    const html = renderToStaticMarkup(
      <ResultList
        state={state([
          baseEvent({
            __typename: "UnusualDestinationPattern",
            respAddrs: ["10.0.0.1", "10.0.0.2", "10.0.0.3", "10.0.0.4"],
          } as unknown as Partial<Event>),
        ])}
        labels={labels()}
        locale="en"
        onRefresh={() => {}}
      />,
    );

    // Trigger must be a button (so the button's own toggle handler
    // owns the close case) with aria-expanded=false on first render.
    expect(html).toMatch(
      /<button[^>]*aria-expanded="false"[^>]*aria-haspopup="dialog"/,
    );
    // Initial render should not open the popover panel.
    expect(html).not.toContain('role="dialog"');
  });

  it("does not nest the +N more trigger inside the row-open button", () => {
    // The row-open overlay button must be a sibling of MorePopover's own
    // button — nesting interactive controls is invalid HTML and, in
    // browsers, routes the popover click back through the outer button.
    const html = renderToStaticMarkup(
      <ResultList
        state={state([
          baseEvent({
            __typename: "UnusualDestinationPattern",
            respAddrs: ["10.0.0.1", "10.0.0.2", "10.0.0.3", "10.0.0.4"],
          } as unknown as Partial<Event>),
        ])}
        labels={labels()}
        locale="en"
        onRefresh={() => {}}
        onRowOpen={() => {}}
      />,
    );

    // No `<button>` opens while another `<button>` is still open
    // inside it — a quick structural guard that catches the regression.
    expect(html).not.toMatch(/<button[^>]*>[^<]*<button/);
  });

  it("hides the investigate chevron when the event cannot be located", () => {
    // ExtraThreat / WindowsThreat / UnusualDestinationPattern without a
    // singular origAddr have no encodable locator — the chevron would
    // silently no-op, so it must not render at all.
    const html = renderToStaticMarkup(
      <ResultList
        state={state([
          baseEvent({
            __typename: "WindowsThreat",
            // no origAddr / respAddr — schema-limited subtype
          } as unknown as Partial<Event>),
        ])}
        labels={labels()}
        locale="en"
        onRefresh={() => {}}
        onRowOpen={() => {}}
        onRowInvestigate={() => {}}
      />,
    );

    expect(html).not.toContain("Open investigation");
  });

  it("still renders the Quick peek row-open overlay for non-addressable events (issue #290)", () => {
    // Round 4 feedback: the issue's acceptance says "Selecting any
    // row opens the peek", so schema-limited subtypes (e.g.
    // `WindowsThreat`, `ExtraThreat`) still expose the row-open
    // overlay. The URL persistence limitation — no encodable locator
    // means reload cannot restore the selection — is tolerated
    // rather than used as a reason to drop the feature, and the
    // investigate chevron continues to be hidden independently.
    const html = renderToStaticMarkup(
      <ResultList
        state={state([
          baseEvent({
            __typename: "WindowsThreat",
            // no origAddr / respAddr — schema-limited subtype
          } as unknown as Partial<Event>),
        ])}
        labels={labels()}
        locale="en"
        onRefresh={() => {}}
        onRowOpen={() => {}}
      />,
    );

    expect(html).toContain("Open quick peek");
  });

  it("renders the Quick peek row-open overlay for addressable events", () => {
    const html = renderToStaticMarkup(
      <ResultList
        state={state([
          baseEvent({
            __typename: "HttpThreat",
            origAddr: "10.0.0.5",
            origPort: 1234,
            respAddr: "10.0.0.6",
            respPort: 443,
          } as unknown as Partial<Event>),
        ])}
        labels={labels()}
        locale="en"
        onRefresh={() => {}}
        onRowOpen={() => {}}
      />,
    );

    expect(html).toContain("Open quick peek");
  });

  it("renders the investigate chevron when the event is addressable", () => {
    const html = renderToStaticMarkup(
      <ResultList
        state={state([
          baseEvent({
            __typename: "HttpThreat",
            origAddr: "10.0.0.5",
            origPort: 1234,
            respAddr: "10.0.0.6",
            respPort: 443,
          } as unknown as Partial<Event>),
        ])}
        labels={labels()}
        locale="en"
        onRefresh={() => {}}
        onRowOpen={() => {}}
        onRowInvestigate={() => {}}
      />,
    );

    expect(html).toContain("Open investigation");
  });

  it("disables the Refresh button in `empty-prequery` so a `+`-created tab cannot bypass Apply (issue #281, Reviewer Round 7)", () => {
    // A new tab seeded by `+` lands in `empty-prequery` until Apply
    // runs the first query. The header Refresh affordance must stay
    // disabled in that state — otherwise a click on Refresh would
    // dispatch the seeded default filter and populate results without
    // the operator opening the drawer / clicking Apply, contradicting
    // #281 ("`+` does not auto-run").
    const prequeryState: ResultListState = {
      status: "empty-prequery",
      events: [],
      eventKeys: [],
      totalCount: null,
      range: null,
      lastUpdatedMs: null,
    };

    const html = renderToStaticMarkup(
      <ResultList
        state={prequeryState}
        labels={labels()}
        locale="en"
        onRefresh={() => {
          throw new Error(
            "Refresh must not fire while the tab is in empty-prequery",
          );
        }}
        onOpenFilters={() => {}}
      />,
    );

    // The Refresh button renders but is disabled.
    expect(html).toMatch(/<button[^>]*aria-label="Refresh"[^>]*disabled/);
    // The pre-query empty-state CTA still routes the operator to the
    // drawer.
    expect(html).toContain("Open filters");
  });

  it("keeps the Refresh button enabled in the `error` state so a failed bootstrap query can be retried (issue #281, Reviewer Round 8 item 1)", () => {
    // Page entry always attempts the first query. When that fails,
    // `bootstrapTabToSnapshot` now marks the tab as `hasQueried`
    // (without setting `lastUpdatedMs`), so the result list lands on
    // `status: "error"` rather than `empty-prequery`. The header
    // Refresh affordance must stay enabled in that state — otherwise
    // both it and the in-panel Retry button (which share the same
    // `onRefresh` handler) would render as visible-but-dead controls.
    const errorState: ResultListState = {
      status: "error",
      events: [],
      eventKeys: [],
      totalCount: null,
      range: null,
      lastUpdatedMs: null,
    };

    const html = renderToStaticMarkup(
      <ResultList
        state={errorState}
        labels={labels()}
        locale="en"
        onRefresh={() => {}}
        onOpenFilters={() => {}}
      />,
    );

    // The Refresh button renders without the `disabled` attribute.
    expect(html).toMatch(/<button[^>]*aria-label="Refresh"(?![^>]*disabled)/);
    // The error panel still surfaces the in-panel Retry CTA.
    expect(html).toContain("Retry");
  });

  it("drops row-open and investigate affordances while loading with a retained slice (issue #290, Reviewer Round 8)", () => {
    // Regression: during a committed-query transition (Apply / chip ×
    // / Refresh) the shell closes Quick peek at dispatch but keeps
    // rendering the previous slice under `status: "loading"` so the
    // results region does not flash. If those retained rows stayed
    // interactive, a click during the loading window could reopen the
    // peek on an event the newly committed filter may no longer
    // return — re-introducing the stale-inspector window #290's state
    // contract forbids. With the gate in place, the overlay button
    // and investigate chevron are both absent from the retained
    // slice.
    const loadingRetained: ResultListState = {
      status: "loading",
      events: [
        baseEvent({
          __typename: "HttpThreat",
          origAddr: "10.0.0.5",
          origPort: 1234,
          respAddr: "10.0.0.6",
          respPort: 443,
        } as unknown as Partial<Event>),
      ],
      eventKeys: ["cursor-stale-0"],
      totalCount: "1",
      range: { start: "1", end: "1" },
      lastUpdatedMs: null,
    };

    const html = renderToStaticMarkup(
      <ResultList
        state={loadingRetained}
        labels={labels()}
        locale="en"
        onRefresh={() => {}}
        onRowOpen={() => {
          throw new Error("onRowOpen must not be wired through during loading");
        }}
        onRowInvestigate={() => {
          throw new Error(
            "onRowInvestigate must not be wired through during loading",
          );
        }}
      />,
    );

    // Row renders (retained-slice UX) but its interactive affordances
    // are gone — the user cannot re-open Quick peek on the stale row.
    expect(html).toContain("HTTP Threat");
    expect(html).not.toContain("Open quick peek");
    expect(html).not.toContain("Open investigation");
  });
});

// Two rows whose content is byte-for-byte identical (same __typename,
// time, sensor, and endpoint tuple) must still be keyed distinctly so
// a re-render or filter change cannot collapse them onto a single
// React-reconciled row (which would leak per-row state like
// `MorePopover` open/close between rows). The server emits a unique
// cursor per edge — the list is supposed to key on that. Guard the
// contract with a duplicate-content regression that fails loudly if
// the list ever falls back to a content-composite key.
describe("ResultList row keys — duplicate content", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("renders duplicate-content rows separately and emits no duplicate-key warning", () => {
    const duplicate = baseEvent({
      __typename: "HttpThreat",
      origAddr: "10.0.0.5",
      origPort: 1234,
      respAddr: "10.0.0.6",
      respPort: 443,
    } as unknown as Partial<Event>);
    // Two byte-identical events with distinct cursors from the server.
    const resultState: ResultListState = {
      status: "ready",
      events: [duplicate, { ...duplicate }],
      eventKeys: ["cursor-a", "cursor-b"],
      totalCount: "2",
      range: { start: "1", end: "2" },
      lastUpdatedMs: null,
    };

    const html = renderToStaticMarkup(
      <ResultList
        state={resultState}
        labels={labels()}
        locale="en"
        onRefresh={() => {}}
        onRowOpen={() => {}}
        onRowInvestigate={() => {}}
      />,
    );

    // Both rows must render — the reconciler should treat them as
    // two distinct siblings.
    const rowMatches = html.match(/aria-label="Open quick peek"/g);
    expect(rowMatches?.length).toBe(2);

    // React logs a `console.error` for duplicate keys. If the list
    // ever reverts to a content-composite key, the two identical
    // events will collide and this assertion fires.
    const duplicateKeyWarning = errorSpy.mock.calls.find((args: unknown[]) =>
      args.some(
        (arg) =>
          typeof arg === "string" &&
          arg.includes("Encountered two children with the same key"),
      ),
    );
    expect(duplicateKeyWarning).toBeUndefined();
  });
});
