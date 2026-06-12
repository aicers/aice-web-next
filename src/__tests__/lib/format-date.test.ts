import { describe, expect, it } from "vitest";

import {
  formatDateTime,
  formatDateTimeCompact,
  formatEventTime,
  type ResolvedTimeFormat,
} from "@/lib/format-date";

/** Build a resolved time-format object, defaulting to the app default. */
function resolved(
  overrides: Partial<ResolvedTimeFormat> = {},
): ResolvedTimeFormat {
  return {
    locale: undefined,
    hourCycle: undefined,
    seconds: true,
    tzLabel: false,
    ...overrides,
  };
}

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

// ── #766: time-display-format options ─────────────────────────────

describe("formatDateTime — time-format options", () => {
  const iso = "2024-06-15T15:30:45Z";

  it("is byte-identical to the no-options call for the default object", () => {
    expect(formatDateTime(iso, "UTC", resolved())).toBe(
      formatDateTime(iso, "UTC"),
    );
    expect(formatDateTime(iso, "Asia/Seoul", resolved())).toBe(
      formatDateTime(iso, "Asia/Seoul"),
    );
  });

  it("honours the hour-cycle option (h12 vs h23)", () => {
    // Pin en-US so the AM/PM wording is deterministic regardless of the
    // runtime default locale.
    const h23 = formatDateTime(
      iso,
      "UTC",
      resolved({ locale: "en-US", hourCycle: "h23" }),
    );
    const h12 = formatDateTime(
      iso,
      "UTC",
      resolved({ locale: "en-US", hourCycle: "h12" }),
    );
    // 15:30 UTC → 15 in 24-hour, 3 + PM in 12-hour.
    expect(h23).toMatch(/15/);
    expect(h23).not.toMatch(/AM|PM/i);
    expect(h12).toMatch(/3/);
    expect(h12).toMatch(/PM/i);
  });

  it("hides seconds when the seconds option is false", () => {
    const withSeconds = formatDateTime(iso, "UTC", resolved({ seconds: true }));
    const noSeconds = formatDateTime(iso, "UTC", resolved({ seconds: false }));
    expect(withSeconds).toContain("45");
    expect(noSeconds).not.toContain("45");
  });

  it("adds a GMT offset label when tzLabel is true", () => {
    const withLabel = formatDateTime(
      iso,
      "Asia/Seoul",
      resolved({ tzLabel: true }),
    );
    const noLabel = formatDateTime(iso, "Asia/Seoul", resolved());
    // shortOffset pins the offset form (GMT+9), never KST.
    expect(withLabel).toContain("GMT+9");
    expect(withLabel).not.toContain("KST");
    expect(noLabel).not.toContain("GMT");
  });

  it("applies the locale override", () => {
    const en = formatDateTime(iso, "UTC", resolved({ locale: "en-US" }));
    const ko = formatDateTime(iso, "UTC", resolved({ locale: "ko-KR" }));
    expect(en).not.toBe(ko);
    expect(en).toMatch(/AM|PM/i);
    expect(ko).not.toMatch(/AM|PM/i);
  });
});

describe("formatDateTimeCompact — time-format options", () => {
  const iso = "2024-06-15T15:30:45Z";

  it("ignores the seconds and tzLabel options (compact invariance)", () => {
    const base = formatDateTimeCompact(iso, "Asia/Seoul", "en", resolved());
    const fiddled = formatDateTimeCompact(
      iso,
      "Asia/Seoul",
      "en",
      resolved({ seconds: false, tzLabel: true }),
    );
    expect(fiddled).toBe(base);
    // Seconds and tz label never appear in the compact form.
    expect(fiddled).not.toContain("45");
    expect(fiddled).not.toContain("GMT");
  });

  it("honours the hour-cycle option", () => {
    const h23 = formatDateTimeCompact(
      iso,
      "UTC",
      "en",
      resolved({ hourCycle: "h23" }),
    );
    const h12 = formatDateTimeCompact(
      iso,
      "UTC",
      "en",
      resolved({ hourCycle: "h12" }),
    );
    expect(h23).toMatch(/15/);
    expect(h23).not.toMatch(/AM|PM/i);
    expect(h12).toMatch(/PM/i);
  });

  it("the locale override takes precedence over the locale argument", () => {
    const overridden = formatDateTimeCompact(
      iso,
      "UTC",
      "en",
      resolved({ locale: "ko-KR" }),
    );
    const plainKo = formatDateTimeCompact(iso, "UTC", "ko-KR");
    expect(overridden).toBe(plainKo);
  });
});

describe("formatEventTime — time-format options", () => {
  const iso = "2024-06-15T15:30:45Z";
  const FALLBACK = "—";

  it("is byte-identical to the no-options call for the default object", () => {
    expect(formatEventTime(iso, "en", FALLBACK, "UTC", resolved())).toBe(
      formatEventTime(iso, "en", FALLBACK, "UTC"),
    );
  });

  it("hides seconds when the seconds option is false", () => {
    const withSeconds = formatEventTime(iso, "en", FALLBACK, "UTC", resolved());
    const noSeconds = formatEventTime(
      iso,
      "en",
      FALLBACK,
      "UTC",
      resolved({ seconds: false }),
    );
    expect(withSeconds).toContain("45");
    expect(noSeconds).not.toContain("45");
  });

  it("adds the GMT offset label when tzLabel is true", () => {
    const withLabel = formatEventTime(
      iso,
      "en",
      FALLBACK,
      "Asia/Seoul",
      resolved({ tzLabel: true }),
    );
    expect(withLabel).toContain("GMT+9");
  });

  it("the locale override takes precedence over the locale argument", () => {
    const overridden = formatEventTime(
      iso,
      "en",
      FALLBACK,
      "UTC",
      resolved({ locale: "ko-KR" }),
    );
    expect(overridden).not.toMatch(/AM|PM/i);
  });

  it("returns the fallback for an unparseable instant", () => {
    expect(
      formatEventTime("not-a-date", "en", FALLBACK, "UTC", resolved()),
    ).toBe(FALLBACK);
  });
});
