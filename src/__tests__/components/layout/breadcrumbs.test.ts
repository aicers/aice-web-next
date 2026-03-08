import { describe, expect, it } from "vitest";

import {
  NAV_SEGMENTS,
  parseBreadcrumbs,
  SETTINGS_SEGMENTS,
} from "@/lib/breadcrumbs";

// ── Helpers ────────────────────────────

/** A translate function that returns the key prefixed with its namespace. */
function mockTranslate(ns: "nav" | "settings", key: string): string {
  return `${ns}.${key}`;
}

// ── parseBreadcrumbs ────────────────────────────

describe("parseBreadcrumbs", () => {
  it("returns empty array for root path", () => {
    const result = parseBreadcrumbs("/", mockTranslate);
    expect(result).toEqual([]);
  });

  it("returns empty array for empty string", () => {
    const result = parseBreadcrumbs("", mockTranslate);
    expect(result).toEqual([]);
  });

  it("parses a single nav segment", () => {
    const result = parseBreadcrumbs("/dashboard", mockTranslate);
    expect(result).toEqual([{ label: "nav.dashboard", href: "/dashboard" }]);
  });

  it("parses nested settings path", () => {
    const result = parseBreadcrumbs("/settings/accounts", mockTranslate);
    expect(result).toEqual([
      { label: "nav.settings", href: "/settings" },
      { label: "settings.accounts", href: "/settings/accounts" },
    ]);
  });

  it("capitalises unknown segments", () => {
    const result = parseBreadcrumbs("/settings/unknown-page", mockTranslate);
    expect(result).toEqual([
      { label: "nav.settings", href: "/settings" },
      { label: "Unknown-page", href: "/settings/unknown-page" },
    ]);
  });

  it("uses translate fallback when translate returns null", () => {
    const nullTranslate = () => null;
    const result = parseBreadcrumbs("/dashboard", nullTranslate);
    expect(result).toEqual([{ label: "Dashboard", href: "/dashboard" }]);
  });

  it("builds cumulative href paths", () => {
    const result = parseBreadcrumbs("/settings/roles/detail", mockTranslate);
    expect(result).toHaveLength(3);
    expect(result[0].href).toBe("/settings");
    expect(result[1].href).toBe("/settings/roles");
    expect(result[2].href).toBe("/settings/roles/detail");
  });

  it("handles all three settings sub-segments", () => {
    for (const segment of ["accounts", "roles", "profile"]) {
      const result = parseBreadcrumbs(`/settings/${segment}`, mockTranslate);
      expect(result[1].label).toBe(`settings.${segment}`);
    }
  });
});

// ── Segment sets ────────────────────────────

describe("NAV_SEGMENTS", () => {
  it("contains all expected navigation keys", () => {
    const expected = [
      "home",
      "dashboard",
      "event",
      "detection",
      "triage",
      "report",
      "audit-logs",
      "settings",
    ];
    for (const key of expected) {
      expect(NAV_SEGMENTS.has(key)).toBe(true);
    }
    expect(NAV_SEGMENTS.size).toBe(expected.length);
  });
});

describe("SETTINGS_SEGMENTS", () => {
  it("contains all expected settings keys", () => {
    const expected = ["accounts", "roles", "profile", "customers"];
    for (const key of expected) {
      expect(SETTINGS_SEGMENTS.has(key)).toBe(true);
    }
    expect(SETTINGS_SEGMENTS.size).toBe(expected.length);
  });
});
