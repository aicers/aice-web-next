"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
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
  type ConnRawEvent,
  type ConnRawEventEdge,
  coercePageSize,
  EMPTY_EVENT_FILTER,
  type EventFilter,
  filterToSearchEntries,
  PAGE_SIZE_OPTIONS,
  type PageAnchor,
  type PageInfo,
  type PageSize,
  paginationToSearchEntries,
  recordDef,
  type SysmonRawEventEdge,
  type SysmonRawEventNode,
} from "@/lib/event";

import { ConnDetailSheet } from "./conn-detail-sheet";
import { ConnResultsTable } from "./conn-results-table";
import { EventFilterForm } from "./event-filter-form";
import { SysmonDetailSheet } from "./sysmon-detail-sheet";
import { SysmonResultsTable } from "./sysmon-results-table";

/**
 * Search outcome handed down from the server component. A `ready` result
 * is discriminated by record family: `network` (Conn) carries
 * {@link ConnRawEventEdge}s rendered by the bespoke Conn components;
 * `sysmon` carries generic {@link SysmonRawEventEdge}s rendered by the
 * data-driven table/detail.
 */
export type EventResult =
  | { status: "prequery" }
  | { status: "error" }
  | {
      status: "ready";
      family: "network";
      edges: ConnRawEventEdge[];
      pageInfo: PageInfo;
    }
  | {
      status: "ready";
      family: "sysmon";
      edges: SysmonRawEventEdge[];
      pageInfo: PageInfo;
    };

/** A row-detail record, tagged by family, before it is committed. */
type DetailNode =
  | { family: "network"; node: ConnRawEvent }
  | { family: "sysmon"; node: SysmonRawEventNode };

/**
 * The currently open row detail, additionally tagged with the committed
 * search identity (the URL query string) the row was opened from.
 * Browser Back/Forward (or any query-param navigation) re-reads the URL
 * on the server and swaps the committed result set without going through
 * {@link navigate}, so the selection has to be validated against the
 * now-committed search at render time. Keying on the full query string
 * (not just the record type) catches every such change: a different
 * record type would render a sysmon node through the wrong field
 * definition, while a same-type change of filter/page/size would leave a
 * row from a result set that is no longer on screen.
 */
type DetailSelection = DetailNode & {
  searchKey: string;
};

/**
 * Top-level client orchestrator for `/event`. Owns the editable filter
 * draft and the row-detail selection; commits searches and pagination
 * by writing the URL, which the server component re-reads to fetch the
 * next page. Navigation runs inside a transition so the existing page
 * stays interactive (and dimmed) while the server fetch is in flight.
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
  result: EventResult;
  locale: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [draft, setDraft] = useState<EventFilter>(committedFilter);
  const [detail, setDetail] = useState<DetailSelection | null>(null);
  // Bumped on Reset to remount the filter form so its locally-held raw
  // port text re-seeds from the cleared draft (otherwise stale invalid
  // input would linger in the inputs).
  const [formKey, setFormKey] = useState(0);

  const committedDef = recordDef(committedFilter.recordType);

  // Identity of the committed search: the URL query string the current
  // `result` was fetched for. A row detail is tagged with this at open
  // time; only the matching committed search may still show it.
  const committedSearchKey = searchParams.toString();

  // Canonical identity of the committed *filter* alone (no pagination):
  // the order-stable, empty-omitting encoding the URL was built from.
  const committedFilterKey = new URLSearchParams(
    filterToSearchEntries(committedFilter),
  ).toString();

  // Resync the editable draft when the committed filter changes out of
  // band — browser Back/Forward or a direct query-param edit swaps the
  // server result and URL without going through `navigate()`, leaving
  // the form rendering a stale draft (e.g. a Sysmon `agentId` input over
  // a committed Conn result, whose Apply would submit the wrong family).
  // Keying on the filter identity (not the full search key) means
  // pagination — which keeps the committed filter — preserves unsaved
  // draft edits, while a real filter change reseeds them. Bumping
  // `formKey` remounts the form so its locally-held raw port text
  // re-seeds from the new draft too. This is React's prescribed
  // adjust-state-during-render pattern: it re-renders before paint with
  // no flash of the stale form.
  const [syncedFilterKey, setSyncedFilterKey] = useState(committedFilterKey);
  if (syncedFilterKey !== committedFilterKey) {
    setSyncedFilterKey(committedFilterKey);
    setDraft(committedFilter);
    setFormKey((key) => key + 1);
  }

  // Render the open detail only while the committed search still matches
  // the one it was opened from. In-app navigation clears `detail` in
  // `navigate()`, but browser Back/Forward (or direct query-param edits)
  // swap the committed result set without it; deriving the active
  // selection (rather than trusting raw state) keeps a stale node from
  // rendering through another type's definition or against a result set
  // that has scrolled off — even when the record type is unchanged.
  const activeDetail =
    detail !== null && detail.searchKey === committedSearchKey ? detail : null;

  const navigate = (
    filter: EventFilter,
    nextPageSize: PageSize,
    anchor: PageAnchor,
  ): void => {
    // Close any open row detail: a new search/page/type navigation can
    // commit a different record type, and the sysmon sheet reads its
    // field definition from the committed type. Leaving a stale node
    // selected would render it through the wrong record definition.
    setDetail(null);
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
          recordType={committedFilter.recordType}
          pageSize={pageSize}
          locale={locale}
          onRowOpen={(selection) =>
            setDetail({ ...selection, searchKey: committedSearchKey })
          }
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

      <ConnDetailSheet
        event={activeDetail?.family === "network" ? activeDetail.node : null}
        locale={locale}
        onClose={() => setDetail(null)}
      />
      <SysmonDetailSheet
        def={committedDef}
        event={activeDetail?.family === "sysmon" ? activeDetail.node : null}
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
  recordType,
  pageSize,
  locale,
  onRowOpen,
  onPageSize,
  onPrev,
  onNext,
}: {
  result: EventResult;
  recordType: EventFilter["recordType"];
  pageSize: PageSize;
  locale: string;
  onRowOpen: (selection: DetailNode) => void;
  onPageSize: (next: PageSize) => void;
  onPrev: () => void;
  onNext: () => void;
}) {
  const t = useTranslations("event");

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
        {result.family === "network" ? (
          <ConnResultsTable
            edges={result.edges}
            locale={locale}
            onRowOpen={(edge) =>
              onRowOpen({ family: "network", node: edge.node })
            }
          />
        ) : (
          <SysmonResultsTable
            def={recordDef(recordType)}
            edges={result.edges}
            onRowOpen={(edge) =>
              onRowOpen({ family: "sysmon", node: edge.node })
            }
          />
        )}
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
