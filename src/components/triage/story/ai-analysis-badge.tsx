"use client";

import type { AiAnalysisStorySummary } from "@/lib/aimer/analysis/summary-types";

export interface AiAnalysisBadgeLabels {
  /** Localized tier text shown for `priority_tier === "CRITICAL"`. */
  tierCritical: string;
  /** Localized tier text shown for `priority_tier === "HIGH"`. */
  tierHigh: string;
  /**
   * Tooltip template — `{tier}` / `{severity}` / `{likelihood}`. The
   * scores are interpolated as fixed-2 decimals. Surfaced via the
   * link's `title` attribute so the default badge stays compact while
   * the numerics remain reachable on hover / focus.
   */
  tooltipTemplate: string;
  /**
   * Accessible label template for the link — `{tier}`. Used as
   * `aria-label` since the visible text is just the tier and screen
   * readers benefit from the "open AI analysis" framing.
   */
  linkAriaLabel: string;
}

export interface AiAnalysisBadgeProps {
  /**
   * Validated absolute aimer-web URL composed by the internal route
   * handler. The badge does not validate or compose the URL itself —
   * it trusts the server-supplied `href` exactly as received.
   */
  href: string;
  /**
   * Surface-threshold-filtered priority tier. The route handler
   * collapses LOW / MEDIUM and `exists: false` upstream responses to
   * a 204, so this component never has to render for those cases.
   */
  tier: "CRITICAL" | "HIGH";
  /** Optional — surfaced via the tooltip when supplied. */
  severityScore?: number;
  /** Optional — surfaced via the tooltip when supplied. */
  likelihoodScore?: number;
  /**
   * Data-only tag carried through to support the #646 dashboard
   * surface without conditional shape parsing. The badge renders
   * identically for `leaf` and `aggregate`; the field exists on the
   * props so the upstream component can pass it through.
   */
  scoreKind: "leaf" | "aggregate";
  labels: AiAnalysisBadgeLabels;
}

const SCORE_FORMAT = new Intl.NumberFormat(undefined, {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function tierLabel(
  tier: "CRITICAL" | "HIGH",
  labels: AiAnalysisBadgeLabels,
): string {
  return tier === "CRITICAL" ? labels.tierCritical : labels.tierHigh;
}

function tierClassName(tier: "CRITICAL" | "HIGH"): string {
  const base =
    "inline-flex items-center rounded-sm border px-2 py-0.5 text-xs font-medium no-underline";
  return tier === "CRITICAL"
    ? `${base} border-red-300/60 bg-red-50 text-red-900 hover:bg-red-100 dark:border-red-500/40 dark:bg-red-950/60 dark:text-red-200`
    : `${base} border-amber-300/60 bg-amber-50 text-amber-900 hover:bg-amber-100 dark:border-amber-500/40 dark:bg-amber-950/60 dark:text-amber-200`;
}

export function AiAnalysisBadge({
  href,
  tier,
  severityScore,
  likelihoodScore,
  scoreKind,
  labels,
}: AiAnalysisBadgeProps) {
  const tierText = tierLabel(tier, labels);
  const tooltip = labels.tooltipTemplate
    .replace("{tier}", tierText)
    .replace(
      "{severity}",
      severityScore !== undefined ? SCORE_FORMAT.format(severityScore) : "—",
    )
    .replace(
      "{likelihood}",
      likelihoodScore !== undefined
        ? SCORE_FORMAT.format(likelihoodScore)
        : "—",
    );
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={tooltip}
      aria-label={labels.linkAriaLabel.replace("{tier}", tierText)}
      data-testid="triage-story-ai-analysis-badge"
      data-tier={tier}
      data-score-kind={scoreKind}
      className={tierClassName(tier)}
    >
      {tierText}
    </a>
  );
}

/**
 * Convenience renderer. Returns null when the summary is absent so
 * callers can drop the prop into a JSX expression without writing
 * the surface-threshold guard at each call site.
 */
export function renderAiAnalysisBadge(
  summary: AiAnalysisStorySummary | null | undefined,
  labels: AiAnalysisBadgeLabels,
) {
  if (!summary) return null;
  return (
    <AiAnalysisBadge
      href={summary.href}
      tier={summary.tier}
      severityScore={summary.severityScore}
      likelihoodScore={summary.likelihoodScore}
      scoreKind={summary.scoreKind}
      labels={labels}
    />
  );
}
