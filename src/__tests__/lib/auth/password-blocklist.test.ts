import { describe, expect, it } from "vitest";

import { isBlocklisted } from "@/lib/auth/password-blocklist";

describe("password-blocklist", () => {
  it("returns true for a known common password", () => {
    expect(isBlocklisted("password")).toBe(true);
    expect(isBlocklisted("123456")).toBe(true);
    expect(isBlocklisted("qwerty")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isBlocklisted("PASSWORD")).toBe(true);
    expect(isBlocklisted("Password")).toBe(true);
    expect(isBlocklisted("QWERTY")).toBe(true);
  });

  it("returns false for a non-blocklisted password", () => {
    expect(isBlocklisted("xK9#mQ2$vL7@nB4")).toBe(false);
    expect(isBlocklisted("correcthorsebatterystaple2024!")).toBe(false);
  });
});
