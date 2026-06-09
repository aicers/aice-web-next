"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  coercePageSize,
  EMPTY_EVENT_FILTER,
  type EventFilter,
  filterToSearchEntries,
  PAGE_SIZE_OPTIONS,
  type PageAnchor,
  type PageInfo,
  type PageSize,
  paginationToSearchEntries,
  type RawEvent,
  type RawEventEdge,
  RECORD_DESCRIPTORS,
} from "@/lib/event";

import { EventFilterForm } from "./event-filter-form";
import { RawEventDetailSheet } from "./raw-event-detail-sheet";
import { RawEventResultsTable } from "./raw-event-results-table";

/** Search outcome handed down from the server component. */
export type RawEventResult =
  | { status: "prequery" }
  | { status: "error" }
  | { status: "ready"; edges: RawEventEdge<RawEvent>[]; pageInfo: PageInfo };

/**
 * Top-level client orchestrator for `/event`. Owns the editable filter
 * draft and the row-detail selection; commits searches and pagination
 * by writing the URL, which the server component re-reads to fetch the
 * next page. The active record type comes from the committed filter, so
 * the results table and detail sheet are driven by its descriptor.
 * Navigation runs inside a transition so the existing page stays
 * interactive (and dimmed) while the server fetch is in flight.
 */
export function EventSearch({
  committedFilter,
  sensors,
  pageSize,
  result,
  locale,
}: {
  committedFilter: EventFilter;
  sensors: string[] | null;
  pageSize: PageSize;
  result: RawEventResult;
  locale: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();
  const [draft, setDraft] = useState<EventFilter>(committedFilter);
  const [detail, setDetail] = useState<RawEvent | null>(null);
  // Bumped on Reset to remount the filter form so its locally-held raw
  // port text re-seeds from the cleared draft (otherwise stale invalid
  // input would linger in the inputs).
  const [formKey, setFormKey] = useState(0);

  const descriptor = RECORD_DESCRIPTORS[committedFilter.recordType];

  const navigate = (
    filter: EventFilter,
    nextPageSize: PageSize,
    anchor: PageAnchor,
  ): void => {
    const params = new URLSearchParams([
      ...filterToSearchEntries(filter),
      ...paginationToSearchEntries(nextPageSize, anchor),
    ]);
    const query = params.toString();
    startTransition(() => {
      router.push(query ? `${pathname}?${query}` : pathname);
    });
  };

  // Apply / reset commit the draft and restart at the first page.
  const onApply = (): void => navigate(draft, pageSize, { kind: "head" });
  const onReset = (): void => {
    setDraft(EMPTY_EVENT_FILTER);
    setFormKey((key) => key + 1);
    navigate(EMPTY_EVENT_FILTER, pageSize, { kind: "head" });
  };

  // Pagination keeps the committed filter; only the anchor / size move.
  const onPageSize = (next: PageSize): void =>
    navigate(committedFilter, next, { kind: "head" });

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
          <EventFilterForm
            key={formKey}
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
        <ResultsRegion
          result={result}
          descriptorId={committedFilter.recordType}
          pageSize={pageSize}
          locale={locale}
          onRowOpen={(edge) => setDetail(edge.node)}
          onPageSize={onPageSize}
          onPrev={() => {
            if (result.status === "ready" && result.pageInfo.startCursor) {
              navigate(committedFilter, pageSize, {
                kind: "before",
                cursor: result.pageInfo.startCursor,
              });
            }
          }}
          onNext={() => {
            if (result.status === "ready" && result.pageInfo.endCursor) {
              navigate(committedFilter, pageSize, {
                kind: "after",
                cursor: result.pageInfo.endCursor,
              });
            }
          }}
        />
      </div>

      <RawEventDetailSheet
        descriptor={descriptor}
        record={detail}
        locale={locale}
        onClose={() => setDetail(null)}
      />
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
  descriptorId,
  pageSize,
  locale,
  onRowOpen,
  onPageSize,
  onPrev,
  onNext,
}: {
  result: RawEventResult;
  descriptorId: EventFilter["recordType"];
  pageSize: PageSize;
  locale: string;
  onRowOpen: (edge: RawEventEdge<RawEvent>) => void;
  onPageSize: (next: PageSize) => void;
  onPrev: () => void;
  onNext: () => void;
}) {
  const t = useTranslations("event");
  const descriptor = RECORD_DESCRIPTORS[descriptorId];

  if (result.status === "prequery") {
    return <Empty message={t("states.prequery")} />;
  }
  if (result.status === "error") {
    return (
      <Empty message={t("states.error")} role="alert" tone="destructive" />
    );
  }
  if (result.edges.length === 0) {
    return <Empty message={t("states.empty")} />;
  }

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto rounded-md border">
        <RawEventResultsTable
          descriptor={descriptor}
          edges={result.edges}
          locale={locale}
          onRowOpen={onRowOpen}
        />
      </div>
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">
            {t("pagination.pageSize")}
          </span>
          <Select
            value={String(pageSize)}
            onValueChange={(value) => onPageSize(coercePageSize(Number(value)))}
          >
            <SelectTrigger
              className="w-20"
              aria-label={t("pagination.pageSize")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PAGE_SIZE_OPTIONS.map((size) => (
                <SelectItem key={size} value={String(size)}>
                  {size}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onPrev}
            disabled={!result.pageInfo.hasPreviousPage}
          >
            <ChevronLeft className="size-4" />
            {t("pagination.previous")}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onNext}
            disabled={!result.pageInfo.hasNextPage}
          >
            {t("pagination.next")}
            <ChevronRight className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  );
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
