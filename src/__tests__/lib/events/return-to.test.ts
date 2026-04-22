import { describe, expect, it } from "vitest";

import { sanitizeReturnTo } from "@/lib/events/return-to";

describe("sanitizeReturnTo", () => {
  it("defaults to /detection when no value is supplied", () => {
    expect(sanitizeReturnTo(undefined)).toBe("/detection");
  });

  it("accepts same-origin relative paths", () => {
    expect(sanitizeReturnTo("/detection?source=10.0.0.5")).toBe(
      "/detection?source=10.0.0.5",
    );
    expect(sanitizeReturnTo("/triage/queue")).toBe("/triage/queue");
  });

  it("rejects protocol-relative values", () => {
    expect(sanitizeReturnTo("//evil.tld/phish")).toBe("/detection");
  });

  it("rejects backslash-prefixed values", () => {
    expect(sanitizeReturnTo("/\\evil")).toBe("/detection");
  });

  it("rejects absolute URLs and bare fragments", () => {
    expect(sanitizeReturnTo("https://example.com/")).toBe("/detection");
    expect(sanitizeReturnTo("fragment-only")).toBe("/detection");
  });

  it("rejects values exceeding the length cap", () => {
    const longPath = `/${"a".repeat(3000)}`;
    expect(sanitizeReturnTo(longPath)).toBe("/detection");
  });

  it("rejects string arrays passed by Next.js duplicates", () => {
    expect(sanitizeReturnTo(["/detection", "/detection"])).toBe("/detection");
  });
});
