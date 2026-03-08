import { describe, expect, it } from "vitest";

import { formatDateTime } from "@/lib/format-date";

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
