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
  msUntilNextDayInTimezone,
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

describe("msUntilNextDayInTimezone", () => {
  const HOUR = 60 * 60 * 1000;
  const MINUTE = 60 * 1000;

  it("measures time to midnight in the target zone, not UTC", () => {
    // 22:00 UTC is 23:00 in Berlin (UTC+1, CET) and 17:00 in New York
    // (UTC-5, EST in January).
    const instant = new Date("2026-01-15T22:00:00Z");
    expect(msUntilNextDayInTimezone("Europe/Berlin", instant)).toBe(1 * HOUR);
    expect(msUntilNextDayInTimezone("America/New_York", instant)).toBe(
      7 * HOUR,
    );
    expect(msUntilNextDayInTimezone("UTC", instant)).toBe(2 * HOUR);
  });

  it("counts down toward the next local midnight as the day advances", () => {
    expect(
      msUntilNextDayInTimezone("UTC", new Date("2026-05-30T23:30:00Z")),
    ).toBe(30 * MINUTE);
    expect(
      msUntilNextDayInTimezone("UTC", new Date("2026-05-30T23:59:30Z")),
    ).toBe(30 * 1000);
  });

  it("returns a full day just after midnight and never a non-positive value", () => {
    expect(
      msUntilNextDayInTimezone("UTC", new Date("2026-05-30T00:00:00Z")),
    ).toBe(24 * HOUR);
    expect(
      msUntilNextDayInTimezone("UTC", new Date("2026-05-30T00:00:01Z")),
    ).toBeGreaterThan(0);
  });

  it("accounts for a 23-hour spring-forward day", () => {
    // Europe/Berlin springs forward 02:00→03:00 local on 2026-03-29, so
    // that calendar day is only 23 h long. At 00:30 local (the instant
    // below, 23:30Z on the 28th in CET) the next local midnight is the
    // start of 2026-03-30, which is 22.5 *real* hours away — not the 23.5
    // a fixed 24-hour subtraction would report.
    const instant = new Date("2026-03-28T23:30:00Z");
    expect(msUntilNextDayInTimezone("Europe/Berlin", instant)).toBe(
      22.5 * HOUR,
    );
  });

  it("accounts for a 25-hour fall-back day", () => {
    // Europe/Berlin falls back 03:00→02:00 local on 2026-10-25, so that
    // day is 25 h long. At 00:30 local (22:30Z on the 24th in CEST) the
    // next local midnight is 24.5 real hours away.
    const instant = new Date("2026-10-24T22:30:00Z");
    expect(msUntilNextDayInTimezone("Europe/Berlin", instant)).toBe(
      24.5 * HOUR,
    );
  });
});
