import { describe, expect, it } from "vitest";

import {
  coercePageSize,
  DEFAULT_PAGE_SIZE,
  GIGANTO_MAX_PAGE_SIZE,
  pageArgsForAnchor,
  paginationToSearchEntries,
  parsePaginationSearchParams,
} from "@/lib/event/pagination";

describe("pageArgsForAnchor", () => {
  it("maps head to first only", () => {
    expect(pageArgsForAnchor({ kind: "head" }, 50)).toEqual({ first: 50 });
  });

  it("maps after to first + after", () => {
    expect(pageArgsForAnchor({ kind: "after", cursor: "c" }, 25)).toEqual({
      first: 25,
      after: "c",
    });
  });

  it("maps before to last + before", () => {
    expect(pageArgsForAnchor({ kind: "before", cursor: "c" }, 100)).toEqual({
      last: 100,
      before: "c",
    });
  });
});

describe("coercePageSize", () => {
  it("passes through supported sizes", () => {
    expect(coercePageSize(25)).toBe(25);
    expect(coercePageSize(100)).toBe(100);
  });

  it("clamps oversized values down to the Giganto max", () => {
    expect(coercePageSize(500)).toBe(GIGANTO_MAX_PAGE_SIZE);
  });

  it("falls back to the default for unsupported values", () => {
    expect(coercePageSize(undefined)).toBe(DEFAULT_PAGE_SIZE);
    expect(coercePageSize(10)).toBe(DEFAULT_PAGE_SIZE);
    expect(coercePageSize(-1)).toBe(DEFAULT_PAGE_SIZE);
  });
});

describe("parsePaginationSearchParams", () => {
  it("defaults to head at the default page size", () => {
    expect(parsePaginationSearchParams({})).toEqual({
      pageSize: DEFAULT_PAGE_SIZE,
      anchor: { kind: "head" },
    });
  });

  it("decodes an after cursor and page size", () => {
    expect(
      parsePaginationSearchParams({ after: "abc", pageSize: "100" }),
    ).toEqual({ pageSize: 100, anchor: { kind: "after", cursor: "abc" } });
  });

  it("decodes a before cursor", () => {
    expect(parsePaginationSearchParams({ before: "xyz" })).toEqual({
      pageSize: DEFAULT_PAGE_SIZE,
      anchor: { kind: "before", cursor: "xyz" },
    });
  });

  it("prefers after when both cursors are present", () => {
    expect(
      parsePaginationSearchParams({ after: "a", before: "b" }).anchor,
    ).toEqual({ kind: "after", cursor: "a" });
  });
});

describe("paginationToSearchEntries", () => {
  it("omits the default page size and head anchor", () => {
    expect(
      paginationToSearchEntries(DEFAULT_PAGE_SIZE, { kind: "head" }),
    ).toEqual([]);
  });

  it("writes a non-default page size and the after cursor", () => {
    expect(
      paginationToSearchEntries(100, { kind: "after", cursor: "c" }),
    ).toEqual([
      ["pageSize", "100"],
      ["after", "c"],
    ]);
  });

  it("writes only the before cursor for a backward step", () => {
    expect(
      paginationToSearchEntries(DEFAULT_PAGE_SIZE, {
        kind: "before",
        cursor: "c",
      }),
    ).toEqual([["before", "c"]]);
  });
});
