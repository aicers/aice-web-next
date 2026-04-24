"use client";

import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
} from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  formatPageRange,
  PAGE_SIZE_OPTIONS,
  type PageSize,
  parseGoToPageInput,
  totalPagesFrom,
} from "@/lib/detection/pagination";
import { cn } from "@/lib/utils";

/**
 * Gmail-style paginator for the Detection result list (Phase
 * Detection-11). Renders a page-size selector, a locale-formatted
 * range + total indicator, First / Prev / Next / Last buttons, and
 * an explicit Go-to-page input for rare deep seeks.
 *
 * The component is presentational. Cursor arithmetic, URL
 * persistence, and the sequential-walk needed for Go-to-page live
 * in the shell; `PaginationControls` only raises intents via the
 * callbacks below.
 *
 * `totalCount` is the `EventConnection.totalCount` — a
 * {@link StringNumberScalar}, so it stays as a string end-to-end
 * (never cast to JS `number`) to preserve BigInt precision.
 */

export interface PaginationControlsLabels {
  pageSizeLabel: string;
  rangeIndicator: (args: {
    start: string;
    end: string;
    total: string;
  }) => React.ReactNode;
  totalOnly: (args: { total: string }) => React.ReactNode;
  pageOfTotal: (args: { page: string; total: string }) => React.ReactNode;
  firstPage: string;
  previousPage: string;
  nextPage: string;
  lastPage: string;
  goToPageLabel: string;
  goToPagePlaceholder: string;
  goToPageSubmit: string;
  /**
   * Rendered under the Go-to-page input while a multi-page walk is
   * in flight. `current` / `target` are already locale-formatted so
   * the message stays consistent with the range indicator.
   */
  walkingProgress: (args: { current: string; target: string }) => string;
}

export interface PaginationControlsProps {
  labels: PaginationControlsLabels;
  locale: string;
  /** `EventConnection.totalCount` — BigInt-safe string, not a number. */
  totalCount: string | null;
  pageSize: PageSize;
  /** 1-indexed current page. */
  page: number;
  hasPreviousPage: boolean;
  hasNextPage: boolean;
  /** Disable interaction while a query is in flight. */
  disabled?: boolean;
  /**
   * In-flight multi-step walk. When present, the paginator shows a
   * subtle progress hint under the Go-to-page input so the operator
   * knows the action is working through cursors rather than hung.
   */
  walking?: { current: number; target: number } | null;
  onPageSizeChange: (size: PageSize) => void;
  onFirst: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onLast: () => void;
  onGoToPage: (page: number) => void;
}

export function PaginationControls({
  labels,
  locale,
  totalCount,
  pageSize,
  page,
  hasPreviousPage,
  hasNextPage,
  disabled = false,
  walking = null,
  onPageSizeChange,
  onFirst,
  onPrevious,
  onNext,
  onLast,
  onGoToPage,
}: PaginationControlsProps) {
  const totalPages = totalPagesFrom(totalCount, pageSize);
  const range = formatPageRange(totalCount, page, pageSize, locale);
  // Local state for the Go-to-page input. Kept in string form so the
  // operator can clear it without the field auto-filling back to a
  // number, and validated on submit so leading zeros / spaces don't
  // reject an otherwise-intended page.
  const [gotoValue, setGotoValue] = useState("");

  const zeroResults =
    totalCount !== null &&
    (() => {
      try {
        return BigInt(totalCount) === BigInt(0);
      } catch {
        return false;
      }
    })();

  // Integer-only parsing — `parseGoToPageInput` rejects scientific
  // notation (`1e3`), decimals, and signed values that the native
  // `type=number` input would otherwise accept and silently truncate
  // via `parseInt`.
  const gotoParsed = parseGoToPageInput(gotoValue);

  const handleGotoSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (gotoParsed === null) return;
    onGoToPage(gotoParsed);
    setGotoValue("");
  };

  return (
    <nav
      aria-label={labels.goToPageLabel}
      className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--sidebar-border)] pt-3"
      data-slot="detection-pagination"
    >
      <div className="flex items-center gap-2">
        <label
          htmlFor="detection-page-size"
          className="text-muted-foreground text-xs font-medium"
        >
          {labels.pageSizeLabel}
        </label>
        <Select
          value={String(pageSize)}
          onValueChange={(next) => {
            const parsed = Number.parseInt(next, 10) as PageSize;
            if (PAGE_SIZE_OPTIONS.includes(parsed)) onPageSizeChange(parsed);
          }}
          disabled={disabled}
        >
          <SelectTrigger
            id="detection-page-size"
            className="h-8 w-[5.5rem] px-2 text-xs"
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

      <div className="text-muted-foreground flex-1 text-center text-xs tabular-nums">
        {range && !zeroResults
          ? labels.rangeIndicator({
              start: range.start,
              end: range.end,
              total: range.total,
            })
          : range
            ? labels.totalOnly({ total: range.total })
            : null}
      </div>

      <div className="flex items-center gap-1">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={labels.firstPage}
          disabled={disabled || !hasPreviousPage}
          onClick={onFirst}
          className="size-8"
        >
          <ChevronsLeft className="size-4" aria-hidden="true" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={labels.previousPage}
          disabled={disabled || !hasPreviousPage}
          onClick={onPrevious}
          className="size-8"
        >
          <ChevronLeft className="size-4" aria-hidden="true" />
        </Button>
        <span
          className="text-muted-foreground px-2 text-xs tabular-nums"
          aria-live="polite"
        >
          {totalPages !== null
            ? labels.pageOfTotal({
                page: BigInt(page).toLocaleString(locale),
                total: BigInt(totalPages).toLocaleString(locale),
              })
            : BigInt(page).toLocaleString(locale)}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={labels.nextPage}
          disabled={disabled || !hasNextPage}
          onClick={onNext}
          className="size-8"
        >
          <ChevronRight className="size-4" aria-hidden="true" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={labels.lastPage}
          disabled={disabled || !hasNextPage}
          onClick={onLast}
          className="size-8"
        >
          <ChevronsRight className="size-4" aria-hidden="true" />
        </Button>
      </div>

      <form
        onSubmit={handleGotoSubmit}
        className="flex items-center gap-2"
        aria-label={labels.goToPageLabel}
      >
        <label
          htmlFor="detection-page-goto"
          className="text-muted-foreground text-xs font-medium"
        >
          {labels.goToPageLabel}
        </label>
        <Input
          id="detection-page-goto"
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          placeholder={labels.goToPagePlaceholder}
          value={gotoValue}
          onChange={(e) => setGotoValue(e.target.value)}
          aria-invalid={gotoValue.trim().length > 0 && gotoParsed === null}
          className="h-8 w-20 text-xs tabular-nums"
          disabled={disabled}
        />
        <Button
          type="submit"
          variant="outline"
          size="sm"
          disabled={disabled || gotoParsed === null}
        >
          {labels.goToPageSubmit}
        </Button>
        <WalkingProgress walking={walking} locale={locale} labels={labels} />
      </form>
    </nav>
  );
}

/**
 * Subtle progress hint for multi-step Go-to-page walks. Announced
 * via `aria-live="polite"` so screen readers hear "Walking… 4 of 9"
 * without yanking focus away from the input.
 *
 * Uses a mount/unmount transition via keyed children so the hint
 * disappears cleanly when the walk finishes — the element only
 * exists while `walking` is non-null.
 */
function WalkingProgress({
  walking,
  locale,
  labels,
}: {
  walking: { current: number; target: number } | null;
  locale: string;
  labels: PaginationControlsLabels;
}) {
  // A brief local copy of the last value keeps the text visible for
  // a few ticks after the walk resolves — without it the hint winks
  // out the moment `walking` goes null, which on a fast backend reads
  // as a flash rather than confirmation that the walk completed.
  const [lastSeen, setLastSeen] = useState<{
    current: number;
    target: number;
  } | null>(null);
  useEffect(() => {
    if (walking) setLastSeen(walking);
  }, [walking]);
  const display = walking ?? lastSeen;
  if (!display) return null;
  return (
    <span
      role="status"
      aria-live="polite"
      className={cn(
        "text-muted-foreground text-xs tabular-nums",
        walking ? "opacity-100" : "opacity-0 transition-opacity delay-300",
      )}
    >
      {labels.walkingProgress({
        current: BigInt(display.current).toLocaleString(locale),
        target: BigInt(display.target).toLocaleString(locale),
      })}
    </span>
  );
}
