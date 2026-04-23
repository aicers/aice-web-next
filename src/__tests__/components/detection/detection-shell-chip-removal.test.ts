import { describe, expect, it } from "vitest";

import {
  type EndpointEntry,
  endpointsToEndpointInputs,
} from "@/lib/detection/endpoint-filter";
import { buildInvestigationReturnTo } from "@/lib/events/return-to";

/**
 * Regression fixtures for the three review-round-1 concerns on the
 * Detection shell. Pure helpers only — the shell itself is a
 * `"use client"` component and the project does not bundle a React
 * testing runtime, so we drive the behaviour via the helpers it
 * delegates to.
 */

function makeEntry(
  id: string,
  host: string,
  overrides: Partial<EndpointEntry> = {},
): EndpointEntry {
  return {
    id,
    raw: host,
    kind: "host",
    host,
    direction: "BOTH",
    selected: true,
    ...overrides,
  };
}

describe("endpoint chip × removal rebuilds input.endpoints", () => {
  /**
   * Round-1 reviewer concern: removing a single Network/IP chip
   * updated `committedEndpoints` but left the previously submitted
   * `input.endpoints` array untouched — the dispatched query ran
   * with the removed rule still active. The fix rebuilds
   * `input.endpoints` from the surviving entries every time a chip
   * is removed, so the committed filter and the chip bar stay in
   * sync.
   */
  it("shrinks the input array when a single entry is removed", () => {
    const entries: EndpointEntry[] = [
      makeEntry("a", "10.0.0.1", { direction: "SOURCE" }),
      makeEntry("b", "10.0.0.2", { direction: "SOURCE" }),
      makeEntry("c", "10.0.0.3", { direction: "DESTINATION" }),
    ];
    const before = endpointsToEndpointInputs(entries);
    expect(before).toHaveLength(2); // SOURCE bucket + DESTINATION bucket

    const afterRemovingB = endpointsToEndpointInputs(
      entries.filter((e) => e.id !== "b"),
    );
    const sourceBucket = afterRemovingB.find((e) => e.direction === "FROM");
    expect(sourceBucket?.custom?.hosts).toEqual(["10.0.0.1"]);
  });

  it("returns an empty array when the last entry is removed", () => {
    const entries: EndpointEntry[] = [makeEntry("only", "10.0.0.1")];
    expect(endpointsToEndpointInputs([])).toEqual([]);
    // Sanity: the input form still builds something before removal.
    expect(endpointsToEndpointInputs(entries)).toHaveLength(1);
  });
});

describe("buildInvestigationReturnTo", () => {
  /**
   * Round-1 reviewer concern: the Investigation push target was
   * hard-coded to `?returnTo=%2Fdetection`, which dropped the
   * operator's URL / filter state when jumping off the list. The
   * helper preserves the current path + query string so the back
   * link round-trips.
   */
  it("preserves path and query string", () => {
    expect(
      buildInvestigationReturnTo("/detection", "source=10.0.0.5&window=1d"),
    ).toBe("/detection?source=10.0.0.5&window=1d");
  });

  it("tolerates a leading `?` on the search string", () => {
    expect(buildInvestigationReturnTo("/detection", "?kind=HttpThreat")).toBe(
      "/detection?kind=HttpThreat",
    );
  });

  it("omits the query separator when no params are active", () => {
    expect(buildInvestigationReturnTo("/detection", "")).toBe("/detection");
  });

  it("does not add a locale prefix — the caller passes a locale-stripped path", () => {
    // The Investigation back-link renders via next-intl's locale-aware
    // `<Link>`, so the stored `returnTo` must stay locale-free.
    expect(
      buildInvestigationReturnTo("/detection", "source=1.2.3.4"),
    ).not.toMatch(/^\/[a-z]{2}\//);
  });
});
