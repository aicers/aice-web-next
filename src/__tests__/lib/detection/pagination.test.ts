import { describe, expect, it } from "vitest";

import {
  clearPaginationParams,
  coercePageSize,
  committedPageForAnchor,
  DEFAULT_PAGE_SIZE,
  finalPageRequestSize,
  formatPageRange,
  isPageSize,
  PAGE_SIZE_OPTIONS,
  PAGINATION_PARAM_KEYS,
  pageAtNewSize,
  paginationToSearchEntries,
  parseGoToPageInput,
  parsePaginationSearchParams,
  searchArgsForAnchor,
  totalPagesFrom,
} from "@/lib/detection/pagination";

describe("page-size guardrails", () => {
  it("exposes the Gmail-spec steps in order capped at review's hard limit, with 50 as the default", () => {
    // The menu stops at 100 (#405): review 0.47.0 rejects `first` /
    // `last` above 100, so any larger step would produce a guaranteed
    // 500 from the result page once selected.
    expect(PAGE_SIZE_OPTIONS).toEqual([25, 50, 100]);
    expect(DEFAULT_PAGE_SIZE).toBe(50);
  });

  it("isPageSize only accepts the listed steps", () => {
    for (const size of PAGE_SIZE_OPTIONS) expect(isPageSize(size)).toBe(true);
    expect(isPageSize(30)).toBe(false);
    expect(isPageSize(0)).toBe(false);
    expect(isPageSize(Number.NaN)).toBe(false);
    expect(isPageSize(200)).toBe(false);
  });

  it("coercePageSize snaps off-menu values that exceed review's cap to that cap", () => {
    // A hand-edited URL may carry `?pageSize=200`. Coercing it down
    // to 100 (review's hard upper bound) preserves the operator's
    // intent (a larger page) instead of collapsing back to the
    // default.
    expect(coercePageSize(200)).toBe(100);
    expect(coercePageSize(999)).toBe(100);
  });

  it("coercePageSize falls back to the default for unknown sub-cap values", () => {
    expect(coercePageSize(undefined)).toBe(DEFAULT_PAGE_SIZE);
    expect(coercePageSize(30)).toBe(DEFAULT_PAGE_SIZE);
    expect(coercePageSize(0)).toBe(DEFAULT_PAGE_SIZE);
    expect(coercePageSize(25)).toBe(25);
  });
});

describe("searchArgsForAnchor", () => {
  it("maps `head` to forward with no cursor", () => {
    expect(searchArgsForAnchor({ kind: "head" }, 50)).toEqual({ first: 50 });
  });

  it("maps `tail` to backward with pageSize when totalCount is unknown", () => {
    expect(searchArgsForAnchor({ kind: "tail" }, 25)).toEqual({ last: 25 });
  });

  it("narrows `tail` to the partial final page when totalCount is known", () => {
    // Reviewer Round 2 #1: `last: 100` on a 1,453-row total returns
    // rows 1,354-1,453 (straddling pages 14 and 15). Page 15 is
    // rows 1,401-1,453 (53 rows), so the tail request must ask for
    // exactly that remainder. Without this, the UI labels the row
    // window `page 15 / 1,401-1,453 of 1,453` while actually
    // rendering rows from page 14.
    expect(searchArgsForAnchor({ kind: "tail" }, 100, "1453")).toEqual({
      last: 53,
    });
  });

  it("keeps `tail` at pageSize when the total divides evenly", () => {
    // 1,400 / 100 = 14 pages exactly. The last numbered page *is*
    // the last `pageSize` slice — no partial remainder to narrow to.
    expect(searchArgsForAnchor({ kind: "tail" }, 100, "1400")).toEqual({
      last: 100,
    });
  });

  it("falls back to pageSize for unparseable totals", () => {
    expect(searchArgsForAnchor({ kind: "tail" }, 50, "not-a-number")).toEqual({
      last: 50,
    });
  });

  it("maps `after` to forward with cursor", () => {
    expect(searchArgsForAnchor({ kind: "after", cursor: "abc" }, 100)).toEqual({
      first: 100,
      after: "abc",
    });
  });

  it("maps `before` to backward with cursor", () => {
    expect(searchArgsForAnchor({ kind: "before", cursor: "xyz" }, 100)).toEqual(
      { last: 100, before: "xyz" },
    );
  });
});

describe("finalPageRequestSize — partial-final-page remainder", () => {
  it("returns pageSize when the total is unknown", () => {
    expect(finalPageRequestSize(null, 100)).toBe(100);
  });

  it("returns pageSize on unparseable totals", () => {
    expect(finalPageRequestSize("not a number", 50)).toBe(50);
  });

  it("returns pageSize when the total divides evenly", () => {
    expect(finalPageRequestSize("1400", 100)).toBe(100);
    expect(finalPageRequestSize("50", 25)).toBe(25);
  });

  it("returns the remainder on a partial final page", () => {
    // 1,453 % 100 = 53 — what the last numbered page actually holds.
    expect(finalPageRequestSize("1453", 100)).toBe(53);
    expect(finalPageRequestSize("51", 25)).toBe(1);
  });

  it("returns pageSize for an empty total so an empty connection still renders a page", () => {
    // 0 rows: `last: 0` is not meaningful; fall back to pageSize
    // and let the empty-state panel take over.
    expect(finalPageRequestSize("0", 50)).toBe(50);
  });
});

describe("totalPagesFrom — BigInt-safe", () => {
  it("returns null when the total is missing or unparseable", () => {
    expect(totalPagesFrom(null, 50)).toBeNull();
    expect(totalPagesFrom("not a number", 50)).toBeNull();
  });

  it("treats an empty connection as a single empty page", () => {
    // An empty result still renders one page (the zero-results
    // panel); bumping the counter to 0 would make the paginator
    // read "Page 1 of 0".
    expect(totalPagesFrom("0", 50)).toBe(1);
  });

  it("rounds up partial final pages", () => {
    expect(totalPagesFrom("50", 50)).toBe(1);
    expect(totalPagesFrom("51", 50)).toBe(2);
    expect(totalPagesFrom("100", 25)).toBe(4);
    expect(totalPagesFrom("101", 25)).toBe(5);
  });

  it("clamps the page count to Number.MAX_SAFE_INTEGER for galactic totals", () => {
    // The point of StringNumberScalar is that we never cast the
    // total to `Number`. For a total whose derived page count
    // exceeds safe-int range, the helper clamps the exposed number
    // so downstream arithmetic stays finite instead of silently
    // rounding. (2^70 / 100 ≈ 1.18e19, comfortably past
    // Number.MAX_SAFE_INTEGER ≈ 9.0e15.)
    const huge = "1180591620717411303424"; // 2^70
    const pages = totalPagesFrom(huge, 100);
    expect(pages).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("pageAtNewSize — keep the current window's start visible", () => {
  // Reviewer Round 1 #1: changing the page size must keep the
  // operator near the first row of the current window. The
  // previous implementation snapped back to page 1, which silently
  // teleported operators sitting on a deep page.

  it("returns 1 when already on page 1", () => {
    expect(pageAtNewSize(1, 50, 100)).toBe(1);
  });

  it("returns 1 for any invalid page number", () => {
    expect(pageAtNewSize(0, 50, 100)).toBe(1);
    expect(pageAtNewSize(-3, 50, 100)).toBe(1);
    expect(pageAtNewSize(Number.NaN, 50, 100)).toBe(1);
  });

  it("halves the page number when the size doubles and the boundary lines up", () => {
    // 3 * 50 = 150 rows passed; under 100/page that's rows 101–200.
    expect(pageAtNewSize(3, 50, 100)).toBe(2);
    expect(pageAtNewSize(5, 50, 100)).toBe(3);
  });

  it("quadruples when the size shrinks by 4× and the boundary lines up", () => {
    // page 2 @ 100/page → rows 101–200; at 25/page, row 101 is
    // the first row of page 5 (rows 101–125).
    expect(pageAtNewSize(2, 100, 25)).toBe(5);
  });

  it("rounds down to the page containing the current first row", () => {
    // page 4 @ 25/page → first row = 76. Under 50/page, row 76
    // sits on page 2 (rows 51–100).
    expect(pageAtNewSize(4, 25, 50)).toBe(2);
    // page 5 @ 25/page → first row = 101. Under 50/page, that's
    // page 3 (rows 101–150).
    expect(pageAtNewSize(5, 25, 50)).toBe(3);
  });
});

describe("committedPageForAnchor — label tracks actual rows under total drift", () => {
  // Reviewer Round 3 #1: once `searchEventsAtAnchor` re-queries a
  // tail window against a drifted total, the page label has to be
  // re-derived from the returned total too, otherwise the rows and
  // page number disagree (e.g. rows 1,401–1,500 under a “page 15”
  // label when the fresh total is 1,500 and the real last page is
  // 15). Helper keeps non-tail anchors on the caller-chosen page.
  it("passes the caller page through for non-tail anchors", () => {
    expect(committedPageForAnchor({ kind: "head" }, 50, "1453", 1)).toBe(1);
    expect(
      committedPageForAnchor({ kind: "after", cursor: "c" }, 50, "1453", 7),
    ).toBe(7);
    expect(
      committedPageForAnchor({ kind: "before", cursor: "c" }, 50, "1453", 4),
    ).toBe(4);
  });

  it("re-derives the tail page from the returned total", () => {
    // Cached 1,453 @ 100/page → page 15 was last; fresh 1,553 @
    // 100/page → page 16. Without the re-derivation, the UI would
    // keep labeling the rows as page 15.
    expect(committedPageForAnchor({ kind: "tail" }, 100, "1553", 15)).toBe(16);
  });

  it("keeps the tail page stable when the total hasn't crossed a boundary", () => {
    // 1,453 → 1,500 stays on page 15 @ 100/page.
    expect(committedPageForAnchor({ kind: "tail" }, 100, "1500", 15)).toBe(15);
  });

  it("falls back to the caller page when the total is unparseable", () => {
    expect(committedPageForAnchor({ kind: "tail" }, 50, null, 9)).toBe(9);
    expect(
      committedPageForAnchor({ kind: "tail" }, 50, "not a number", 9),
    ).toBe(9);
  });
});

describe("formatPageRange — locale-aware grouping", () => {
  it("produces inclusive 1-indexed bounds", () => {
    const range = formatPageRange("1453", 1, 50, "en-US");
    expect(range).toEqual({ start: "1", end: "50", total: "1,453" });
  });

  it("caps the end bound at the total on the partial final page", () => {
    const range = formatPageRange("1453", 30, 50, "en-US");
    // Page 30 @ 50/page → rows 1451–1500, but total=1453.
    expect(range).toEqual({ start: "1,451", end: "1,453", total: "1,453" });
  });

  it("returns 0–0 when the result set is empty", () => {
    const range = formatPageRange("0", 1, 50, "en-US");
    expect(range).toEqual({ start: "0", end: "0", total: "0" });
  });

  it("keeps BigInt precision past Number.MAX_SAFE_INTEGER", () => {
    // 2^53 + 5: if any intermediate cast fell through to Number,
    // the ones digit would round.
    const total = "9007199254740997";
    const range = formatPageRange(total, 1, 50, "en-US");
    expect(range?.total).toBe("9,007,199,254,740,997");
  });
});

describe("URL round-trip", () => {
  it("serializes page 1 with the default size as an empty URL", () => {
    const entries = paginationToSearchEntries({
      pageSize: DEFAULT_PAGE_SIZE,
      page: 1,
      anchor: { kind: "head" },
    });
    expect(entries).toEqual([]);
  });

  it("writes only pageSize when it diverges from the default", () => {
    const entries = paginationToSearchEntries({
      pageSize: 100,
      page: 1,
      anchor: { kind: "head" },
    });
    expect(entries).toEqual([[PAGINATION_PARAM_KEYS.pageSize, "100"]]);
  });

  it("encodes tail / after / before with their respective keys", () => {
    expect(
      paginationToSearchEntries({
        pageSize: DEFAULT_PAGE_SIZE,
        page: 12,
        anchor: { kind: "tail" },
      }),
    ).toEqual([
      [PAGINATION_PARAM_KEYS.last, "1"],
      [PAGINATION_PARAM_KEYS.page, "12"],
    ]);

    expect(
      paginationToSearchEntries({
        pageSize: DEFAULT_PAGE_SIZE,
        page: 3,
        anchor: { kind: "after", cursor: "c3" },
      }),
    ).toEqual([
      [PAGINATION_PARAM_KEYS.after, "c3"],
      [PAGINATION_PARAM_KEYS.page, "3"],
    ]);

    expect(
      paginationToSearchEntries({
        pageSize: DEFAULT_PAGE_SIZE,
        page: 7,
        anchor: { kind: "before", cursor: "c7" },
      }),
    ).toEqual([
      [PAGINATION_PARAM_KEYS.before, "c7"],
      [PAGINATION_PARAM_KEYS.page, "7"],
    ]);
  });

  it("parses a fresh URL as head @ default size @ page 1", () => {
    expect(parsePaginationSearchParams({})).toEqual({
      pageSize: DEFAULT_PAGE_SIZE,
      page: 1,
      anchor: { kind: "head" },
    });
  });

  it("parses `last=1` + page as a tail anchor", () => {
    expect(
      parsePaginationSearchParams({ last: "1", page: "42", pageSize: "100" }),
    ).toEqual({ pageSize: 100, page: 42, anchor: { kind: "tail" } });
  });

  it("prefers tail over after/before when multiple hints are set", () => {
    expect(
      parsePaginationSearchParams({
        last: "1",
        after: "ignored",
        before: "alsoignored",
      }).anchor,
    ).toEqual({ kind: "tail" });
  });

  it("parses an after cursor into an after anchor", () => {
    expect(parsePaginationSearchParams({ after: "abc", page: "5" })).toEqual({
      pageSize: DEFAULT_PAGE_SIZE,
      page: 5,
      anchor: { kind: "after", cursor: "abc" },
    });
  });

  it("parses a before cursor into a before anchor", () => {
    expect(parsePaginationSearchParams({ before: "xyz", page: "4" })).toEqual({
      pageSize: DEFAULT_PAGE_SIZE,
      page: 4,
      anchor: { kind: "before", cursor: "xyz" },
    });
  });

  it("coerces an off-menu pageSize above review's cap down to the cap", () => {
    // `?pageSize=999` (a stale or tampered URL) lands at the review
    // hard limit instead of silently collapsing to the default —
    // preserves the operator's "I want a large page" intent. (#405 J)
    expect(parsePaginationSearchParams({ pageSize: "999" }).pageSize).toBe(100);
  });

  it("round-trips non-default entries through URLSearchParams", () => {
    const state = {
      pageSize: 25 as const,
      page: 9,
      anchor: { kind: "after" as const, cursor: "cursor-42" },
    };
    const search = new URLSearchParams();
    for (const [k, v] of paginationToSearchEntries(state)) search.set(k, v);
    const parsed = parsePaginationSearchParams(
      Object.fromEntries(search.entries()),
    );
    expect(parsed).toEqual(state);
  });
});

describe("clearPaginationParams", () => {
  it("removes only pagination-owned keys", () => {
    const search = new URLSearchParams();
    search.set("source", "10.0.0.5");
    search.set(PAGINATION_PARAM_KEYS.pageSize, "100");
    search.set(PAGINATION_PARAM_KEYS.after, "cursor");
    search.set(PAGINATION_PARAM_KEYS.page, "7");
    search.set(PAGINATION_PARAM_KEYS.last, "1");
    search.set(PAGINATION_PARAM_KEYS.before, "cursor");

    clearPaginationParams(search);

    expect(search.get("source")).toBe("10.0.0.5");
    expect(search.get(PAGINATION_PARAM_KEYS.pageSize)).toBeNull();
    expect(search.get(PAGINATION_PARAM_KEYS.after)).toBeNull();
    expect(search.get(PAGINATION_PARAM_KEYS.before)).toBeNull();
    expect(search.get(PAGINATION_PARAM_KEYS.last)).toBeNull();
    expect(search.get(PAGINATION_PARAM_KEYS.page)).toBeNull();
  });
});

describe("parseGoToPageInput", () => {
  it("accepts plain positive integers", () => {
    expect(parseGoToPageInput("1")).toBe(1);
    expect(parseGoToPageInput("42")).toBe(42);
    expect(parseGoToPageInput("1000")).toBe(1000);
  });

  it("trims surrounding whitespace", () => {
    expect(parseGoToPageInput("  7  ")).toBe(7);
  });

  it("rejects scientific notation that `parseInt` would truncate", () => {
    // Reviewer Round 4 #2: `type=number` inputs accept `1e3`; the
    // previous `Number.parseInt("1e3", 10)` returned `1`, silently
    // sending the operator to page 1 instead of page 1,000.
    expect(parseGoToPageInput("1e3")).toBeNull();
    expect(parseGoToPageInput("1E3")).toBeNull();
    expect(parseGoToPageInput("2.5e2")).toBeNull();
  });

  it("rejects decimals, signed values, and non-numeric input", () => {
    expect(parseGoToPageInput("3.5")).toBeNull();
    expect(parseGoToPageInput("-1")).toBeNull();
    expect(parseGoToPageInput("+1")).toBeNull();
    expect(parseGoToPageInput("0x10")).toBeNull();
    expect(parseGoToPageInput("abc")).toBeNull();
  });

  it("rejects zero and empty / whitespace-only input", () => {
    expect(parseGoToPageInput("0")).toBeNull();
    expect(parseGoToPageInput("")).toBeNull();
    expect(parseGoToPageInput("   ")).toBeNull();
  });

  it("rejects integers that exceed `Number.MAX_SAFE_INTEGER`", () => {
    expect(parseGoToPageInput("9007199254740993")).toBeNull();
  });
});
