"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  EMPTY_TIME_SERIES_FILTER,
  type SamplingPolicy,
  TIME_SERIES_PARAM_KEYS,
  type TimeSeriesFilter,
  type TimeSeriesNode,
  timeSeriesFilterToSearchEntries,
  VIEW_MODE_PARAM,
} from "@/lib/event";

import { EventStatePanel } from "./result-panels";
import { TimeSeriesChart } from "./time-series-chart";
import { TimeSeriesFilterForm } from "./time-series-filter-form";

/** Periodic time series fetch outcome handed down from the server. */
export type TimeSeriesResultState =
  | { status: "prequery" }
  | { status: "error" }
  | { status: "ready"; nodes: TimeSeriesNode[] };

/**
 * Top-level client orchestrator for the Periodic Time Series view. Owns
 * the editable filter draft; commits by writing the URL, which the
 * server component re-reads to fetch the series. The view-mode param is
 * preserved on every navigation so the page stays on Time Series.
 */
export function TimeSeriesView({
  committedFilter,
  policies,
  result,
  locale,
}: {
  committedFilter: TimeSeriesFilter;
  policies: SamplingPolicy[] | null;
  result: TimeSeriesResultState;
  locale: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [draft, setDraft] = useState<TimeSeriesFilter>(committedFilter);

  const navigate = (filter: TimeSeriesFilter): void => {
    // Start from the current params so the other views' filters (and any
    // unrelated params) survive a Time Series search; replace only the
    // time-series-owned keys and keep the view pinned to Time Series.
    const params = new URLSearchParams(searchParams.toString());
    for (const key of Object.values(TIME_SERIES_PARAM_KEYS)) {
      params.delete(key);
    }
    for (const [key, value] of timeSeriesFilterToSearchEntries(filter)) {
      params.set(key, value);
    }
    params.set(VIEW_MODE_PARAM, "timeseries");
    const query = params.toString();
    startTransition(() => {
      router.push(query ? `${pathname}?${query}` : pathname);
    });
  };

  const onApply = (): void => navigate(draft);
  const onReset = (): void => {
    setDraft(EMPTY_TIME_SERIES_FILTER);
    navigate(EMPTY_TIME_SERIES_FILTER);
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            <FiltersHeading />
          </CardTitle>
        </CardHeader>
        <CardContent>
          {policies === null ? <PoliciesUnavailableNotice /> : null}
          <TimeSeriesFilterForm
            draft={draft}
            policies={policies}
            pending={pending}
            onChange={setDraft}
            onApply={onApply}
            onReset={onReset}
          />
        </CardContent>
      </Card>

      <div
        aria-busy={pending}
        className={pending ? "pointer-events-none opacity-60" : undefined}
      >
        <ResultsRegion result={result} locale={locale} />
      </div>
    </div>
  );
}

function FiltersHeading() {
  const t = useTranslations("event.filters");
  return <>{t("heading")}</>;
}

function PoliciesUnavailableNotice() {
  const t = useTranslations("event.timeSeries");
  return (
    <p className="text-destructive mb-3 text-sm" role="alert">
      {t("policiesUnavailable")}
    </p>
  );
}

function ResultsRegion({
  result,
  locale,
}: {
  result: TimeSeriesResultState;
  locale: string;
}) {
  const t = useTranslations("event");
  const ts = useTranslations("event.timeSeries");

  if (result.status === "prequery") {
    return <EventStatePanel message={ts("prequery")} />;
  }
  if (result.status === "error") {
    return (
      <EventStatePanel
        message={t("states.error")}
        role="alert"
        tone="destructive"
      />
    );
  }
  if (result.nodes.length === 0) {
    return <EventStatePanel message={ts("empty")} />;
  }

  return <TimeSeriesChart nodes={result.nodes} locale={locale} />;
}
