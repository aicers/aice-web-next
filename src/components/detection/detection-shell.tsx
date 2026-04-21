"use client";

import { Bookmark, ChevronRight, SlidersHorizontal, Star } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface DetectionShellLabels {
  recommendedFilter: string;
  savedFilters: string;
  railPlaceholder: string;
  filtersOpen: string;
  filtersComingSoon: string;
  activeChips: string;
  resultsPlaceholder: string;
  analyticsToggle: string;
  analyticsShow: string;
  analyticsHide: string;
  analyticsPlaceholder: string;
}

interface DetectionShellProps {
  title: string;
  labels: DetectionShellLabels;
}

export function DetectionShell({ title, labels }: DetectionShellProps) {
  const [analyticsOpen, setAnalyticsOpen] = useState(false);

  return (
    <div className="flex gap-4">
      {/* Slim saved / recommended rail (left).
          Icon-only below desktop breakpoint, expanded at ≥1280px. */}
      <aside
        aria-label={labels.savedFilters}
        className="flex w-14 shrink-0 flex-col gap-6 border-r border-[var(--sidebar-border)] pr-2 desktop:w-60 desktop:pr-4"
      >
        <RailSection
          icon={<Star className="size-4" />}
          title={labels.recommendedFilter}
          placeholder={labels.railPlaceholder}
        />
        <RailSection
          icon={<Bookmark className="size-4" />}
          title={labels.savedFilters}
          placeholder={labels.railPlaceholder}
        />
      </aside>

      {/* Main region */}
      <section className="flex min-w-0 flex-1 flex-col gap-4">
        <h1 className="sr-only">{title}</h1>

        {/* Top bar: Filters affordance + active filter chip bar placeholder.
            The Filters button is disabled in this phase — the drawer is wired
            up in later Detection phases. */}
        <div className="flex items-center gap-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled
            aria-disabled="true"
            aria-label={labels.filtersOpen}
            title={labels.filtersComingSoon}
          >
            <SlidersHorizontal className="size-4" />
            {labels.filtersOpen}
          </Button>
          <div
            role="toolbar"
            aria-label={labels.activeChips}
            className="text-muted-foreground flex min-h-8 flex-1 items-center rounded-md border border-dashed border-[var(--sidebar-border)] px-3 text-xs"
          >
            {labels.activeChips}
          </div>
        </div>

        {/* Results region (hero) */}
        <section
          aria-label={labels.resultsPlaceholder}
          className="bg-card text-muted-foreground flex min-h-[60vh] flex-1 items-center justify-center rounded-lg border border-[var(--sidebar-border)] text-sm"
        >
          {labels.resultsPlaceholder}
        </section>

        {/* Collapsible analytics strip (collapsed by default) */}
        <div className="rounded-lg border border-[var(--sidebar-border)]">
          <button
            type="button"
            onClick={() => setAnalyticsOpen((open) => !open)}
            aria-expanded={analyticsOpen}
            aria-controls="detection-analytics-panel"
            className="text-foreground flex w-full items-center gap-2 px-3 py-2 text-sm font-medium"
          >
            <ChevronRight
              className={cn(
                "size-4 transition-transform",
                analyticsOpen && "rotate-90",
              )}
              aria-hidden="true"
            />
            <span>{labels.analyticsToggle}</span>
            <span className="sr-only">
              {analyticsOpen ? labels.analyticsHide : labels.analyticsShow}
            </span>
          </button>
          {analyticsOpen ? (
            <div
              id="detection-analytics-panel"
              className="text-muted-foreground border-t border-[var(--sidebar-border)] px-3 py-4 text-sm"
            >
              {labels.analyticsPlaceholder}
            </div>
          ) : null}
        </div>
      </section>

      {/* Quick peek inspector slot (right) — reserved; absent by default,
          activated in Phase Detection-18. */}
    </div>
  );
}

function RailSection({
  icon,
  title,
  placeholder,
}: {
  icon: React.ReactNode;
  title: string;
  placeholder: string;
}) {
  // Below the desktop breakpoint the rail is visually icon-only, but the
  // section title and placeholder stay in the accessibility tree via
  // `sr-only` so assistive tech still announces what each icon represents.
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <div className="text-muted-foreground flex items-center justify-center desktop:justify-start desktop:gap-2">
        <span aria-hidden="true">{icon}</span>
        <span className="sr-only text-xs font-medium uppercase tracking-wider desktop:not-sr-only desktop:inline">
          {title}
        </span>
      </div>
      <p className="text-muted-foreground sr-only text-xs desktop:not-sr-only desktop:block">
        {placeholder}
      </p>
    </section>
  );
}
