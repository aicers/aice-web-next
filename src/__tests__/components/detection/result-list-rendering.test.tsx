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

describe("ResultList pivot affordances (Reviewer Round 1)", () => {
  // Round 1 feedback: the pivot button wiring on result cells (issue
  // #283 acceptance: "Pivotable cell values render as clickable
  // affordances [...] keyboard-focusable") had no React-surface
  // tests. The pure pivot logic (`buildPivotPatch`,
  // `applyPivotPatch`, `openPivotTab`) was covered, but a regression
  // that dropped the `<button>` wrapper or the `data-slot` /
  // aria-label plumbing would still pass. These tests lock the
  // structural contract so a refactor cannot collapse the cell back
  // into a plain `<span>` without failing here.

  function pivotableHttpThreatRow(): Event {
    return baseEvent({
      __typename: "HttpThreat",
      origAddr: "10.0.0.5",
      origPort: 1234,
      respAddr: "203.0.113.45",
      respPort: 443,
      origCountry: "KR",
      respCountry: "US",
      level: "HIGH",
      category: "LATERAL_MOVEMENT",
    } as unknown as Partial<Event>);
  }

  it("renders pivotable cells (level / kind / category / origAddr / respAddr / origCountry / respCountry) as `<button>` elements when `onPivot` is wired", () => {
    const html = renderToStaticMarkup(
      <ResultList
        state={state([pivotableHttpThreatRow()])}
        labels={labels()}
        locale="en"
        onRefresh={() => {}}
        onPivot={() => {}}
      />,
    );

    // Each pivotable column renders a button carrying the structural
    // data-slot attribute so the chip set can be located in the DOM.
    const slotMatches = html.match(/data-slot="detection-pivot-cell"/g);
    // Level + kind + category + origAddr + respAddr + origCountry +
    // respCountry = 7 cells for a fully-addressable HttpThreat row.
    expect(slotMatches?.length ?? 0).toBeGreaterThanOrEqual(7);
    // All matches must be on `<button>` elements — never `<span>` —
    // so the operator can activate them with mouse, Enter, or Space.
    expect(html).toMatch(
      /<button[^>]*type="button"[^>]*data-slot="detection-pivot-cell"/,
    );
    expect(html).not.toMatch(/<span[^>]*data-slot="detection-pivot-cell"/);
  });

  it("renders pivot buttons with localized aria-labels for each pivotable column", () => {
    const html = renderToStaticMarkup(
      <ResultList
        state={state([pivotableHttpThreatRow()])}
        labels={labels()}
        locale="en"
        onRefresh={() => {}}
        onPivot={() => {}}
      />,
    );

    // The labels fixture renders `pivotActivate({label, value})` as
    // "Filter by <label>: <value>"; assert one a11y label per column.
    expect(html).toContain('aria-label="Filter by Level: High"');
    expect(html).toContain('aria-label="Filter by Kind: HTTP Threat"');
    expect(html).toContain('aria-label="Filter by Category: Lateral Movement"');
    expect(html).toContain('aria-label="Filter by Source IP: 10.0.0.5"');
    expect(html).toContain(
      'aria-label="Filter by Destination IP: 203.0.113.45"',
    );
    expect(html).toContain('aria-label="Filter by Source country: KR"');
    expect(html).toContain('aria-label="Filter by Destination country: US"');
  });

  it("does NOT render pivotable cells as buttons when `onPivot` is undefined (single-tab / standalone shell paths)", () => {
    const html = renderToStaticMarkup(
      <ResultList
        state={state([pivotableHttpThreatRow()])}
        labels={labels()}
        locale="en"
        onRefresh={() => {}}
      />,
    );

    // No pivot cell is emitted at all — the rendering helper falls
    // through to the children-only branch when `onPivot` is missing.
    expect(html).not.toContain('data-slot="detection-pivot-cell"');
    // No pivot aria-labels either — the verbatim text path doesn't
    // wrap children in a button, so screen readers see the badge /
    // value text directly without a "Filter by …" affordance.
    expect(html).not.toMatch(/aria-label="Filter by/);
  });

  it("hides the country pivot for the sentinel codes `XX` / `ZZ` (issue #283 — country pivots are no-ops for unknown / unavailable)", () => {
    const html = renderToStaticMarkup(
      <ResultList
        state={state([
          baseEvent({
            __typename: "HttpThreat",
            origAddr: "10.0.0.5",
            origPort: 1234,
            respAddr: "203.0.113.45",
            respPort: 443,
            origCountry: "XX",
            respCountry: "ZZ",
          } as unknown as Partial<Event>),
        ])}
        labels={labels()}
        locale="en"
        onRefresh={() => {}}
        onPivot={() => {}}
      />,
    );

    // The localised sentinel display strings still render as plain
    // text (so the operator sees the row), but no pivot button is
    // wrapped around them — clicking would be a useless no-op.
    expect(html).toContain("(??)");
    expect(html).toContain("(—)");
    expect(html).not.toMatch(/aria-label="Filter by Source country: XX"/);
    expect(html).not.toMatch(/aria-label="Filter by Destination country: ZZ"/);
  });

  it("never nests a pivot button inside the row-open overlay button (invalid HTML, intercepts cell activation)", () => {
    const html = renderToStaticMarkup(
      <ResultList
        state={state([pivotableHttpThreatRow()])}
        labels={labels()}
        locale="en"
        onRefresh={() => {}}
        onRowOpen={() => {}}
        onPivot={() => {}}
      />,
    );

    // The row-open overlay renders as a `<button aria-label="Open
    // quick peek">…</button>`. Pivot buttons must be siblings of the
    // overlay, not children — nesting interactive controls is
    // invalid HTML and would route cell clicks back through the row
    // overlay (re-opening Quick peek instead of pivoting). The same
    // structural guard #290 used for the +N more popover.
    expect(html).not.toMatch(
      /aria-label="Open quick peek"[^>]*>[^<]*<button[^>]*data-slot="detection-pivot-cell"/,
    );
    // Belt-and-braces: no button nests inside any other button.
    expect(html).not.toMatch(/<button[^>]*>[^<]*<button/);
  });

  it("layers the pivot button above the row overlay so direct clicks do not bubble through (z-10 / pointer-events-auto)", () => {
    const html = renderToStaticMarkup(
      <ResultList
        state={state([pivotableHttpThreatRow()])}
        labels={labels()}
        locale="en"
        onRefresh={() => {}}
        onRowOpen={() => {}}
        onPivot={() => {}}
      />,
    );

    // The pivot cell carries `pointer-events-auto` and `z-10`; the
    // parent row content is `pointer-events-none` so the row-open
    // overlay receives clicks only when they are NOT on a pivot
    // cell. Locking the class names guards the regression where a
    // refactor drops the layering and the row overlay starts
    // intercepting cell clicks again.
    expect(html).toMatch(
      /<button[^>]*class="[^"]*pointer-events-auto[^"]*z-10[^"]*"[^>]*data-slot="detection-pivot-cell"/,
    );
    // Outer row content is pointer-events-none so the row-open
    // overlay (positioned beneath the content) gets the click.
    expect(html).toMatch(/class="pointer-events-none relative/);
  });

  it("drops pivot buttons during the loading retained-slice window (issue #290 stale-row contract)", () => {
    // Same gate that drops `onRowOpen` / `onRowInvestigate` while a
    // committed-query transition is in flight: pivoting from a stale
    // row would let the operator open / focus a tab whose filter
    // narrows by a value that the newly committed slice may no longer
    // contain. Drop the affordance until the fresh slice lands.
    const loadingRetained: ResultListState = {
      status: "loading",
      events: [pivotableHttpThreatRow()],
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
        onRowOpen={() => {}}
        onPivot={() => {
          throw new Error("onPivot must not be wired during loading");
        }}
      />,
    );

    expect(html).not.toContain('data-slot="detection-pivot-cell"');
    expect(html).not.toMatch(/aria-label="Filter by/);
  });
});

describe("ResultList identity columns (issue #347)", () => {
  // Phase Detection-28 surfaces the userName / hostname identity
  // cells as pivotable buttons on subtypes whose schema emits
  // those fields. The pivot library (#283 / PR #346) already maps
  // the column keys; these tests lock the row-rendering side so a
  // refactor cannot drop the cells, and assert the dash fallback
  // for subtypes whose schema does not emit either field.

  function httpThreatWithIdentity(): Event {
    return {
      __typename: "HttpThreat",
      time: "2026-04-22T00:00:00.000Z",
      sensor: "sensor-1",
      confidence: 0.8,
      category: "LATERAL_MOVEMENT",
      level: "HIGH",
      triageScores: null,
      origAddr: "10.0.0.5",
      origPort: 1234,
      respAddr: "203.0.113.45",
      respPort: 443,
      origCountry: "KR",
      respCountry: "US",
      username: "jdoe",
      host: "mail.example.com",
    } as unknown as Event;
  }

  it("renders pivotable userName + hostname cells when the event subtype emits username + host", () => {
    const html = renderToStaticMarkup(
      <ResultList
        state={state([httpThreatWithIdentity()])}
        labels={labels()}
        locale="en"
        onRefresh={() => {}}
        onPivot={() => {}}
      />,
    );

    expect(html).toContain('aria-label="Filter by User name: jdoe"');
    expect(html).toContain('aria-label="Filter by Hostname: mail.example.com"');
    // The userName label prefix renders so the operator can tell
    // the cell apart from the hostname cell without a header row.
    expect(html).toContain("User:");
    expect(html).toContain("Host:");
    expect(html).toContain("jdoe");
    expect(html).toContain("mail.example.com");
  });

  it("renders userName + hostname as plain text when onPivot is undefined", () => {
    // Single-tab / standalone shell paths still surface the values
    // — they just do not wrap them in pivot buttons.
    const html = renderToStaticMarkup(
      <ResultList
        state={state([httpThreatWithIdentity()])}
        labels={labels()}
        locale="en"
        onRefresh={() => {}}
      />,
    );
    expect(html).toContain("jdoe");
    expect(html).toContain("mail.example.com");
    expect(html).not.toMatch(/aria-label="Filter by User name/);
    expect(html).not.toMatch(/aria-label="Filter by Hostname/);
  });

  it("renders both identity cells as non-pivotable `—` for subtypes whose schema emits neither field", () => {
    // BlocklistConn is one of many subtypes the schema does not
    // expose `username` / `user` / `host` / `hostname` on. Per
    // #347's acceptance the row must still render the column slots
    // — `User: —` and `Host: —` — so the column position stays
    // stable across the list, but no pivot affordance is wired
    // because there is no value to merge.
    const html = renderToStaticMarkup(
      <ResultList
        state={state([
          {
            __typename: "BlocklistConn",
            time: "2026-04-22T00:00:00.000Z",
            sensor: "sensor-2",
            confidence: 0.5,
            category: null,
            level: "LOW",
            triageScores: null,
            origAddr: "10.0.0.5",
            respAddr: "10.0.0.6",
          } as unknown as Event,
        ])}
        labels={labels()}
        locale="en"
        onRefresh={() => {}}
        onPivot={() => {}}
      />,
    );

    expect(html).not.toMatch(/aria-label="Filter by User name/);
    expect(html).not.toMatch(/aria-label="Filter by Hostname/);
    // The dash placeholder slots are present so the column position
    // stays fixed across rows even when the subtype carries no
    // identity data.
    expect(html).toContain("User:");
    expect(html).toContain("Host:");
    expect(html).toContain("—");
    // The row's other pivot affordances still render — locking
    // that the new cells did not break the row layout.
    expect(html).toContain('aria-label="Filter by Source IP: 10.0.0.5"');
  });

  it("renders the userName cell pivotable and the hostname cell as `—` when the schema emits username but no host/hostname", () => {
    // BlocklistFtp surfaces `user` (documented as Username) but no
    // host/hostname field. The row should pivot on userName and
    // render the hostname cell as a non-pivotable `Host: —` token.
    const html = renderToStaticMarkup(
      <ResultList
        state={state([
          {
            __typename: "BlocklistFtp",
            time: "2026-04-22T00:00:00.000Z",
            sensor: "sensor-3",
            confidence: 0.5,
            category: null,
            level: "LOW",
            triageScores: null,
            origAddr: "10.0.0.5",
            respAddr: "10.0.0.6",
            user: "alice",
          } as unknown as Event,
        ])}
        labels={labels()}
        locale="en"
        onRefresh={() => {}}
        onPivot={() => {}}
      />,
    );

    expect(html).toContain('aria-label="Filter by User name: alice"');
    expect(html).not.toMatch(/aria-label="Filter by Hostname/);
    expect(html).toContain("alice");
    // Hostname cell present but renders as `—`.
    expect(html).toContain("Host:");
    expect(html).toContain("—");
  });

  it("renders the hostname cell pivotable and the userName cell as `—` when the schema emits hostname but no user/username", () => {
    // BlocklistNtlm exposes both, but the row must still surface
    // hostname-only events when the upstream payload leaves
    // username blank. Empty string collapses to null and the cell
    // renders as `User: —` non-pivotable.
    const html = renderToStaticMarkup(
      <ResultList
        state={state([
          {
            __typename: "BlocklistNtlm",
            time: "2026-04-22T00:00:00.000Z",
            sensor: "sensor-4",
            confidence: 0.5,
            category: null,
            level: "LOW",
            triageScores: null,
            origAddr: "10.0.0.5",
            respAddr: "10.0.0.6",
            username: "",
            hostname: "client01.corp.local",
          } as unknown as Event,
        ])}
        labels={labels()}
        locale="en"
        onRefresh={() => {}}
        onPivot={() => {}}
      />,
    );

    expect(html).not.toMatch(/aria-label="Filter by User name/);
    expect(html).toContain(
      'aria-label="Filter by Hostname: client01.corp.local"',
    );
    expect(html).toContain("client01.corp.local");
    // userName cell present but renders as `—`.
    expect(html).toContain("User:");
    expect(html).toContain("—");
  });

  it("reads the camelCase `userName` field on BlocklistRadius (the schema outlier)", () => {
    // BlocklistRadius is the only curated subtype that uses the
    // camelCase `userName` field (every other identity-bearing
    // subtype uses lowercase `username` or `user`). Locks the
    // `readEventIdentity` fall-through so a refactor that drops
    // the camelCase branch does not silently make BlocklistRadius
    // rows non-pivotable on userName.
    const html = renderToStaticMarkup(
      <ResultList
        state={state([
          {
            __typename: "BlocklistRadius",
            time: "2026-04-22T00:00:00.000Z",
            sensor: "sensor-5",
            confidence: 0.5,
            category: null,
            level: "LOW",
            triageScores: null,
            origAddr: "10.0.0.5",
            respAddr: "10.0.0.6",
            userName: "radius-user",
          } as unknown as Event,
        ])}
        labels={labels()}
        locale="en"
        onRefresh={() => {}}
        onPivot={() => {}}
      />,
    );

    expect(html).toContain('aria-label="Filter by User name: radius-user"');
    expect(html).toContain("radius-user");
  });

  it("reads the `user` field on WindowsThreat", () => {
    // WindowsThreat is host-/agent-side and exposes a `user` field
    // (documented as Username). The row drops the source →
    // destination line because the subtype has no addressing, but
    // the userName cell still pivots — the dash fallback applies
    // only when the schema does not emit any username variant.
    const html = renderToStaticMarkup(
      <ResultList
        state={state([
          {
            __typename: "WindowsThreat",
            time: "2026-04-22T00:00:00.000Z",
            sensor: "sensor-6",
            confidence: 0.5,
            category: null,
            level: "LOW",
            triageScores: null,
            user: "DOMAIN\\agent",
          } as unknown as Event,
        ])}
        labels={labels()}
        locale="en"
        onRefresh={() => {}}
        onPivot={() => {}}
      />,
    );

    expect(html).toContain('aria-label="Filter by User name: DOMAIN\\agent"');
    expect(html).toContain("DOMAIN\\agent");
    // No host/hostname on WindowsThreat — the cell renders as `—`.
    expect(html).not.toMatch(/aria-label="Filter by Hostname/);
    expect(html).toContain("Host:");
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
