/**
 * Issue #429 §3 + §6: stale-data inline notice rendered after a preset
 * activation match-focuses an existing tab whose last fetch is older
 * than {@link STALE_THRESHOLD_MS}. Locks the contract:
 *
 *  - notice does not appear when the data is fresh (last fetch within
 *    threshold) — avoids spamming a tab the operator just refreshed,
 *  - notice appears once per `matchFocusEvent.at` and is cleared by
 *    Refresh — repeated clicks of the same preset within a short
 *    window do not stack toasts (§6),
 *  - notice does not appear without a match-focus event — unrelated
 *    state changes (scroll, hover) cannot re-emit it.
 *
 * Companion to `result-list-rendering.test.tsx`, which covers the
 * static markup of every other ResultList branch.
 */

import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  ResultList,
  type ResultListLabels,
  type ResultListState,
  STALE_THRESHOLD_MS,
} from "@/components/detection/result-list";

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
    staleNoticePrefix: (relative) => `Last updated ${relative}`,
    staleNoticeRefresh: "Refresh now",
    peekLostNotice: "This event is no longer in the list.",
    peekLostDismiss: "Dismiss",
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
    userNameLabel: "User:",
    hostnameLabel: "Host:",
    pivotActivate: ({ label, value }) => `Filter by ${label}: ${value}`,
    pivotColumnLabels: {
      origAddr: "Source IP",
      respAddr: "Destination IP",
      origCountry: "Source country",
      respCountry: "Destination country",
      level: "Level",
      category: "Category",
      kind: "Kind",
      userName: "User name",
      hostname: "Hostname",
    },
  };
}

function readyState(lastUpdatedMs: number | null): ResultListState {
  return {
    status: "ready",
    events: [],
    eventKeys: [],
    totalCount: "0",
    range: { start: "1", end: "0" },
    lastUpdatedMs,
  };
}

describe("ResultList stale-focus notice — issue #429 §3 + §6", () => {
  it("does not render the notice without a match-focus event", () => {
    const stale = Date.now() - STALE_THRESHOLD_MS - 60_000;
    const { container } = render(
      <ResultList
        state={readyState(stale)}
        labels={labels()}
        locale="en"
        onRefresh={() => {}}
      />,
    );
    expect(
      container.querySelector("[data-slot='result-stale-notice']"),
    ).toBeNull();
  });

  it("does not render the notice when the data is still fresh", () => {
    const fresh = Date.now() - 30_000; // 30s old, well under threshold
    const { container } = render(
      <ResultList
        state={readyState(fresh)}
        labels={labels()}
        locale="en"
        onRefresh={() => {}}
        matchFocusEvent={{ at: 12345 }}
      />,
    );
    expect(
      container.querySelector("[data-slot='result-stale-notice']"),
    ).toBeNull();
  });

  it("renders the notice when stale data is match-focused, with a Refresh button that fires onRefresh", () => {
    const stale = Date.now() - STALE_THRESHOLD_MS - 60_000;
    const onRefresh = vi.fn();
    const { container, getByText } = render(
      <ResultList
        state={readyState(stale)}
        labels={labels()}
        locale="en"
        onRefresh={onRefresh}
        matchFocusEvent={{ at: 12345 }}
      />,
    );
    const notice = container.querySelector("[data-slot='result-stale-notice']");
    expect(notice).not.toBeNull();
    fireEvent.click(getByText("Refresh now"));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("clears the notice once Refresh has been clicked, even if the focus event prop persists", () => {
    const stale = Date.now() - STALE_THRESHOLD_MS - 60_000;
    const { container, getByText, rerender } = render(
      <ResultList
        state={readyState(stale)}
        labels={labels()}
        locale="en"
        onRefresh={() => {}}
        matchFocusEvent={{ at: 12345 }}
      />,
    );
    expect(
      container.querySelector("[data-slot='result-stale-notice']"),
    ).not.toBeNull();
    fireEvent.click(getByText("Refresh now"));
    rerender(
      <ResultList
        state={readyState(stale)}
        labels={labels()}
        locale="en"
        onRefresh={() => {}}
        matchFocusEvent={{ at: 12345 }}
      />,
    );
    expect(
      container.querySelector("[data-slot='result-stale-notice']"),
    ).toBeNull();
  });

  // Issue #429 §6: when a Refresh / Apply removes the event the open
  // Quick peek pointed to, the shell closes the inspector and surfaces
  // a notice — silent strip would leave the operator confused.
  it("renders the peek-lost notice when peekLostAt is set, and dismisses it via the button", () => {
    const onDismiss = vi.fn();
    const { container, getByText, rerender } = render(
      <ResultList
        state={readyState(Date.now())}
        labels={labels()}
        locale="en"
        onRefresh={() => {}}
        peekLostAt={42}
        onDismissPeekLost={onDismiss}
      />,
    );
    expect(
      container.querySelector("[data-slot='result-peek-lost-notice']"),
    ).not.toBeNull();
    fireEvent.click(getByText("Dismiss"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    rerender(
      <ResultList
        state={readyState(Date.now())}
        labels={labels()}
        locale="en"
        onRefresh={() => {}}
        peekLostAt={42}
        onDismissPeekLost={onDismiss}
      />,
    );
    expect(
      container.querySelector("[data-slot='result-peek-lost-notice']"),
    ).toBeNull();
  });

  it("re-renders the peek-lost notice on a fresh peekLostAt value", () => {
    const { container, getByText, rerender } = render(
      <ResultList
        state={readyState(Date.now())}
        labels={labels()}
        locale="en"
        onRefresh={() => {}}
        peekLostAt={1}
        onDismissPeekLost={() => {}}
      />,
    );
    fireEvent.click(getByText("Dismiss"));
    rerender(
      <ResultList
        state={readyState(Date.now())}
        labels={labels()}
        locale="en"
        onRefresh={() => {}}
        peekLostAt={2}
        onDismissPeekLost={() => {}}
      />,
    );
    expect(
      container.querySelector("[data-slot='result-peek-lost-notice']"),
    ).not.toBeNull();
  });

  it("does not render the peek-lost notice when peekLostAt is null", () => {
    const { container } = render(
      <ResultList
        state={readyState(Date.now())}
        labels={labels()}
        locale="en"
        onRefresh={() => {}}
        peekLostAt={null}
      />,
    );
    expect(
      container.querySelector("[data-slot='result-peek-lost-notice']"),
    ).toBeNull();
  });

  it("re-renders the notice on a fresh focus event with a different `at`", () => {
    const stale = Date.now() - STALE_THRESHOLD_MS - 60_000;
    const { container, rerender } = render(
      <ResultList
        state={readyState(stale)}
        labels={labels()}
        locale="en"
        onRefresh={() => {}}
        matchFocusEvent={{ at: 1 }}
      />,
    );
    expect(
      container.querySelector("[data-slot='result-stale-notice']"),
    ).not.toBeNull();
    rerender(
      <ResultList
        state={readyState(stale)}
        labels={labels()}
        locale="en"
        onRefresh={() => {}}
        matchFocusEvent={{ at: 2 }}
      />,
    );
    expect(
      container.querySelector("[data-slot='result-stale-notice']"),
    ).not.toBeNull();
  });
});
