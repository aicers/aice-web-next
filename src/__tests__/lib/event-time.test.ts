import { describe, expect, it, vi } from "vitest";

import { formatEventTime } from "@/lib/format-date";

const ISO = "2026-04-22T15:30:45.000Z";
const FALLBACK = "—";

describe("formatEventTime", () => {
  it("returns the fallback for an unparseable input", () => {
    expect(formatEventTime("not-a-date", "en-US", FALLBACK)).toBe(FALLBACK);
  });

  it("does not force a 24-hour cycle on `en-US`, so the default AM/PM output is preserved", () => {
    // `en-US` defaults to a 12-hour clock with AM/PM; the formatter
    // must not hard-code `hour12: false` or US operators see a
    // non-local time representation.
    const out = formatEventTime(ISO, "en-US", FALLBACK);
    expect(out).toMatch(/AM|PM/i);
    expect(out).not.toMatch(/15:30/);
  });

  it("respects a locale that defaults to 24-hour output", () => {
    // `en-GB` defaults to 24-hour without AM/PM — still locale-driven,
    // not the forced `hour12: false` that Round 13 flagged.
    const out = formatEventTime(ISO, "en-GB", FALLBACK);
    expect(out).not.toMatch(/AM|PM/i);
  });

  it("does not override the locale's hour-cycle preference", () => {
    const spy = vi.spyOn(Intl, "DateTimeFormat");
    try {
      formatEventTime(ISO, "en-US", FALLBACK);
      const options = spy.mock.calls[0]?.[1];
      expect(options).toBeDefined();
      expect(options).not.toHaveProperty("hour12");
      expect(options).not.toHaveProperty("hourCycle");
    } finally {
      spy.mockRestore();
    }
  });

  it("renders the time in the supplied timezone", () => {
    // 15:30:45 UTC is 00:30:45 the next day in Asia/Seoul (UTC+9).
    const out = formatEventTime(ISO, "en-GB", FALLBACK, "Asia/Seoul");
    expect(out).toMatch(/00:30:45/);
    expect(out).toMatch(/23\/04\/2026/);
  });

  it("renders the same instant differently across timezones", () => {
    const seoul = formatEventTime(ISO, "en-GB", FALLBACK, "Asia/Seoul");
    const utc = formatEventTime(ISO, "en-GB", FALLBACK, "UTC");
    expect(utc).toMatch(/15:30:45/);
    expect(seoul).not.toBe(utc);
  });

  it("treats a nullish timezone as the runtime default", () => {
    const spy = vi.spyOn(Intl, "DateTimeFormat");
    try {
      formatEventTime(ISO, "en-US", FALLBACK, null);
      const options = spy.mock.calls[0]?.[1] as { timeZone?: string };
      expect(options?.timeZone).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });
});
