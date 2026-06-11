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

  it("handles all settings sub-segments", () => {
    for (const segment of [
      "accounts",
      "roles",
      "profile",
      "customers",
      "policies",
    ]) {
      const result = parseBreadcrumbs(`/settings/${segment}`, mockTranslate);
      expect(result[1].label).toBe(`settings.${segment}`);
    }
  });

  it("maps account-status segment to accountStatus i18n key", () => {
    const result = parseBreadcrumbs("/settings/account-status", mockTranslate);
    expect(result[1].label).toBe("settings.accountStatus");
    expect(result[1].href).toBe("/settings/account-status");
  });

  // ── Dynamic detail children ──────────────

  it("labels the event detail child with the static fallback", () => {
    const result = parseBreadcrumbs(
      "/detection/events/EyJpZCI6IjEyMyJ9",
      mockTranslate,
    );
    expect(result).toEqual([
      { label: "nav.detection", href: "/detection" },
      { label: "nav.events", href: "/detection/events" },
      {
        label: "nav.eventDetail",
        href: "/detection/events/EyJpZCI6IjEyMyJ9",
      },
    ]);
  });

  it("labels the node detail child with the static fallback", () => {
    const result = parseBreadcrumbs("/nodes/12345", mockTranslate);
    expect(result).toEqual([
      { label: "nav.nodes", href: "/nodes" },
      { label: "nav.nodeDetail", href: "/nodes/12345" },
    ]);
  });

  it("uses the override for the last dynamic-child segment", () => {
    const result = parseBreadcrumbs(
      "/detection/events/EyJpZCI6IjEyMyJ9",
      mockTranslate,
      "06-11 14:23 · HTTP Threat",
    );
    expect(result[2]).toEqual({
      label: "06-11 14:23 · HTTP Threat",
      href: "/detection/events/EyJpZCI6IjEyMyJ9",
    });
  });

  it("uses the override for the node detail child", () => {
    const result = parseBreadcrumbs("/nodes/12345", mockTranslate, "Edge-01");
    expect(result[1]).toEqual({ label: "Edge-01", href: "/nodes/12345" });
  });

  it("never exposes the raw opaque segment for dynamic children", () => {
    const token = "EyJpZCI6IjEyMyJ9";
    const fallback = parseBreadcrumbs(`/nodes/${token}`, mockTranslate);
    expect(fallback[1].label).not.toBe(token);
    expect(fallback[1].label).toBe("nav.nodeDetail");
  });

  it("ignores the override when the parent is not a detail route", () => {
    // `/settings/roles/detail` — `detail`'s parent is `roles`, not a
    // dynamic-detail route, so the override does not apply and the
    // capitalised fallback stands.
    const result = parseBreadcrumbs(
      "/settings/roles/detail",
      mockTranslate,
      "Should be ignored",
    );
    expect(result[2].label).toBe("Detail");
  });

  it("does not treat the singular event route as a detail parent", () => {
    // `/event/something` — `event` is the static Event-browsing route,
    // not a detail route, so its child falls back to the capitalised
    // segment rather than a static detail label.
    const result = parseBreadcrumbs("/event/something", mockTranslate);
    expect(result).toEqual([
      { label: "nav.event", href: "/event" },
      { label: "Something", href: "/event/something" },
    ]);
  });
});

// ── Segment sets ────────────────────────────

describe("NAV_SEGMENTS", () => {
  it("contains all expected navigation keys", () => {
    const expected = [
      "home",
      "dashboard",
      "event",
      "events",
      "detection",
      "triage",
      "report",
      "nodes",
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
    const expected = [
      "accounts",
      "roles",
      "profile",
      "customers",
      "policies",
      "account-status",
    ];
    for (const key of expected) {
      expect(SETTINGS_SEGMENTS.has(key)).toBe(true);
    }
    expect(SETTINGS_SEGMENTS.size).toBe(expected.length);
  });
});
