import { describe, expect, it } from "vitest";

import { isNavItemActive } from "@/lib/nav/active-path";

describe("isNavItemActive", () => {
  it("matches the exact href", () => {
    expect(isNavItemActive("/event", "/event")).toBe(true);
    expect(isNavItemActive("/detection", "/detection")).toBe(true);
  });

  it("matches nested routes on a segment boundary", () => {
    expect(isNavItemActive("/event/123", "/event")).toBe(true);
    expect(isNavItemActive("/detection/events/abc", "/detection")).toBe(true);
    expect(isNavItemActive("/nodes/settings/foo", "/nodes/settings")).toBe(
      true,
    );
  });

  it("does not let /event prefix-match /events", () => {
    // Regression for #678: the 이벤트 menu (`/event`) must not light up on
    // a detection-event detail page once a `/events/...` source-event
    // route lands under the 이벤트 namespace.
    expect(isNavItemActive("/events", "/event")).toBe(false);
    expect(isNavItemActive("/events/abc", "/event")).toBe(false);
  });

  it("keeps the 탐지 menu active on the relocated investigation route", () => {
    // `/detection/events/<token>` is the detection-event investigation
    // view (#678) — the 탐지 menu (`/detection`) owns it.
    expect(isNavItemActive("/detection/events/token", "/detection")).toBe(true);
    expect(isNavItemActive("/detection/events/token", "/event")).toBe(false);
  });

  it("does not partial-match within a segment", () => {
    expect(isNavItemActive("/detectionx", "/detection")).toBe(false);
  });
});
