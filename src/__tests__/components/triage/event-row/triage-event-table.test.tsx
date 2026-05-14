/**
 * Direct coverage for the shared event-row module (#554).
 *
 * Both the Asset detail panel and the Story detail member table feed
 * a normalized {@link TriageEventRow} into {@link TriageEventTable};
 * these tests pin (a) asset-shape rendering, (b) story-shape rendering
 * with non-null `baselineScore`, (c) the null-score em-dash through
 * the unified formatter, and (d) the `protectedByStory` slot wiring
 * through a test-only marker renderer. No production caller passes
 * `protectedByStory` today (#471 will fill the slot in once the
 * Story-protected slider lands); the slot's contract is exercised
 * here so future surfaces have a regression net.
 */

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  formatBaselineScore,
  type TriageEventRow,
  TriageEventTable,
  type TriageEventTableLabels,
} from "@/components/triage/event-row/triage-event-table";

const ASSET_LABELS: TriageEventTableLabels = {
  timeColumn: "Time",
  kindColumn: "Kind",
  categoryColumn: "Category",
  scoreColumn: "Score",
};

const STORY_LABELS: TriageEventTableLabels = {
  timeColumn: "Time",
  kindColumn: "Kind",
  categoryColumn: "Category",
  scoreColumn: "Score",
  origAddrColumn: "Source",
  respAddrColumn: "Dest",
};

describe("formatBaselineScore", () => {
  it("renders an em-dash for null", () => {
    expect(formatBaselineScore(null)).toBe("—");
  });

  it("renders the asset-side numeric format for non-null values", () => {
    // No minimum-fraction-digits padding — `4.5` stays "4.5" rather
    // than the Story panel's pre-extraction "4.50".
    expect(formatBaselineScore(4.5)).toBe("4.5");
    expect(formatBaselineScore(0.92)).toBe("0.92");
    expect(formatBaselineScore(0)).toBe("0");
  });
});

describe("TriageEventTable — asset-shaped rows", () => {
  it("renders the four asset columns and skips the optional address columns", () => {
    const rows: TriageEventRow[] = [
      {
        key: "evt-1",
        time: "2026-05-09 12:10:00",
        kind: "HttpThreat",
        category: "IMPACT",
        baselineScore: 0.92,
      },
      {
        key: "evt-2",
        time: "2026-05-09 12:11:00",
        kind: "DnsCovertChannel",
        category: null,
        baselineScore: 0.71,
      },
    ];
    render(<TriageEventTable rows={rows} labels={ASSET_LABELS} />);

    const headers = screen
      .getAllByRole("columnheader")
      .map((h) => h.textContent);
    expect(headers).toEqual(["Time", "Kind", "Category", "Score"]);

    const dataRows = screen.getAllByTestId("triage-event-row");
    expect(dataRows).toHaveLength(2);

    // Row 1 — asset shape carries no address columns.
    const row1 = within(dataRows[0]);
    expect(row1.getByTestId("triage-event-row-time").textContent).toBe(
      "2026-05-09 12:10:00",
    );
    expect(row1.getByTestId("triage-event-row-kind").textContent).toBe(
      "HttpThreat",
    );
    expect(row1.getByTestId("triage-event-row-category").textContent).toBe(
      "IMPACT",
    );
    expect(row1.getByTestId("triage-event-row-score").textContent).toBe("0.92");
    expect(row1.queryByTestId("triage-event-row-orig-addr")).toBeNull();
    expect(row1.queryByTestId("triage-event-row-resp-addr")).toBeNull();

    // Row 2 — null category renders the em-dash fallback.
    const row2 = within(dataRows[1]);
    expect(row2.getByTestId("triage-event-row-category").textContent).toBe("—");
  });
});

describe("TriageEventTable — story-member-shaped rows", () => {
  it("renders origAddr/respAddr columns when their labels are present and a non-null baselineScore", () => {
    const row: TriageEventRow = {
      key: "evt-1",
      time: "2026-05-09T12:10:00.000Z",
      kind: "HttpThreat",
      category: "IMPACT",
      baselineScore: 0.92,
      origAddr: "10.0.0.5",
      respAddr: "8.8.8.8",
    };
    render(<TriageEventTable rows={[row]} labels={STORY_LABELS} />);

    const headers = screen
      .getAllByRole("columnheader")
      .map((h) => h.textContent);
    expect(headers).toEqual([
      "Time",
      "Kind",
      "Category",
      "Source",
      "Dest",
      "Score",
    ]);

    const dataRow = within(screen.getByTestId("triage-event-row"));
    expect(dataRow.getByTestId("triage-event-row-orig-addr").textContent).toBe(
      "10.0.0.5",
    );
    expect(dataRow.getByTestId("triage-event-row-resp-addr").textContent).toBe(
      "8.8.8.8",
    );
    expect(dataRow.getByTestId("triage-event-row-score").textContent).toBe(
      "0.92",
    );
  });

  it("renders an em-dash via the unified formatter when baselineScore is null", () => {
    // Story members whose `event_time` falls outside the menu period
    // arrive with `baselineScore: null` (#547's LEFT JOIN against the
    // period-scoped cohort). The shared formatter must render `—`
    // rather than `NaN` / `0.00` / empty string.
    const row: TriageEventRow = {
      key: "evt-aged",
      time: "2026-05-09T12:10:00.000Z",
      kind: "HttpThreat",
      category: "IMPACT",
      baselineScore: null,
      origAddr: null,
      respAddr: null,
    };
    render(<TriageEventTable rows={[row]} labels={STORY_LABELS} />);

    const dataRow = within(screen.getByTestId("triage-event-row"));
    expect(dataRow.getByTestId("triage-event-row-score").textContent).toBe("—");
    // Null address still renders the em-dash placeholder so the cell
    // never collapses.
    expect(dataRow.getByTestId("triage-event-row-orig-addr").textContent).toBe(
      "—",
    );
    expect(dataRow.getByTestId("triage-event-row-resp-addr").textContent).toBe(
      "—",
    );
  });
});

describe("TriageEventTable — protectedByStory slot (#471 reservation)", () => {
  it("invokes the injected marker renderer with the row payload when present", () => {
    const renderProtectedByStoryMarker = vi.fn((props: { score: number }) => (
      <span data-testid="story-protected-marker">P({props.score})</span>
    ));
    const rows: TriageEventRow[] = [
      {
        key: "evt-protected",
        time: "2026-05-09 12:10:00",
        kind: "HttpThreat",
        category: "IMPACT",
        baselineScore: 0.92,
        protectedByStory: { score: 0.42 },
      },
      {
        key: "evt-plain",
        time: "2026-05-09 12:11:00",
        kind: "DnsCovertChannel",
        category: "EXFILTRATION",
        baselineScore: 0.71,
      },
    ];
    render(
      <TriageEventTable
        rows={rows}
        labels={ASSET_LABELS}
        renderProtectedByStoryMarker={renderProtectedByStoryMarker}
      />,
    );

    // The renderer is called once — only for the row that carries the
    // payload — with the exact { score } the row supplied.
    expect(renderProtectedByStoryMarker).toHaveBeenCalledTimes(1);
    expect(renderProtectedByStoryMarker).toHaveBeenCalledWith({ score: 0.42 });

    const markers = screen.getAllByTestId("story-protected-marker");
    expect(markers).toHaveLength(1);
    expect(markers[0].textContent).toBe("P(0.42)");
  });

  it("renders no marker affordance when protectedByStory is undefined (today's production default)", () => {
    // Both production callers (`asset-detail` and `stories-view`) leave
    // `protectedByStory` undefined and supply no marker renderer. The
    // leading cell must render exactly as it did pre-#554 — no marker
    // node, no whitespace adjustment.
    const row: TriageEventRow = {
      key: "evt-plain",
      time: "2026-05-09 12:10:00",
      kind: "HttpThreat",
      category: "IMPACT",
      baselineScore: 0.92,
    };
    render(<TriageEventTable rows={[row]} labels={ASSET_LABELS} />);

    expect(screen.queryByTestId("story-protected-marker")).toBeNull();
    const timeCell = screen.getByTestId("triage-event-row-time");
    // Pure text content — the marker slot's absence must not leave a
    // stray element behind.
    expect(timeCell.children).toHaveLength(0);
    expect(timeCell.textContent).toBe("2026-05-09 12:10:00");
  });

  it("renders no marker affordance when protectedByStory is set but no renderer is supplied", () => {
    // Defensive: a row that opts into the slot without a registered
    // renderer must still degrade gracefully — no crash, no marker.
    const row: TriageEventRow = {
      key: "evt-protected-no-renderer",
      time: "2026-05-09 12:10:00",
      kind: "HttpThreat",
      category: "IMPACT",
      baselineScore: 0.92,
      protectedByStory: { score: 0.42 },
    };
    render(<TriageEventTable rows={[row]} labels={ASSET_LABELS} />);

    expect(screen.queryByTestId("story-protected-marker")).toBeNull();
    const timeCell = screen.getByTestId("triage-event-row-time");
    expect(timeCell.textContent).toBe("2026-05-09 12:10:00");
  });
});
