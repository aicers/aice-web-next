"use client";

/**
 * Single Story card — title, rule badge, score, member count,
 * top-3 preview, β submission indicator, Open / Send-to-aimer-web
 * actions. #493 wires the Send click through the three-call manual
 * flow (`build-envelope` → aimer-web → `ack-manual`) and adds a
 * kebab menu with "Send (force refresh)" guarded by a confirm
 * dialog.
 *
 * Relative-time and auto-title duration text is rendered through the
 * locale-supplied `relative` / `duration` label objects so KO/EN
 * surfaces stay consistent (no hard-coded "min ago" / "min" in the
 * Korean UI).
 */

import { useState } from "react";

import type { AiAnalysisSummary } from "@/lib/aimer/analysis/summary-types";
import type { TriageStory } from "@/lib/triage/story/types";
import {
  type AiAnalysisBadgeLabels,
  renderAiAnalysisBadge,
} from "./ai-analysis-badge";
import {
  renderStoryTitle,
  type StoryDurationLabels,
  topCategories,
} from "./story-title";

export interface StoryRelativeTimeLabels {
  /** Shown when the elapsed delta is under one second or in the future. */
  justNow: string;
  /** "{n}s ago" — used for elapsed under a minute. */
  secondsTemplate: string;
  /** "{n} min ago" — used for elapsed under an hour. */
  minutesTemplate: string;
  /** "{n} h ago" — used for elapsed under a day. */
  hoursTemplate: string;
  /** "{n} d ago" — used for elapsed over a day. */
  daysTemplate: string;
}

export interface TriageStoryCardLabels {
  ruleBadgeAuto: string; // template "{ruleId}" e.g. "R1" / "R3"
  ruleBadgeAnalyst: string; // "analyst-curated"
  scoreLabel: string;
  memberCountTemplate: string; // "{count} events"
  open: string;
  sendToAimerWeb: string;
  sendToAimerWebTooltip: string;
  /**
   * Tooltip shown when {@link StoryCardProps.sendDisabled} is `true`
   * (the Aimer integration is missing one of `aice_id`, the bridge
   * URL, or an active signing key). Surfaced in place of
   * {@link sendToAimerWebTooltip} so the operator can recognise the
   * grey-out before clicking and getting a route error.
   */
  sendToAimerWebDisabledTooltip: string;
  /** Template for the β submission indicator. `{relative}` → e.g. "12 min ago". */
  sentIndicatorTemplate: string;
  /** Multi-send suffix. Template `{count}×` (e.g. `3×`). */
  sentMultiTemplate: string;
  timeColumn: string;
  kindColumn: string;
  categoryColumn: string;
  topMembersHeading: string;
  /** Locale-aware relative-time templates used by the β indicator. */
  relative: StoryRelativeTimeLabels;
  /** Locale-aware duration templates used by the auto-generated title. */
  duration: StoryDurationLabels;
  /** Kebab-menu trigger label (e.g. "More send options"). */
  sendMoreMenuLabel: string;
  /** Force-refresh send menu item label. */
  sendForceRefresh: string;
  /** Confirmation dialog body shown before a force-refresh send. */
  forceRefreshConfirmMessage: string;
  /** Confirmation dialog primary button. */
  forceRefreshConfirmButton: string;
  /** Confirmation dialog cancel button. */
  forceRefreshCancelButton: string;
  /** Sending-in-flight button label. */
  sendInFlight: string;
  /** Toast text shown after a successful send. */
  sendSuccessToast: string;
  /** Prefix used for the error toast. The error reason is appended. */
  sendErrorPrefix: string;
  /**
   * Labels for the AI narrative analysis badge (#645). Required so the
   * badge renders with localized tier text + tooltip whenever the
   * route handler returns a summary; the card itself does not gate on
   * tier (the route handler already collapses LOW / MEDIUM to 204).
   */
  aiAnalysisBadge: AiAnalysisBadgeLabels;
}

interface StoryCardProps {
  story: TriageStory;
  onOpen: (story: TriageStory) => void;
  /**
   * Manual Send handler (#493). When omitted (legacy / unit-test
   * paths), the button stays disabled. Returns the post-commit β
   * snapshot so the card can render `"Sent · just now · 3×"`
   * immediately.
   */
  onSend?: (args: {
    story: TriageStory;
    forceRefresh: boolean;
  }) => Promise<void>;
  /**
   * True when the analyst's integration setup is missing (no
   * configured signing key / bridge URL / aice_id). The button
   * stays disabled with an explanatory tooltip.
   */
  sendDisabled?: boolean;
  /**
   * AI narrative analysis summary resolved by the internal route
   * handler (#645). When `null` / `undefined` the badge collapses
   * out — every "render nothing" upstream surface is normalized to
   * `null` on the client side, so the card has no policy of its own.
   */
  aiAnalysis?: AiAnalysisSummary | null;
  labels: TriageStoryCardLabels;
}

const SCORE_FORMAT = new Intl.NumberFormat(undefined, {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const COUNT_FORMAT = new Intl.NumberFormat();

export function TriageStoryCard({
  story,
  onOpen,
  onSend,
  sendDisabled,
  aiAnalysis,
  labels,
}: StoryCardProps) {
  const title = renderStoryTitle(
    story.primaryAsset,
    story.summary,
    labels.duration,
  );
  const ruleBadge =
    story.kind === "analyst_curated"
      ? labels.ruleBadgeAnalyst
      : (story.ruleId ?? labels.ruleBadgeAuto);
  const [sendInFlight, setSendInFlight] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const handleSend = async (forceRefresh: boolean) => {
    if (!onSend || sendInFlight) return;
    setSendInFlight(true);
    setMenuOpen(false);
    try {
      await onSend({ story, forceRefresh });
    } finally {
      setSendInFlight(false);
      setConfirmOpen(false);
    }
  };
  const sendButtonDisabled =
    sendDisabled === true || onSend === undefined || sendInFlight;
  return (
    <article
      data-testid="triage-story-card"
      data-story-id={`${story.customerId}/${story.storyId}`}
      className="flex flex-col gap-3 rounded-md bg-card p-4"
    >
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-base font-semibold text-foreground">{title}</h3>
        <div className="flex items-center gap-2">
          <span className="rounded-sm border border-border bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
            {ruleBadge}
          </span>
          {renderAiAnalysisBadge(aiAnalysis, labels.aiAnalysisBadge)}
          {story.score !== null ? (
            <span className="text-xs text-muted-foreground">
              {labels.scoreLabel}{" "}
              <span className="font-mono text-foreground">
                {SCORE_FORMAT.format(story.score)}
              </span>
            </span>
          ) : null}
          <span className="text-xs text-muted-foreground">
            {labels.memberCountTemplate.replace(
              "{count}",
              COUNT_FORMAT.format(story.summary.memberCount),
            )}
          </span>
        </div>
      </header>
      <p className="text-xs text-muted-foreground">
        {story.timeWindowStartIso} ~ {story.timeWindowEndIso}
      </p>
      {story.lastSentAtIso !== null ? (
        <p
          data-testid="triage-story-sent-indicator"
          className="text-xs text-muted-foreground"
        >
          {labels.sentIndicatorTemplate.replace(
            "{relative}",
            relativeTime(story.lastSentAtIso, labels.relative),
          )}
          {story.sendCount > 1
            ? ` ${labels.sentMultiTemplate.replace(
                "{count}",
                String(story.sendCount),
              )}`
            : ""}
        </p>
      ) : null}
      <div>
        <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {labels.topMembersHeading}
        </h4>
        {story.topMembers.length === 0 ? (
          <p className="text-xs text-muted-foreground">—</p>
        ) : (
          <table className="w-full text-xs">
            <thead className="text-muted-foreground">
              <tr>
                <th scope="col" className="py-1 pr-2 text-left font-medium">
                  {labels.timeColumn}
                </th>
                <th scope="col" className="py-1 pr-2 text-left font-medium">
                  {labels.kindColumn}
                </th>
                <th scope="col" className="py-1 text-left font-medium">
                  {labels.categoryColumn}
                </th>
              </tr>
            </thead>
            <tbody>
              {story.topMembers.map((m) => (
                <tr key={m.eventKey}>
                  <td className="py-1 pr-2 font-mono">{m.eventTimeIso}</td>
                  <td className="py-1 pr-2">{m.kind}</td>
                  <td className="py-1 text-muted-foreground">
                    {m.category ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <footer className="flex items-center gap-2">
        <button
          type="button"
          data-testid="triage-story-open"
          onClick={() => onOpen(story)}
          className="rounded-sm border border-border bg-background px-3 py-1 text-sm hover:bg-muted"
        >
          {labels.open}
        </button>
        <div className="relative flex items-center">
          <button
            type="button"
            data-action="send-to-aimer-web"
            data-testid="triage-story-send"
            disabled={sendButtonDisabled}
            aria-disabled={sendButtonDisabled ? "true" : "false"}
            title={
              sendDisabled === true
                ? labels.sendToAimerWebDisabledTooltip
                : labels.sendToAimerWebTooltip
            }
            onClick={() => void handleSend(false)}
            className={
              sendButtonDisabled
                ? "cursor-not-allowed rounded-l-sm border border-border bg-background px-3 py-1 text-sm text-muted-foreground"
                : "rounded-l-sm border border-border bg-background px-3 py-1 text-sm hover:bg-muted"
            }
          >
            {sendInFlight ? labels.sendInFlight : labels.sendToAimerWeb}
          </button>
          <button
            type="button"
            data-testid="triage-story-send-menu"
            disabled={sendButtonDisabled}
            aria-haspopup="menu"
            aria-expanded={menuOpen ? "true" : "false"}
            aria-label={labels.sendMoreMenuLabel}
            onClick={() => setMenuOpen((v) => !v)}
            className={
              sendButtonDisabled
                ? "cursor-not-allowed rounded-r-sm border border-l-0 border-border bg-background px-2 py-1 text-sm text-muted-foreground"
                : "rounded-r-sm border border-l-0 border-border bg-background px-2 py-1 text-sm hover:bg-muted"
            }
          >
            ▾
          </button>
          {menuOpen ? (
            <div
              role="menu"
              data-testid="triage-story-send-menu-popover"
              className="absolute right-0 top-full z-10 mt-1 w-48 rounded-md border border-border bg-popover p-1 text-sm shadow-md"
            >
              <button
                type="button"
                role="menuitem"
                data-testid="triage-story-send-force-refresh"
                onClick={() => {
                  setMenuOpen(false);
                  setConfirmOpen(true);
                }}
                className="block w-full rounded-sm px-2 py-1 text-left hover:bg-muted"
              >
                {labels.sendForceRefresh}
              </button>
            </div>
          ) : null}
        </div>
      </footer>
      {confirmOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          data-testid="triage-story-send-force-confirm"
          className="fixed inset-0 z-20 flex items-center justify-center bg-black/50"
        >
          <div className="w-full max-w-md rounded-md border bg-card p-4 shadow-lg">
            <p className="mb-3 text-sm">{labels.forceRefreshConfirmMessage}</p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmOpen(false)}
                className="rounded-sm border border-border bg-background px-3 py-1 text-sm hover:bg-muted"
              >
                {labels.forceRefreshCancelButton}
              </button>
              <button
                type="button"
                data-testid="triage-story-send-force-confirm-ok"
                onClick={() => void handleSend(true)}
                disabled={sendInFlight}
                className="rounded-sm border border-border bg-primary px-3 py-1 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
              >
                {sendInFlight
                  ? labels.sendInFlight
                  : labels.forceRefreshConfirmButton}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      <aside className="hidden">
        {/* Hidden references retained so card consumers can derive
            histogram-only chips in a follow-up without re-fetching. */}
        {topCategories(story.summary.categoryHistogram, 3).join(",")}
      </aside>
    </article>
  );
}

function relativeTime(iso: string, labels: StoryRelativeTimeLabels): string {
  // Lightweight relative-time formatter — kept local so a Story card
  // does not pull in a heavyweight i18n date library. Locale-specific
  // strings come from `labels`; the shape (seconds / minutes / hours /
  // days) is the only fixed contract.
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return iso;
  const deltaMs = Date.now() - then;
  if (deltaMs < 0) return labels.justNow;
  const sec = Math.floor(deltaMs / 1000);
  if (sec < 60) return labels.secondsTemplate.replace("{n}", String(sec));
  const min = Math.floor(sec / 60);
  if (min < 60) return labels.minutesTemplate.replace("{n}", String(min));
  const hr = Math.floor(min / 60);
  if (hr < 24) return labels.hoursTemplate.replace("{n}", String(hr));
  const day = Math.floor(hr / 24);
  return labels.daysTemplate.replace("{n}", String(day));
}
