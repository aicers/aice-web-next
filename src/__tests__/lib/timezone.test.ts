import { describe, expect, it } from "vitest";

import { getTimezones, isValidTimezone } from "@/lib/timezone";

describe("isValidTimezone", () => {
  it("returns true for valid IANA timezone", () => {
    expect(isValidTimezone("America/New_York")).toBe(true);
    expect(isValidTimezone("Asia/Seoul")).toBe(true);
    expect(isValidTimezone("Europe/Paris")).toBe(true);
    expect(isValidTimezone("Europe/London")).toBe(true);
  });

  it("returns false for invalid timezone", () => {
    expect(isValidTimezone("Invalid/Zone")).toBe(false);
    expect(isValidTimezone("")).toBe(false);
    expect(isValidTimezone("Not_A_Timezone")).toBe(false);
  });
});

describe("getTimezones", () => {
  it("returns a non-empty array of timezone strings", () => {
    const tzs = getTimezones();
    expect(tzs.length).toBeGreaterThan(0);
    expect(tzs).toContain("America/New_York");
    expect(tzs).toContain("Asia/Seoul");
  });
});
