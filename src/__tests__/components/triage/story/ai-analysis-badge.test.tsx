import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  AiAnalysisBadge,
  type AiAnalysisBadgeLabels,
  renderAiAnalysisBadge,
} from "@/components/triage/story/ai-analysis-badge";

const LABELS: AiAnalysisBadgeLabels = {
  tierCritical: "AI · CRITICAL",
  tierHigh: "AI · HIGH",
  tooltipTemplate:
    "AI analysis ({tier}) · severity {severity} · likelihood {likelihood}",
  linkAriaLabel: "Open AI analysis ({tier}) in a new tab",
};

describe("AiAnalysisBadge", () => {
  it("renders the CRITICAL tier label and opens in a new tab", () => {
    render(
      <AiAnalysisBadge
        href="https://aimer.example.com/analysis/story/123"
        tier="CRITICAL"
        severityScore={0.92}
        likelihoodScore={0.88}
        scoreKind="leaf"
        labels={LABELS}
      />,
    );
    const link = screen.getByTestId("triage-story-ai-analysis-badge");
    expect(link.textContent).toBe("AI · CRITICAL");
    expect(link.getAttribute("href")).toBe(
      "https://aimer.example.com/analysis/story/123",
    );
    expect(link.getAttribute("target")).toBe("_blank");
    // `noopener` must be present so the opened tab cannot reach back
    // into our window object.
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(link.getAttribute("data-tier")).toBe("CRITICAL");
    expect(link.getAttribute("data-score-kind")).toBe("leaf");
  });

  it("renders the HIGH tier label", () => {
    render(
      <AiAnalysisBadge
        href="https://aimer.example.com/analysis/story/9"
        tier="HIGH"
        severityScore={0.5}
        likelihoodScore={0.7}
        scoreKind="leaf"
        labels={LABELS}
      />,
    );
    const link = screen.getByTestId("triage-story-ai-analysis-badge");
    expect(link.textContent).toBe("AI · HIGH");
    expect(link.getAttribute("data-tier")).toBe("HIGH");
  });

  it("interpolates both scores into the tooltip with fixed-2 formatting", () => {
    render(
      <AiAnalysisBadge
        href="https://aimer.example.com/analysis/story/7"
        tier="HIGH"
        severityScore={0.5}
        likelihoodScore={0.71}
        scoreKind="leaf"
        labels={LABELS}
      />,
    );
    const tooltip = screen
      .getByTestId("triage-story-ai-analysis-badge")
      .getAttribute("title");
    expect(tooltip).toContain("AI · HIGH");
    expect(tooltip).toContain("0.50");
    expect(tooltip).toContain("0.71");
  });

  it("preserves the scoreKind data attribute for the dashboard reuse", () => {
    render(
      <AiAnalysisBadge
        href="https://aimer.example.com/analysis/story/42"
        tier="HIGH"
        severityScore={0.6}
        likelihoodScore={0.6}
        scoreKind="aggregate"
        labels={LABELS}
      />,
    );
    expect(
      screen
        .getByTestId("triage-story-ai-analysis-badge")
        .getAttribute("data-score-kind"),
    ).toBe("aggregate");
  });

  it("composes an accessible label that names the tier", () => {
    render(
      <AiAnalysisBadge
        href="https://aimer.example.com/analysis/story/1"
        tier="CRITICAL"
        severityScore={0.92}
        likelihoodScore={0.88}
        scoreKind="leaf"
        labels={LABELS}
      />,
    );
    expect(
      screen.getByLabelText("Open AI analysis (AI · CRITICAL) in a new tab"),
    ).toBeTruthy();
  });
});

describe("renderAiAnalysisBadge", () => {
  it("returns null when the summary is absent", () => {
    const { container: nullContainer } = render(
      <div>{renderAiAnalysisBadge(null, LABELS)}</div>,
    );
    expect(
      nullContainer.querySelector(
        "[data-testid=triage-story-ai-analysis-badge]",
      ),
    ).toBeNull();

    const { container: undefinedContainer } = render(
      <div>{renderAiAnalysisBadge(undefined, LABELS)}</div>,
    );
    expect(
      undefinedContainer.querySelector(
        "[data-testid=triage-story-ai-analysis-badge]",
      ),
    ).toBeNull();
  });

  it("renders the badge when a summary is supplied", () => {
    const { container } = render(
      <div>
        {renderAiAnalysisBadge(
          {
            tier: "CRITICAL",
            href: "https://aimer.example.com/analysis/story/1",
            severityScore: 0.9,
            likelihoodScore: 0.8,
            scoreKind: "leaf",
          },
          LABELS,
        )}
      </div>,
    );
    expect(
      container.querySelector("[data-testid=triage-story-ai-analysis-badge]"),
    ).toBeTruthy();
  });
});
