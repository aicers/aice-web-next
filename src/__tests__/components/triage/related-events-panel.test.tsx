/**
 * Component-level coverage for the Tier 1 pivot panel's collapsed /
 * expanded "Showing N of M" hint contract.
 *
 * Round 5: collapsed groups with more than 50 matches must NOT render
 * the cap hint, because the visible row count is the default-row cap
 * (10), not 50. The hint should only appear after the operator clicks
 * "Show more", at which point it reflects the actually-rendered row
 * count.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  TriagePivotPanel,
  type TriagePivotPanelLabels,
} from "@/components/triage/pivot/related-events-panel";
import type { ScoredTriageEvent } from "@/lib/triage";
import {
  PIVOT_DIMENSIONS,
  type PivotDimensionId,
  type PivotPanelSection,
  type PivotValue,
} from "@/lib/triage/pivot";

function dimensionsMap(prefix: string): Record<PivotDimensionId, string> {
  const out = {} as Record<PivotDimensionId, string>;
  for (const dim of PIVOT_DIMENSIONS) out[dim.id] = `${prefix}:${dim.id}`;
  return out;
}

const LABELS: TriagePivotPanelLabels = {
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
};

function makeEvent(i: number): ScoredTriageEvent {
  return {
    __typename: "BlocklistTls",
    id: `evt-${i}`,
    time: new Date(Date.UTC(2026, 4, 8, 12, 0, i)).toISOString(),
    sensor: "sensor-a",
    category: "EXFILTRATION",
    level: "MEDIUM",
    ja3: "ja3-shared",
    score: 100 - i,
    customerId: 0,
  };
}

function makeSection(
  eventCount: number,
  totalCount: number,
): PivotPanelSection {
  // The builder caps `events` at PIVOT_GROUP_EXPANDED_ROWS (50) while
  // keeping `totalCount` as the full match count. Mirror that contract.
  const events: ScoredTriageEvent[] = [];
  for (let i = 0; i < Math.min(eventCount, 50); i += 1)
    events.push(makeEvent(i));
  const focusValues: PivotValue[] = [
    { key: "ja3-shared", label: "ja3-shared" },
  ];
  return {
    dimension: "ja3" as PivotDimensionId,
    family: "tls",
    focusValues,
    events,
    totalCount,
  };
}

describe("TriagePivotPanel — collapsed/expanded cap hint", () => {
  it("hides the 'Showing N of M' hint when the group is collapsed, even if total > 50", () => {
    // 75 matches in the corpus; events array is the 50-cap slice; UI
    // starts collapsed at 10 rows.
    const section = makeSection(50, 75);
    render(
      <TriagePivotPanel
        sections={[section]}
        truncated={false}
        hasFocus={true}
        onPivot={vi.fn()}
        labels={LABELS}
      />,
    );
    // 10 default rows are rendered.
    expect(screen.getAllByRole("row")).toHaveLength(1 + 10);
    // The misleading "Showing 50 of 75" hint must NOT render while
    // only 10 rows are on screen.
    expect(screen.queryByText(/Showing\s+50\s+of\s+75/)).toBeNull();
    expect(screen.queryByText(/Showing/)).toBeNull();
    // Show more is offered.
    expect(screen.getByRole("button", { name: "Show more" })).toBeTruthy();
  });

  it("renders 'Showing 50 of N' only after the user clicks Show more", () => {
    const section = makeSection(50, 75);
    render(
      <TriagePivotPanel
        sections={[section]}
        truncated={false}
        hasFocus={true}
        onPivot={vi.fn()}
        labels={LABELS}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    // 50 rows are now rendered.
    expect(screen.getAllByRole("row")).toHaveLength(1 + 50);
    expect(screen.getByText(/Showing\s+50\s+of\s+75/)).toBeTruthy();
    // Show less takes over from Show more once expanded.
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
    expect(screen.getByRole("button", { name: "Show less" })).toBeTruthy();
  });

  it("does not render the hint when the expanded view fits the entire match set", () => {
    // 30 matches: collapsed shows 10, expanded shows all 30 — the hint
    // would be redundant ("Showing 30 of 30") so it stays hidden.
    const section = makeSection(30, 30);
    render(
      <TriagePivotPanel
        sections={[section]}
        truncated={false}
        hasFocus={true}
        onPivot={vi.fn()}
        labels={LABELS}
      />,
    );
    expect(screen.queryByText(/Showing/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(screen.getAllByRole("row")).toHaveLength(1 + 30);
    expect(screen.queryByText(/Showing/)).toBeNull();
  });
});
