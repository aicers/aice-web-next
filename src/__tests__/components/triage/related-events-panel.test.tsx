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

// The shared `<Timestamp>` / `useTimestampFormatter` read the active
// locale through next-intl; mock it so the panel renders without a real
// `NextIntlClientProvider`.
vi.mock("next-intl", () => ({
  useLocale: () => "en",
  useTranslations: () => (key: string) => key,
}));

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
  // Static-options dimensions (#498 — `learningMethods`, #499 —
  // `keywords`) have no entry in PIVOT_DIMENSIONS but still need a
  // label for breadcrumb / pivot-focus rendering.
  out.learningMethods = `${prefix}:learningMethods`;
  out.keywords = `${prefix}:keywords`;
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

describe("TriagePivotPanel — Tier 2 only Learning method static section", () => {
  // The static-options section is the whole point of #498: the loaded
  // corpus carries no `learningMethod` field, so the section must
  // appear regardless of focus event values. The tests below render
  // the panel with NO focus-driven sections (so the surfacing has to
  // come from the static branch alone) and pin the click action's
  // shape — the click must dispatch the GraphQL enum literal verbatim
  // so the underlying Tier 2 fetch sends the value REview accepts.
  it("renders both enum rows when scope is Tier 2 even with no focus-driven sections", () => {
    render(
      <TriagePivotPanel
        sections={[]}
        truncated={false}
        hasFocus={true}
        onPivot={vi.fn()}
        labels={LABELS}
        showLearningMethodSection={true}
      />,
    );
    // Section heading rendered.
    expect(screen.getByText("Dim:learningMethods")).toBeTruthy();
    // Both enum buttons rendered with their localized labels.
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

  it("dispatches the click with the GraphQL enum literal as the value key", () => {
    const onPivot = vi.fn();
    render(
      <TriagePivotPanel
        sections={[]}
        truncated={false}
        hasFocus={true}
        onPivot={onPivot}
        labels={LABELS}
        showLearningMethodSection={true}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Pivot to Dim:learningMethods: Unsupervised",
      }),
    );
    expect(onPivot).toHaveBeenCalledTimes(1);
    expect(onPivot.mock.calls[0][0]).toEqual({
      kind: "dimension",
      dimension: "learningMethods",
      // Exact enum spelling — no transformation, no lower-casing.
      value: { key: "UNSUPERVISED", label: "Unsupervised" },
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: "Pivot to Dim:learningMethods: Semi-supervised",
      }),
    );
    expect(onPivot).toHaveBeenCalledTimes(2);
    expect(onPivot.mock.calls[1][0]).toEqual({
      kind: "dimension",
      dimension: "learningMethods",
      value: { key: "SEMI_SUPERVISED", label: "Semi-supervised" },
    });
  });

  it("does not render the static section when showLearningMethodSection is false (Tier 1 mode)", () => {
    // Mirrors how `kinds` / `levels` are hidden in Tier 1 today: the
    // baseline-content wires `showLearningMethodSection` to
    // `scope === "tier2"`, so a Tier 1 panel never receives the prop.
    render(
      <TriagePivotPanel
        sections={[]}
        truncated={false}
        hasFocus={true}
        onPivot={vi.fn()}
        labels={LABELS}
        showLearningMethodSection={false}
      />,
    );
    expect(screen.queryByText("Dim:learningMethods")).toBeNull();
    expect(
      screen.queryByRole("button", {
        name: /Pivot to Dim:learningMethods/,
      }),
    ).toBeNull();
  });
});

describe("TriagePivotPanel — Tier 2 only Keywords free-form section (#499)", () => {
  function renderKeywords({
    recentKeywords = [],
    onSubmitKeyword,
  }: {
    recentKeywords?: readonly string[];
    onSubmitKeyword: (value: string) => void;
  }) {
    return render(
      <TriagePivotPanel
        sections={[]}
        truncated={false}
        hasFocus={true}
        onPivot={vi.fn()}
        labels={LABELS}
        showKeywordsSection={true}
        recentKeywords={recentKeywords}
        onSubmitKeyword={onSubmitKeyword}
      />,
    );
  }

  it("does not render the section when showKeywordsSection is false", () => {
    render(
      <TriagePivotPanel
        sections={[]}
        truncated={false}
        hasFocus={true}
        onPivot={vi.fn()}
        labels={LABELS}
        showKeywordsSection={false}
        recentKeywords={[]}
        onSubmitKeyword={vi.fn()}
      />,
    );
    expect(screen.queryByText("Dim:keywords")).toBeNull();
    expect(screen.queryByLabelText("Keyword")).toBeNull();
  });

  it("rejects empty and whitespace-only submissions without calling onSubmitKeyword", () => {
    const onSubmit = vi.fn();
    renderKeywords({ onSubmitKeyword: onSubmit });
    const input = screen.getByLabelText("Keyword") as HTMLInputElement;
    const submit = screen.getByRole("button", { name: "Search" });

    // Empty submit: button click with empty input.
    fireEvent.click(submit);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toBe(
      "Enter a non-empty keyword.",
    );

    // Whitespace-only submit: same rejection path.
    fireEvent.change(input, { target: { value: "   \t  " } });
    fireEvent.click(submit);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toBe(
      "Enter a non-empty keyword.",
    );
  });

  it("rejects values longer than 256 characters with an inline message", () => {
    const onSubmit = vi.fn();
    renderKeywords({ onSubmitKeyword: onSubmit });
    const input = screen.getByLabelText("Keyword") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "a".repeat(257) } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toBe(
      "Keyword too long — under 256 characters.",
    );
  });

  it("dispatches onSubmitKeyword with the trimmed value on Enter", () => {
    const onSubmit = vi.fn();
    renderKeywords({ onSubmitKeyword: onSubmit });
    const input = screen.getByLabelText("Keyword") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "  lateral movement  " } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith("lateral movement");
    // After a successful submit the input clears so the operator can
    // type the next keyword without manually deleting the previous.
    expect(input.value).toBe("");
  });

  it("dispatches onSubmitKeyword on button click", () => {
    const onSubmit = vi.fn();
    renderKeywords({ onSubmitKeyword: onSubmit });
    fireEvent.change(screen.getByLabelText("Keyword"), {
      target: { value: "credential dump" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(onSubmit).toHaveBeenCalledWith("credential dump");
  });

  it("Escape clears the input without dispatching a fetch", () => {
    const onSubmit = vi.fn();
    renderKeywords({ onSubmitKeyword: onSubmit });
    const input = screen.getByLabelText("Keyword") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "scratch" } });
    fireEvent.keyDown(input, { key: "Escape", code: "Escape" });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(input.value).toBe("");
  });

  it("renders recent chips and re-fires onSubmitKeyword with the chip value", () => {
    const onSubmit = vi.fn();
    renderKeywords({
      recentKeywords: ["alpha", "beta", "gamma"],
      onSubmitKeyword: onSubmit,
    });
    const chip = screen.getByRole("button", {
      name: "Search again for beta",
    });
    fireEvent.click(chip);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith("beta");
  });
});
