import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

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
});
