import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("i18n routing", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.DEFAULT_LOCALE;
    vi.restoreAllMocks();
  });

  it("exports supported locales", async () => {
    const { routing } = await import("@/i18n/routing");

    expect(routing.locales).toEqual(["en", "ko"]);
  });

  it("defaults to en when DEFAULT_LOCALE is not set", async () => {
    delete process.env.DEFAULT_LOCALE;

    const { routing } = await import("@/i18n/routing");

    expect(routing.defaultLocale).toBe("en");
  });

  it("uses DEFAULT_LOCALE env var when set", async () => {
    process.env.DEFAULT_LOCALE = "ko";

    const { routing } = await import("@/i18n/routing");

    expect(routing.defaultLocale).toBe("ko");
  });

  it("uses as-needed locale prefix strategy", async () => {
    const { routing } = await import("@/i18n/routing");

    expect(routing.localePrefix).toBe("as-needed");
  });
});
