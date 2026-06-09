/**
 * Cursor-only Prev/Next pagination for the Event-menu result list.
 *
 * Giganto's network-event connections (`ConnRawEventConnection`, …)
 * are Relay cursor connections that expose `pageInfo` and `edges` but
 * **no `totalCount`** and **no `orderBy`**. Forward paging uses
 * `first: N, after: <endCursor>`; backward paging uses
 * `last: N, before: <startCursor>`. Giganto reverses the backward slice
 * internally, so every page's edges arrive in ascending (time-ordered)
 * order regardless of direction — the UI renders them as-is, no
 * client-side reversal needed.
 *
 * Because there is no total, the paginator is strictly Prev/Next:
 * there is no Last button, no "of N pages", and no go-to-page input.
 * Navigation availability is read directly off `pageInfo`
 * (`hasNextPage` / `hasPreviousPage`). This deliberately does **not**
 * reuse Detection's `totalCount`-dependent helpers.
 */

/**
 * Giganto rejects `first` / `last` above its `MAXIMUM_PAGE_SIZE`
 * (100). Mirrored here so the selector and clamp never request an
 * off-menu page that Giganto would reject at the GraphQL layer. This is
 * intentionally a dedicated constant rather than a reuse of
 * `REVIEW_MAX_PAGE_SIZE` — the two backends cap independently.
 */
export const GIGANTO_MAX_PAGE_SIZE = 100;

/** Selectable page sizes for the Event result list (default 50). */
export const PAGE_SIZE_OPTIONS = [25, 50, GIGANTO_MAX_PAGE_SIZE] as const;
export type PageSize = (typeof PAGE_SIZE_OPTIONS)[number];

export const DEFAULT_PAGE_SIZE: PageSize = 50;

export function isPageSize(value: number): value is PageSize {
  return (PAGE_SIZE_OPTIONS as readonly number[]).includes(value);
}

/**
 * Coerce a caller-supplied number into a supported page size. Values
 * above {@link GIGANTO_MAX_PAGE_SIZE} clamp DOWN to the max (the
 * operator wanted a larger page); other unsupported values fall back to
 * {@link DEFAULT_PAGE_SIZE}.
 */
export function coercePageSize(value: number | undefined): PageSize {
  if (value === undefined) return DEFAULT_PAGE_SIZE;
  if (isPageSize(value)) return value;
  if (Number.isFinite(value) && value > GIGANTO_MAX_PAGE_SIZE) {
    return GIGANTO_MAX_PAGE_SIZE;
  }
  return DEFAULT_PAGE_SIZE;
}

/**
 * Cursor anchor for the current page. There is no `tail` variant —
 * without `totalCount` the last page is not addressable.
 *
 * - `head`: first page; send `first: pageSize` (no cursor).
 * - `after`: a forward step; send `first: pageSize, after: cursor`,
 *   where `cursor` is the `endCursor` of the previous page.
 * - `before`: a backward step; send `last: pageSize, before: cursor`,
 *   where `cursor` is the `startCursor` of the next-higher page.
 */
export type PageAnchor =
  | { kind: "head" }
  | { kind: "after"; cursor: string }
  | { kind: "before"; cursor: string };

export const INITIAL_ANCHOR: PageAnchor = { kind: "head" };

/** GraphQL pagination arguments for a Giganto network-event query. */
export interface ConnPageArgs {
  first?: number;
  after?: string;
  last?: number;
  before?: string;
}

/**
 * Translate an anchor + size into the `first/after` vs `last/before`
 * shape Giganto expects. Pure switch over the anchor variant so the
 * server action and the client controls share one mapping.
 */
export function pageArgsForAnchor(
  anchor: PageAnchor,
  pageSize: PageSize,
): ConnPageArgs {
  switch (anchor.kind) {
    case "head":
      return { first: pageSize };
    case "after":
      return { first: pageSize, after: anchor.cursor };
    case "before":
      return { last: pageSize, before: anchor.cursor };
  }
}

/**
 * URL query-string names that persist pagination. `after` / `before`
 * mirror the Relay variables so a copied URL reads consistently with
 * the GraphQL it drives; there is no `last` key because there is no
 * `tail` anchor.
 */
export const PAGINATION_PARAM_KEYS = {
  pageSize: "pageSize",
  after: "after",
  before: "before",
} as const;

export interface ParsedPagination {
  pageSize: PageSize;
  anchor: PageAnchor;
}

/**
 * Decode pagination from the Event URL. Malformed values are dropped
 * silently. When both `after` and `before` are present, `after` wins
 * (forward navigation is the common case); the extra is ignored.
 */
export function parsePaginationSearchParams(
  source: Record<string, string | string[] | undefined>,
): ParsedPagination {
  const pageSize = coercePageSize(
    readInt(source, PAGINATION_PARAM_KEYS.pageSize),
  );
  const after = readString(source, PAGINATION_PARAM_KEYS.after);
  if (after) return { pageSize, anchor: { kind: "after", cursor: after } };
  const before = readString(source, PAGINATION_PARAM_KEYS.before);
  if (before) return { pageSize, anchor: { kind: "before", cursor: before } };
  return { pageSize, anchor: { kind: "head" } };
}

/**
 * Encode pagination into URL-safe entries. The default page size is
 * omitted so a fresh `/event` URL stays tidy, and only the anchor's own
 * cursor key is written so a stale `before=` cannot linger after a Next
 * click.
 */
export function paginationToSearchEntries(
  pageSize: PageSize,
  anchor: PageAnchor,
): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  if (pageSize !== DEFAULT_PAGE_SIZE) {
    entries.push([PAGINATION_PARAM_KEYS.pageSize, String(pageSize)]);
  }
  if (anchor.kind === "after") {
    entries.push([PAGINATION_PARAM_KEYS.after, anchor.cursor]);
  } else if (anchor.kind === "before") {
    entries.push([PAGINATION_PARAM_KEYS.before, anchor.cursor]);
  }
  return entries;
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
