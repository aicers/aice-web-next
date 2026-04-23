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
    downloadComingSoon: "Coming soon",
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
