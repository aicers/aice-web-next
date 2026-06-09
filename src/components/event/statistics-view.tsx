"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  EMPTY_STATISTICS_FILTER,
  STATISTICS_PARAM_KEYS,
  type StatisticsFilter,
  type StatisticsRawEvent,
  statisticsFilterToSearchEntries,
  VIEW_MODE_PARAM,
} from "@/lib/event";

import { StatisticsChart } from "./statistics-chart";
import { StatisticsFilterForm } from "./statistics-filter-form";

/** Statistics fetch outcome handed down from the server component. */
export type StatisticsResultState =
  | { status: "prequery" }
  | { status: "error" }
  | { status: "ready"; events: StatisticsRawEvent[] };

/**
 * Top-level client orchestrator for the Statistics view. Owns the
 * editable filter draft; commits by writing the URL, which the server
 * component re-reads to fetch the aggregation. The view-mode param is
 * preserved on every navigation so the page stays on Statistics.
 */
export function StatisticsView({
  committedFilter,
  sensors,
  result,
  locale,
}: {
  committedFilter: StatisticsFilter;
  sensors: string[] | null;
  result: StatisticsResultState;
  locale: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [draft, setDraft] = useState<StatisticsFilter>(committedFilter);

  const navigate = (filter: StatisticsFilter): void => {
    // Start from the current params so the Events view's filter (and any
    // unrelated params) survive a Statistics search; replace only the
    // statistics-owned keys and keep the view pinned to Statistics.
    const params = new URLSearchParams(searchParams.toString());
    for (const key of Object.values(STATISTICS_PARAM_KEYS)) {
      params.delete(key);
    }
    for (const [key, value] of statisticsFilterToSearchEntries(filter)) {
      params.set(key, value);
    }
    params.set(VIEW_MODE_PARAM, "statistics");
    const query = params.toString();
    startTransition(() => {
      router.push(query ? `${pathname}?${query}` : pathname);
    });
  };

  const onApply = (): void => navigate(draft);
  const onReset = (): void => {
    setDraft(EMPTY_STATISTICS_FILTER);
    navigate(EMPTY_STATISTICS_FILTER);
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
          {sensors === null ? <SensorsUnavailableNotice /> : null}
          <StatisticsFilterForm
            draft={draft}
            sensors={sensors}
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

function SensorsUnavailableNotice() {
  const t = useTranslations("event.states");
  return (
    <p className="text-destructive mb-3 text-sm" role="alert">
      {t("sensorsUnavailable")}
    </p>
  );
}

function ResultsRegion({
  result,
  locale,
}: {
  result: StatisticsResultState;
  locale: string;
}) {
  const t = useTranslations("event");
  const ts = useTranslations("event.statistics");

  if (result.status === "prequery") {
    return <Empty message={ts("prequery")} />;
  }
  if (result.status === "error") {
    return (
      <Empty message={t("states.error")} role="alert" tone="destructive" />
    );
  }
  if (result.events.length === 0) {
    return <Empty message={ts("empty")} />;
  }

  return <StatisticsChart events={result.events} locale={locale} />;
}

function Empty({
  message,
  role,
  tone,
}: {
  message: string;
  role?: "alert";
  tone?: "destructive";
}) {
  return (
    <div
      role={role}
      className={`rounded-md border border-dashed p-10 text-center text-sm ${
        tone === "destructive" ? "text-destructive" : "text-muted-foreground"
      }`}
    >
      {message}
    </div>
  );
}
