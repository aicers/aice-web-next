"use client";

/**
 * Single Story card — title, rule badge, score, member count,
 * top-3 preview, β submission indicator, Open / Send-to-aimer-web
 * actions. Per #490 the Send-to-aimer-web button ships as an inert
 * shape (`disabled=true`, `aria-disabled="true"`, stable
 * `data-action="send-to-aimer-web"` hook) — the click handler and
 * disabled-state flip land in #493.
 *
 * Relative-time and auto-title duration text is rendered through the
 * locale-supplied `relative` / `duration` label objects so KO/EN
 * surfaces stay consistent (no hard-coded "min ago" / "min" in the
 * Korean UI).
 */

import type { TriageStory } from "@/lib/triage/story/types";
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
}

interface StoryCardProps {
  story: TriageStory;
  onOpen: (story: TriageStory) => void;
  labels: TriageStoryCardLabels;
}

const SCORE_FORMAT = new Intl.NumberFormat(undefined, {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const COUNT_FORMAT = new Intl.NumberFormat();

export function TriageStoryCard({ story, onOpen, labels }: StoryCardProps) {
  const title = renderStoryTitle(
    story.primaryAsset,
    story.summary,
    labels.duration,
  );
  const ruleBadge =
    story.kind === "analyst_curated"
      ? labels.ruleBadgeAnalyst
      : (story.ruleId ?? labels.ruleBadgeAuto);
  return (
    <article
      data-testid="triage-story-card"
      data-story-id={`${story.customerId}/${story.storyId}`}
      className="flex flex-col gap-3 rounded-md border bg-card p-4 shadow-xs"
    >
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-base font-semibold text-foreground">{title}</h3>
        <div className="flex items-center gap-2">
          <span className="rounded-sm border border-border bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
            {ruleBadge}
          </span>
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
        <button
          type="button"
          data-action="send-to-aimer-web"
          data-testid="triage-story-send"
          disabled={true}
          aria-disabled="true"
          title={labels.sendToAimerWebTooltip}
          className="cursor-not-allowed rounded-sm border border-border bg-background px-3 py-1 text-sm text-muted-foreground"
          onClick={() => {
            /* no-op until #493 wires the click handler */
          }}
        >
          {labels.sendToAimerWeb}
        </button>
      </footer>
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
