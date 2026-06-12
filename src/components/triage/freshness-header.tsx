"use client";

/**
 * Freshness header for the Triage menu (1B-3 / #458).
 *
 * Reads `baseline_corpus_state` from each tenant DB the caller has
 * scope to and renders a compact "Last updated: N min ago" badge
 * with worst-case escalation across the multi-customer scope.
 *
 * UI states (single-customer):
 *
 *   | last_run_status | last_ingested_at | rendering                            |
 *   |-----------------|------------------|--------------------------------------|
 *   | ok              | non-NULL         | "Last updated: N min ago"            |
 *   | running         | non-NULL         | "Updating now…" + previous timestamp |
 *   | running         | NULL             | "First ingest in progress…"          |
 *   | failed          | non-NULL         | "Last attempt failed N min ago"      |
 *   | failed          | NULL             | "First ingest failed"                |
 *   | (no row)        | —                | "Awaiting first ingest"              |
 *
 * Multi-customer summary picks the worst state across the scope so
 * the operator never sees a green header masking one tenant's failure.
 * The tooltip lists customer ids whose state matches the picked badge.
 */

import { useTimestampFormatter } from "@/components/timestamp";
import type { TriageCustomerFreshness, TriageFreshness } from "@/lib/triage";

export interface TriageFreshnessHeaderLabels {
  /** "Last updated: {ago}" — `{ago}` is the relative-time string. */
  okTemplate: string;
  /** "Updating now… (previously {ago})" */
  runningWithPreviousTemplate: string;
  /** "First ingest in progress…" */
  runningFirstIngest: string;
  /** "Last attempt failed {ago}" */
  failedTemplate: string;
  /** "First ingest failed" */
  failedFirstIngest: string;
  /** "Awaiting first ingest" */
  awaitingFirstIngest: string;
  /** "Last updated: {ago}, across {count} customers" */
  okMultiTemplate: string;
  /** Tooltip header for the multi-customer breakdown. */
  affectedCustomersHeading: string;
  /** Default "N min ago"-style relative-time labels. */
  relative: {
    justNow: string;
    minutesTemplate: string;
    hoursTemplate: string;
    daysTemplate: string;
  };
}

interface TriageFreshnessHeaderProps {
  freshness: TriageFreshness;
  labels: TriageFreshnessHeaderLabels;
  /** Override "now" — only used by tests. */
  now?: Date;
}

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function relativeTime(
  iso: string | null,
  now: Date,
  labels: TriageFreshnessHeaderLabels["relative"],
): string {
  if (iso === null) return labels.justNow;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return labels.justNow;
  const elapsed = Math.max(0, now.getTime() - ms);
  if (elapsed < MINUTE_MS) return labels.justNow;
  if (elapsed < HOUR_MS) {
    return labels.minutesTemplate.replace(
      "{n}",
      String(Math.floor(elapsed / MINUTE_MS)),
    );
  }
  if (elapsed < DAY_MS) {
    return labels.hoursTemplate.replace(
      "{n}",
      String(Math.floor(elapsed / HOUR_MS)),
    );
  }
  return labels.daysTemplate.replace(
    "{n}",
    String(Math.floor(elapsed / DAY_MS)),
  );
}

function affectedCustomerIds(
  worst: TriageCustomerFreshness,
  customers: readonly TriageCustomerFreshness[],
): number[] {
  return customers
    .filter((c) => sameSeverity(c, worst))
    .map((c) => c.customerId);
}

function sameSeverity(
  a: TriageCustomerFreshness,
  b: TriageCustomerFreshness,
): boolean {
  if (a.status === "failed" && b.status === "failed") return true;
  if (a.status === "running" && b.status === "running") return true;
  if (a.rowAbsent && b.rowAbsent) return true;
  if (a.status === "ok" && b.status === "ok") return true;
  return false;
}

interface RenderedHeader {
  text: string;
  tone: "ok" | "info" | "warn";
  /** Tooltip body — listed customer ids, error text. */
  tooltip?: string;
}

function renderWorstState(
  worst: TriageCustomerFreshness,
  customers: readonly TriageCustomerFreshness[],
  now: Date,
  labels: TriageFreshnessHeaderLabels,
): RenderedHeader {
  const ago = relativeTime(worst.lastIngestedAtIso, now, labels.relative);
  const tooltip =
    customers.length > 1
      ? `${labels.affectedCustomersHeading}: ${affectedCustomerIds(worst, customers).join(", ")}`
      : undefined;
  if (worst.rowAbsent) {
    return { text: labels.awaitingFirstIngest, tone: "warn", tooltip };
  }
  if (worst.status === "running") {
    if (worst.lastIngestedAtIso === null) {
      return { text: labels.runningFirstIngest, tone: "info", tooltip };
    }
    return {
      text: labels.runningWithPreviousTemplate.replace("{ago}", ago),
      tone: "info",
      tooltip,
    };
  }
  if (worst.status === "failed") {
    // Multi-customer failed rows need BOTH the affected-id list and
    // the `last_error` detail. Replacing one with the other (an
    // earlier Round 2 implementation) collapsed the customer-scope
    // information operators rely on to triage which tenant failed.
    const failedTooltip =
      [tooltip, worst.lastError].filter(Boolean).join(" — ") || undefined;
    if (worst.lastIngestedAtIso === null) {
      return {
        text: labels.failedFirstIngest,
        tone: "warn",
        tooltip: failedTooltip,
      };
    }
    return {
      text: labels.failedTemplate.replace("{ago}", ago),
      tone: "warn",
      tooltip: failedTooltip,
    };
  }
  // status === "ok" (the multi-customer ok branch surfaces the
  // "across K customers" summary).
  if (customers.length > 1) {
    return {
      text: labels.okMultiTemplate
        .replace("{ago}", ago)
        .replace("{count}", String(customers.length)),
      tone: "ok",
      tooltip,
    };
  }
  return {
    text: labels.okTemplate.replace("{ago}", ago),
    tone: "ok",
  };
}

const TONE_CLASSES = {
  ok: "border-emerald-300/60 bg-emerald-50 text-emerald-900 dark:border-emerald-500/40 dark:bg-emerald-950/40 dark:text-emerald-200",
  info: "border-blue-300/60 bg-blue-50 text-blue-900 dark:border-blue-500/40 dark:bg-blue-950/40 dark:text-blue-200",
  warn: "border-amber-300/60 bg-amber-50 text-amber-900 dark:border-amber-500/40 dark:bg-amber-950/40 dark:text-amber-200",
} as const;

export function TriageFreshnessHeader({
  freshness,
  labels,
  now,
}: TriageFreshnessHeaderProps) {
  const { format } = useTimestampFormatter();
  const effectiveNow = now ?? new Date();
  if (freshness.worst === null) {
    // Empty scope — render nothing rather than a misleading badge.
    return null;
  }
  const rendered = renderWorstState(
    freshness.worst,
    freshness.customers,
    effectiveNow,
    labels,
  );
  const exact =
    freshness.worst.lastIngestedAtIso !== null
      ? format(freshness.worst.lastIngestedAtIso)
      : null;
  return (
    <p
      role="status"
      title={[exact, rendered.tooltip].filter(Boolean).join(" — ") || undefined}
      className={`inline-flex items-center gap-2 rounded-md border px-2 py-1 text-xs ${TONE_CLASSES[rendered.tone]}`}
    >
      <span>{rendered.text}</span>
    </p>
  );
}

/** Test-only export: exposes the pure render-state derivation. */
export const _testing = { renderWorstState, relativeTime, sameSeverity };
