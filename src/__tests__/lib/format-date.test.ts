import { describe, expect, it } from "vitest";

import { formatDateTime, formatDateTimeCompact } from "@/lib/format-date";

describe("formatDateTime", () => {
  // Use a fixed UTC date to avoid locale-dependent output
  const isoString = "2024-06-15T12:30:45Z";
  const dateObj = new Date(isoString);

  it("formats an ISO string", () => {
    const result = formatDateTime(isoString, "UTC");
    expect(result).toContain("2024");
    expect(result).toContain("30");
    expect(result).toContain("45");
  });

  it("formats a Date object", () => {
    const result = formatDateTime(dateObj, "UTC");
    expect(result).toContain("2024");
    expect(result).toContain("30");
  });

  it("applies the given timezone", () => {
    // UTC 12:30 → Asia/Seoul is UTC+9, so 9:30 PM (or 21:30)
    const seoul = formatDateTime(isoString, "Asia/Seoul");
    expect(seoul).toContain("9");
    expect(seoul).toContain("30");
    // Verify it's not the UTC hour (12)
    expect(seoul).not.toMatch(/\b12:/);

    // UTC 12:30 → America/New_York is UTC-4 (EDT), so 8:30 AM
    const ny = formatDateTime(isoString, "America/New_York");
    expect(ny).toContain("8");
    expect(ny).toContain("30");
  });

  it("falls back to runtime default when timezone is null", () => {
    const result = formatDateTime(isoString, null);
    // Should not throw and should return a non-empty string
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("falls back to runtime default when timezone is undefined", () => {
    const result = formatDateTime(isoString);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("includes year, month, day, hour, minute, second", () => {
    const result = formatDateTime(isoString, "UTC");
    // 2024-06-15 12:30:45 UTC — check all components are present
    expect(result).toMatch(/2024/);
    expect(result).toMatch(/6|06/); // month
    expect(result).toMatch(/15/); // day
    expect(result).toMatch(/12/); // hour
    expect(result).toMatch(/30/); // minute
    expect(result).toMatch(/45/); // second
  });
});

describe("formatDateTimeCompact", () => {
  // 2024-06-15 12:30:45 UTC
  const isoString = "2024-06-15T12:30:45Z";

  it("drops the year and the seconds", () => {
    const result = formatDateTimeCompact(isoString, "UTC", "en");
    // Month, day, hour, and minute remain.
    expect(result).toMatch(/15/); // day
    expect(result).toMatch(/30/); // minute
    // The year and seconds must be gone.
    expect(result).not.toContain("2024");
    expect(result).not.toContain("45");
  });

  it("applies the given timezone", () => {
    // UTC 12:30 → Asia/Seoul (UTC+9) is 21:30; the UTC hour 12 must
    // not appear as a standalone hour.
    const seoul = formatDateTimeCompact(isoString, "Asia/Seoul", "en");
    expect(seoul).toContain("30"); // minute survives the shift
    expect(seoul).not.toMatch(/\b12:/);

    // UTC 12:30 → America/New_York (UTC-4, EDT) is 08:30.
    const ny = formatDateTimeCompact(isoString, "America/New_York", "en");
    expect(ny).toContain("8");
    expect(ny).toContain("30");
  });

  it("threads the explicit locale through Intl", () => {
    // The Korean locale renders 24-hour-ish output without an AM/PM
    // marker, while English includes one. Asserting the marker differs
    // proves the explicit `locale` argument reaches `toLocaleString`
    // rather than pinning locale-specific separators.
    const en = formatDateTimeCompact(isoString, "UTC", "en");
    const ko = formatDateTimeCompact(isoString, "UTC", "ko");
    expect(en).not.toBe(ko);
    expect(en).toMatch(/AM|PM/i);
    expect(ko).not.toMatch(/AM|PM/i);
  });

  it("returns a non-empty string when timezone/locale are absent", () => {
    const result = formatDateTimeCompact(isoString);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("formats a Date object", () => {
    const result = formatDateTimeCompact(new Date(isoString), "UTC", "en");
    expect(result).toMatch(/15/);
    expect(result).toMatch(/30/);
  });
});
