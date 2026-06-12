import { describe, expect, it } from "vitest";

import type { ResolvedTimeFormat } from "@/lib/format-date";
import { CURATED_TIME_FORMAT_LOCALES } from "@/lib/time-format";
import { reservedTimestampCh } from "@/lib/timestamp-width";

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

/** Same visual-width budget the reservation is sized against. */
function visualWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    width += /[ᄀ-ᇿ⺀-鿿가-힯＀-￯]/.test(ch) ? 2 : 1;
  }
  return width;
}

const WORST = new Date("2026-12-30T23:59:59Z");

describe("reservedTimestampCh", () => {
  it("covers the worst-case general value across the curated list (follow-browser)", () => {
    const reserved = reservedTimestampCh(resolved(), false);
    for (const locale of CURATED_TIME_FORMAT_LOCALES) {
      const width = visualWidth(
        WORST.toLocaleString(locale, {
          timeZone: "UTC",
          year: "numeric",
          month: "numeric",
          day: "numeric",
          hour: "numeric",
          minute: "numeric",
          second: "numeric",
        }),
      );
      expect(reserved).toBeGreaterThanOrEqual(width);
    }
  });

  it("widens when seconds + tz label + 24-hour are added", () => {
    const base = reservedTimestampCh(resolved(), false);
    const widest = reservedTimestampCh(
      resolved({ hourCycle: "h23", seconds: true, tzLabel: true }),
      false,
    );
    expect(widest).toBeGreaterThan(base);
  });

  it("does not reserve seconds / tz-label width for the compact variant", () => {
    const compactPlain = reservedTimestampCh(resolved(), true);
    const compactFiddled = reservedTimestampCh(
      resolved({ seconds: false, tzLabel: true }),
      true,
    );
    // Compact folds seconds and tz label out of its sizing, so the two
    // are identical and narrower than the general reservation.
    expect(compactFiddled).toBe(compactPlain);
    expect(compactPlain).toBeLessThan(reservedTimestampCh(resolved(), false));
  });

  it("sizes to a single locale when the formatting locale is explicit", () => {
    const single = reservedTimestampCh(resolved({ locale: "en-US" }), false);
    const sweep = reservedTimestampCh(resolved(), false);
    // The curated-list sweep is at least as wide as any single member.
    expect(sweep).toBeGreaterThanOrEqual(single);
  });
});
