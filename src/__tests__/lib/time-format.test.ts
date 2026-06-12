import { describe, expect, it } from "vitest";

import {
  CURATED_TIME_FORMAT_LOCALES,
  isValidHourCycle,
  isValidTimeFormatLocale,
  resolveTimeFormat,
  type StoredTimeFormat,
  TIME_FORMAT_LOCALE_APP,
} from "@/lib/time-format";

describe("isValidTimeFormatLocale", () => {
  it("accepts the 'app' sentinel", () => {
    expect(isValidTimeFormatLocale(TIME_FORMAT_LOCALE_APP)).toBe(true);
  });

  it("accepts every curated tag", () => {
    for (const tag of CURATED_TIME_FORMAT_LOCALES) {
      expect(isValidTimeFormatLocale(tag)).toBe(true);
    }
  });

  it("rejects tags outside the curated list", () => {
    expect(isValidTimeFormatLocale("xx-YY")).toBe(false);
    expect(isValidTimeFormatLocale("en")).toBe(false); // bare language
    expect(isValidTimeFormatLocale("")).toBe(false);
  });

  it("exposes exactly the 18 curated tags", () => {
    expect(CURATED_TIME_FORMAT_LOCALES).toHaveLength(18);
  });
});

describe("isValidHourCycle", () => {
  it("accepts h12 and h23", () => {
    expect(isValidHourCycle("h12")).toBe(true);
    expect(isValidHourCycle("h23")).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isValidHourCycle("h11")).toBe(false);
    expect(isValidHourCycle("h24")).toBe(false);
    expect(isValidHourCycle("auto")).toBe(false);
    expect(isValidHourCycle("")).toBe(false);
  });
});

describe("resolveTimeFormat", () => {
  const allNull: StoredTimeFormat = {
    timeFormatLocale: null,
    timeFormatHourCycle: null,
    timeFormatSeconds: null,
    timeFormatTzLabel: null,
  };

  it("resolves the all-NULL default to the today-equivalent object", () => {
    expect(resolveTimeFormat(allNull, "en")).toEqual({
      locale: undefined,
      hourCycle: undefined,
      seconds: true,
      tzLabel: false,
    });
  });

  it("treats null / undefined stored input as the default", () => {
    expect(resolveTimeFormat(null, "en")).toEqual(
      resolveTimeFormat(allNull, "en"),
    );
    expect(resolveTimeFormat(undefined, "en")).toEqual(
      resolveTimeFormat(allNull, "en"),
    );
  });

  it("maps the 'app' sentinel to the active app locale", () => {
    expect(
      resolveTimeFormat({ ...allNull, timeFormatLocale: "app" }, "ko").locale,
    ).toBe("ko");
  });

  it("passes an explicit curated tag through as the locale", () => {
    expect(
      resolveTimeFormat({ ...allNull, timeFormatLocale: "fr-CA" }, "en").locale,
    ).toBe("fr-CA");
  });

  it("threads hour cycle, seconds, and tz label", () => {
    expect(
      resolveTimeFormat(
        {
          timeFormatLocale: null,
          timeFormatHourCycle: "h23",
          timeFormatSeconds: false,
          timeFormatTzLabel: true,
        },
        "en",
      ),
    ).toEqual({
      locale: undefined,
      hourCycle: "h23",
      seconds: false,
      tzLabel: true,
    });
  });
});
