/**
 * Gmail-style cursor pagination helpers for the Detection result
 * list (Phase Detection-11).
 *
 * REview exposes a Relay-spec `EventConnection` (see
 * `schemas/review.graphql`): forward pagination uses
 * `first: N, after: <endCursor>`; backward pagination uses
 * `last: N, before: <startCursor>`. `EventConnection.totalCount` is a
 * `StringNumber` scalar — the count must stay as a string end-to-end
 * so it never loses precision on a 2^53+ event backlog.
 *
 * The shell tracks one {@link PaginationState} per tab. Apply / chip
 * removal / page-size change reset the anchor to `head`; paginator
 * clicks transition between anchors and bump the 1-indexed page
 * counter so "Go to page N" and the range indicator have something
 * to read. Cursors are opaque strings scoped to a single committed
 * filter — a new filter means a new cursor namespace, so reset on
 * Apply is mandatory.
 */

import type { SearchEventsArgs } from "./server-actions";

/**
 * Selectable page sizes for the Detection result list. Order is
 * preserved by the selector UI (`25 / 50 / 100 / 200`, default 50).
 */
export const PAGE_SIZE_OPTIONS = [25, 50, 100, 200] as const;
export type PageSize = (typeof PAGE_SIZE_OPTIONS)[number];

export const DEFAULT_PAGE_SIZE: PageSize = 50;

export function isPageSize(value: number): value is PageSize {
  return (PAGE_SIZE_OPTIONS as readonly number[]).includes(value);
}

/**
 * Coerce a caller-supplied number into a supported page size,
 * falling back to {@link DEFAULT_PAGE_SIZE} when the value is not
 * one of the allowed steps. Used at URL-ingest time so a tampered
 * `?pageSize=999` can't produce an off-menu page size that the
 * selector couldn't round-trip.
 */
export function coercePageSize(value: number | undefined): PageSize {
  if (value === undefined) return DEFAULT_PAGE_SIZE;
  return isPageSize(value) ? value : DEFAULT_PAGE_SIZE;
}

/**
 * Cursor anchor for the current page.
 *
 * - `head`: page 1; send `first: pageSize` (no cursor).
 * - `tail`: last page; send `last: pageSize` (no cursor).
 * - `after`: a forward step; send `first: pageSize, after: cursor`.
 *   `cursor` is the `endCursor` of the previous page.
 * - `before`: a backward step; send `last: pageSize, before: cursor`.
 *   `cursor` is the `startCursor` of the next-higher page.
 */
export type PageAnchor =
  | { kind: "head" }
  | { kind: "tail" }
  | { kind: "after"; cursor: string }
  | { kind: "before"; cursor: string };

export interface PaginationState {
  pageSize: PageSize;
  /** 1-indexed page number for display & Go-to-page input. */
  page: number;
  anchor: PageAnchor;
}

export const INITIAL_PAGINATION_STATE: PaginationState = {
  pageSize: DEFAULT_PAGE_SIZE,
  page: 1,
  anchor: { kind: "head" },
};

/**
 * Translate an anchor + size into the shape {@link SearchEventsArgs}
 * expects. Pure — a single switch over the anchor variant — so the
 * server page and the client shell can share one source of truth
 * for the `first/after` vs `last/before` mapping.
 *
 * `totalCount` matters only for the `tail` anchor. Under Relay
 * semantics `last: N` means "the last N elements of the connection",
 * not "page ⌈total/N⌉". On a 1,453-row total at `pageSize=100`,
 * `last: 100` returns rows 1,354-1,453 — a window that straddles
 * pages 14 and 15. To keep the numbered-page contract (the UI labels
 * the Last button as page 15 and the range indicator as 1,401-1,453
 * of 1,453), the tail request must ask for exactly the final partial
 * page's worth of rows. When `totalCount` is known (the usual case:
 * the current page is already loaded), `last` is narrowed to the
 * remainder; when it isn't (cold SSR from a `?last=1` deep link),
 * the caller falls back to `pageSize` and resolves the remainder on
 * a follow-up query once `totalCount` is in hand.
 */
export function searchArgsForAnchor(
  anchor: PageAnchor,
  pageSize: PageSize,
  totalCount: string | null = null,
): SearchEventsArgs {
  switch (anchor.kind) {
    case "head":
      return { first: pageSize };
    case "tail":
      return { last: finalPageRequestSize(totalCount, pageSize) };
    case "after":
      return { first: pageSize, after: anchor.cursor };
    case "before":
      return { last: pageSize, before: anchor.cursor };
  }
}

/**
 * Derive how many rows the final numbered page actually holds, given
 * a `totalCount` / `pageSize` pair. For totals that divide evenly
 * this is just `pageSize`; for partial totals (`1,453` rows at
 * `100/page`) it is the remainder (`53`). Used by the `tail` anchor
 * to request exactly the last partial page instead of a straddling
 * `last: pageSize` window.
 *
 * Returns `pageSize` whenever `totalCount` is `null` or unparseable;
 * the caller is expected to revisit the query once the real total is
 * known (see `searchArgsForAnchor`'s `totalCount` parameter note).
 */
export function finalPageRequestSize(
  totalCount: string | null,
  pageSize: PageSize,
): number {
  if (totalCount === null) return pageSize;
  let total: bigint;
  try {
    total = BigInt(totalCount);
  } catch {
    return pageSize;
  }
  const ZERO = BigInt(0);
  if (total <= ZERO) return pageSize;
  const size = BigInt(pageSize);
  const remainder = total % size;
  if (remainder === ZERO) return pageSize;
  return Number(remainder);
}

/**
 * Derive the page number that a successful response should be labeled
 * with. For `tail` anchors, the label is the real last page — the
 * value derived from the response's own `totalCount` — so the page
 * counter matches the rows REview actually returned even when the
 * caller's cached total was stale. For other anchors the caller's
 * chosen page is authoritative.
 *
 * Used after every committed dispatch so navigation to the tail
 * remains truthful under total drift: the server-side helper
 * {@link searchEventsAtAnchor} re-queries with the freshly returned
 * total to keep the rows correct; this helper keeps the UI label
 * in step with those rows.
 */
export function committedPageForAnchor(
  anchor: PageAnchor,
  pageSize: PageSize,
  totalCount: string | null,
  fallback: number,
): number {
  if (anchor.kind !== "tail") return fallback;
  const lastPage = totalPagesFrom(totalCount, pageSize);
  return lastPage ?? fallback;
}

/**
 * Derive the 1-indexed page at `newPageSize` that contains the first
 * row of the current window at `currentPageSize`. Used when the
 * page-size selector changes: the issue requires that changing size
 * resets to the start of the current window rather than snapping
 * back to page 1 of the whole result set.
 *
 * On page 3 at `50/page` (rows 101-150), switching to `100/page`
 * lands on page 2 (rows 101-200). On page 2 at `100/page` (rows
 * 101-200), switching to `25/page` lands on page 5 (rows 101-125).
 */
export function pageAtNewSize(
  currentPage: number,
  currentPageSize: PageSize,
  newPageSize: PageSize,
): number {
  if (!Number.isFinite(currentPage) || currentPage <= 1) return 1;
  const firstRowIndex = (currentPage - 1) * currentPageSize;
  return Math.floor(firstRowIndex / newPageSize) + 1;
}

/**
 * Derive the number of pages for a connection. `totalCount` is a
 * BigInt-safe string (REview's `StringNumber`) — never cast to
 * `number` or `Math.ceil`. Returns `null` when the total can't be
 * parsed, which the UI treats as "total pages unknown" and hides
 * the `of N` affordances for.
 */
export function totalPagesFrom(
  totalCount: string | null,
  pageSize: PageSize,
): number | null {
  if (totalCount === null) return null;
  let total: bigint;
  try {
    total = BigInt(totalCount);
  } catch {
    return null;
  }
  const ZERO = BigInt(0);
  const ONE = BigInt(1);
  if (total < ZERO) return null;
  if (total === ZERO) return 1;
  const size = BigInt(pageSize);
  const pages = total / size + (total % size === ZERO ? ZERO : ONE);
  // Clamp to Number.MAX_SAFE_INTEGER so the UI math (page arithmetic,
  // progress counters) stays in the safe integer range. At 200-per
  // page this supports 1.8e18 events, well beyond anything REview
  // can hold.
  if (pages > BigInt(Number.MAX_SAFE_INTEGER)) return Number.MAX_SAFE_INTEGER;
  return Number(pages);
}

/**
 * Format a page's [start–end] position in the total range using the
 * operator's locale for grouping. Both bounds are returned as
 * grouping-formatted strings so the BigInt total stays precise even
 * when `Number` would overflow.
 *
 * `totalCount` uses `BigInt.toLocaleString` (string-parseable
 * end-to-end). The per-page bounds are computed from `page` and
 * `pageSize` which are both safe integers, then converted to
 * BigInt + `toLocaleString` so the three numbers format with a
 * single grouping convention.
 */
export function formatPageRange(
  totalCount: string | null,
  page: number,
  pageSize: PageSize,
  locale: string,
): { start: string; end: string; total: string } | null {
  if (totalCount === null) return null;
  let total: bigint;
  try {
    total = BigInt(totalCount);
  } catch {
    return null;
  }
  const ZERO = BigInt(0);
  const ONE = BigInt(1);
  if (total <= ZERO) {
    return {
      start: ZERO.toLocaleString(locale),
      end: ZERO.toLocaleString(locale),
      total: total.toLocaleString(locale),
    };
  }
  const size = BigInt(pageSize);
  const pageIndex = BigInt(Math.max(1, page)) - ONE;
  const startBig = pageIndex * size + ONE;
  const lastOnPage = startBig + size - ONE;
  const endBig = lastOnPage > total ? total : lastOnPage;
  return {
    start: startBig.toLocaleString(locale),
    end: endBig.toLocaleString(locale),
    total: total.toLocaleString(locale),
  };
}

/**
 * Parse the Go-to-page input's raw text into a positive integer page
 * number, or `null` if the input isn't a valid page-number literal.
 *
 * Rejects scientific notation (`1e3`), decimals (`3.5`), signed
 * numbers (`-1`, `+1`), and whitespace-only input — all of which
 * `Number.parseInt()` would silently truncate to an unexpected value
 * (`1e3` → `1`, `3.5` → `3`). Leading/trailing whitespace is trimmed
 * so casual copy/paste still works.
 *
 * Only `Number.isSafeInteger` results survive so the paginator's
 * cursor math stays inside the safe integer range; larger pastes
 * (`9e18`) return `null` instead of silently capping.
 */
export function parseGoToPageInput(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return null;
  return parsed;
}

/**
 * URL query-string names that persist pagination in the tab's
 * address bar. Exposed so the tests and the page + shell agree on
 * one spelling. The shell reuses `after` / `before` / `last` from
 * the Relay spec so a user who copies the URL sees names that
 * match the GraphQL variables they ultimately drive.
 */
export const PAGINATION_PARAM_KEYS = {
  pageSize: "pageSize",
  page: "page",
  after: "after",
  before: "before",
  last: "last",
} as const;

export interface SerializedPagination {
  pageSize?: PageSize;
  after?: string;
  before?: string;
  last?: boolean;
  page?: number;
}

/**
 * Decode pagination from the Detection URL. Unknown / malformed
 * values are dropped silently — the URL is treated as a best-effort
 * handoff, not a validated form. When multiple anchor hints are
 * present (`after` + `before` + `last`), precedence is `last` →
 * `after` → `before`; the extras are ignored.
 */
export function parsePaginationSearchParams(
  source: Record<string, string | string[] | undefined>,
): PaginationState {
  const pageSizeRaw = readInt(source, PAGINATION_PARAM_KEYS.pageSize);
  const pageSize = coercePageSize(pageSizeRaw);
  const pageRaw = readInt(source, PAGINATION_PARAM_KEYS.page);
  const page = pageRaw !== undefined && pageRaw >= 1 ? pageRaw : 1;

  const last = readString(source, PAGINATION_PARAM_KEYS.last);
  if (last === "1") {
    return { pageSize, page: Math.max(1, page), anchor: { kind: "tail" } };
  }
  const after = readString(source, PAGINATION_PARAM_KEYS.after);
  if (after) {
    return {
      pageSize,
      page: Math.max(2, page),
      anchor: { kind: "after", cursor: after },
    };
  }
  const before = readString(source, PAGINATION_PARAM_KEYS.before);
  if (before) {
    return {
      pageSize,
      page: Math.max(1, page),
      anchor: { kind: "before", cursor: before },
    };
  }
  return { pageSize, page: 1, anchor: { kind: "head" } };
}

/**
 * Encode pagination into URL-safe entries. Default page size is
 * omitted so a fresh `/detection` URL stays tidy. Only the subset
 * of params that describe the current page is written — the others
 * are removed on every navigation so a stale `before=` can't linger
 * after a Next click.
 */
export function paginationToSearchEntries(
  state: PaginationState,
): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  if (state.pageSize !== DEFAULT_PAGE_SIZE) {
    entries.push([PAGINATION_PARAM_KEYS.pageSize, String(state.pageSize)]);
  }
  switch (state.anchor.kind) {
    case "head":
      // Implicit page 1; no anchor params and no page=1.
      break;
    case "tail":
      entries.push([PAGINATION_PARAM_KEYS.last, "1"]);
      if (state.page > 1) {
        entries.push([PAGINATION_PARAM_KEYS.page, String(state.page)]);
      }
      break;
    case "after":
      entries.push([PAGINATION_PARAM_KEYS.after, state.anchor.cursor]);
      if (state.page > 1) {
        entries.push([PAGINATION_PARAM_KEYS.page, String(state.page)]);
      }
      break;
    case "before":
      entries.push([PAGINATION_PARAM_KEYS.before, state.anchor.cursor]);
      if (state.page > 1) {
        entries.push([PAGINATION_PARAM_KEYS.page, String(state.page)]);
      }
      break;
  }
  return entries;
}

/**
 * Remove every pagination-owned key from a `URLSearchParams` so the
 * caller can re-serialize fresh values without leaving stale
 * cursors behind. The detection URL mixes pagination with pivot /
 * free-form filter params; this surgical clear lets the shell
 * rewrite pagination alongside those without clobbering them.
 */
export function clearPaginationParams(search: URLSearchParams): void {
  for (const key of Object.values(PAGINATION_PARAM_KEYS)) {
    search.delete(key);
  }
}

function readString(
  source: Record<string, string | string[] | undefined>,
  key: string,
): string | undefined {
  const raw = source[key];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readInt(
  source: Record<string, string | string[] | undefined>,
  key: string,
): number | undefined {
  const raw = readString(source, key);
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return n;
}
