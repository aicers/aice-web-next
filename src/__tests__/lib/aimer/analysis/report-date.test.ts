/**
 * Tests for `src/lib/aimer/analysis/report-date.ts` — the strict,
 * timezone-free calendar guard the DAILY report route uses to reject a
 * malformed `{date}` before any upstream call (#646), plus the
 * timezone-aware "today" derivation the DAILY card uses.
 */

import { describe, expect, it } from "vitest";

import {
  isValidReportDate,
  LIVE_BUCKET_DATE,
  todayInTimezone,
} from "@/lib/aimer/analysis/report-date";

describe("isValidReportDate", () => {
  it.each([
    "2026-05-30",
    "1970-01-01",
    "2024-02-29", // leap year
    "2000-02-29", // century leap year (÷400)
    "2026-12-31",
    "2026-01-01",
  ])("accepts the calendar-valid date %s", (value) => {
    expect(isValidReportDate(value)).toBe(true);
  });

  it.each([
    ["February 30 never exists", "2026-02-30"],
    ["February 29 in a non-leap year", "2026-02-29"],
    ["1900 is not a leap year (÷100, not ÷400)", "1900-02-29"],
    ["April has 30 days", "2026-04-31"],
    ["month 00", "2026-00-10"],
    ["month 13", "2026-13-01"],
    ["day 00", "2026-05-00"],
    ["day 32", "2026-05-32"],
  ])("rejects %s (%s)", (_label, value) => {
    expect(isValidReportDate(value)).toBe(false);
  });

  it.each([
    ["non-zero-padded month", "2026-5-30"],
    ["non-zero-padded day", "2026-05-3"],
    ["two-digit year", "26-05-30"],
    ["slash separators", "2026/05/30"],
    ["trailing time", "2026-05-30T00:00:00Z"],
    ["empty string", ""],
    ["garbage", "not-a-date"],
  ])("rejects the malformed format %s (%s)", (_label, value) => {
    expect(isValidReportDate(value)).toBe(false);
  });

  it.each([
    undefined,
    null,
    20260530,
    {},
    [],
  ])("rejects the non-string %s", (value) => {
    expect(isValidReportDate(value)).toBe(false);
  });
});

describe("LIVE_BUCKET_DATE", () => {
  it("is the Unix epoch sentinel and is itself calendar-valid", () => {
    expect(LIVE_BUCKET_DATE).toBe("1970-01-01");
    expect(isValidReportDate(LIVE_BUCKET_DATE)).toBe(true);
  });
});

describe("todayInTimezone", () => {
  it("derives the local calendar day, not the UTC day", () => {
    // 2026-05-30T22:00:00Z is already 2026-05-31 in Seoul (UTC+9) but
    // still 2026-05-30 in New York (UTC-4).
    const instant = new Date("2026-05-30T22:00:00Z");
    expect(todayInTimezone("Asia/Seoul", instant)).toBe("2026-05-31");
    expect(todayInTimezone("America/New_York", instant)).toBe("2026-05-30");
    expect(todayInTimezone("UTC", instant)).toBe("2026-05-30");
  });

  it("returns a value that passes the calendar guard", () => {
    const instant = new Date("2026-02-28T15:00:00Z");
    const today = todayInTimezone("UTC", instant);
    expect(today).toBe("2026-02-28");
    expect(isValidReportDate(today)).toBe(true);
  });
});
