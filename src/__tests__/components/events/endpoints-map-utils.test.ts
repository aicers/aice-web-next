import { describe, expect, it } from "vitest";

import {
  collectMapMarkers,
  hasGeoMarkers,
  layoutMarkers,
  type MapMarker,
  type PositionedMarker,
} from "@/components/events/tabs/endpoints-map-utils";
import type { EndpointEnrichmentMap } from "@/lib/events/endpoint-enrichment-types";

function enrichment(
  latitude: number | null,
  longitude: number | null,
  country: string | null = null,
): EndpointEnrichmentMap[string] {
  return {
    latitude,
    longitude,
    country,
    region: null,
    city: null,
    isp: null,
    domain: null,
  };
}

describe("collectMapMarkers", () => {
  it("returns one marker per addr+role with resolved coordinates", () => {
    const enrichments: EndpointEnrichmentMap = {
      "10.0.0.1": enrichment(37.5665, 126.978, "KR"),
      "203.0.113.45": enrichment(40.7128, -74.006, "US"),
    };

    const markers = collectMapMarkers(
      [{ addr: "10.0.0.1" }],
      [{ addr: "203.0.113.45" }],
      enrichments,
    );

    expect(markers).toEqual([
      {
        addr: "10.0.0.1",
        role: "source",
        latitude: 37.5665,
        longitude: 126.978,
        country: "KR",
      },
      {
        addr: "203.0.113.45",
        role: "destination",
        latitude: 40.7128,
        longitude: -74.006,
        country: "US",
      },
    ]);
  });

  it("skips endpoints without addr or without coordinates", () => {
    const enrichments: EndpointEnrichmentMap = {
      "10.0.0.1": enrichment(null, null),
      "10.0.0.2": enrichment(10, 20, "JP"),
    };

    const markers = collectMapMarkers(
      [{ addr: "10.0.0.1" }, { addr: undefined }, { addr: "10.0.0.2" }],
      [],
      enrichments,
    );

    expect(markers).toHaveLength(1);
    expect(markers[0]?.addr).toBe("10.0.0.2");
  });

  it("emits one marker per unique address for array-addressed subtypes", () => {
    const enrichments: EndpointEnrichmentMap = {
      "10.0.0.5": enrichment(0, 0, "ZZ"),
      "10.0.0.6": enrichment(1, 1, "ZZ"),
      "10.0.0.7": enrichment(2, 2, "ZZ"),
    };

    const destinations = [
      { addr: "10.0.0.5" },
      { addr: "10.0.0.6" },
      { addr: "10.0.0.5" }, // repeated with a different port
      { addr: "10.0.0.7" },
    ];

    const markers = collectMapMarkers([], destinations, enrichments);

    expect(markers.map((m) => m.addr)).toEqual([
      "10.0.0.5",
      "10.0.0.6",
      "10.0.0.7",
    ]);
  });

  it("keeps both markers when the same address appears as source and destination", () => {
    const enrichments: EndpointEnrichmentMap = {
      "10.0.0.9": enrichment(10, 20, "KR"),
    };

    const markers = collectMapMarkers(
      [{ addr: "10.0.0.9" }],
      [{ addr: "10.0.0.9" }],
      enrichments,
    );

    expect(markers).toHaveLength(2);
    expect(markers.map((m) => m.role)).toEqual(["source", "destination"]);
  });

  it("skips addresses that have no enrichment entry at all", () => {
    const markers = collectMapMarkers(
      [{ addr: "10.0.0.1" }],
      [{ addr: "203.0.113.45" }],
      {},
    );

    expect(markers).toEqual([]);
  });
});

describe("layoutMarkers", () => {
  function marker(
    addr: string,
    role: "source" | "destination",
    country: string | null = null,
  ): MapMarker {
    return { addr, role, latitude: 0, longitude: 0, country };
  }

  function positioned(m: MapMarker, x: number, y: number): PositionedMarker {
    return { marker: m, x, y };
  }

  it("leaves lone markers at their projected position", () => {
    const a = positioned(marker("10.0.0.1", "source"), 100, 200);
    const b = positioned(marker("10.0.0.2", "destination"), 300, 400);

    expect(layoutMarkers([a, b])).toEqual([a, b]);
  });

  it("offsets a colliding source/destination pair in opposite directions", () => {
    const src = positioned(marker("10.0.0.9", "source"), 150, 150);
    const dest = positioned(marker("10.0.0.9", "destination"), 150, 150);

    const result = layoutMarkers([src, dest]);

    expect(result).toHaveLength(2);
    const srcOut = result.find((p) => p.marker.role === "source");
    const destOut = result.find((p) => p.marker.role === "destination");
    expect(srcOut).toBeDefined();
    expect(destOut).toBeDefined();
    // Source shifts up-left, destination shifts down-right, so the
    // two markers never land on the same pixel again.
    expect(srcOut?.x).toBeLessThan(150);
    expect(srcOut?.y).toBeLessThan(150);
    expect(destOut?.x).toBeGreaterThan(150);
    expect(destOut?.y).toBeGreaterThan(150);
    expect(srcOut?.x).not.toBe(destOut?.x);
    expect(srcOut?.y).not.toBe(destOut?.y);
  });

  it("fans out multiple same-role markers at the same pixel", () => {
    const a = positioned(marker("10.0.0.1", "source"), 150, 150);
    const b = positioned(marker("10.0.0.2", "source"), 150, 150);

    const result = layoutMarkers([a, b]);

    expect(result).toHaveLength(2);
    expect(result[0]?.x).not.toBe(result[1]?.x);
  });
});

describe("hasGeoMarkers", () => {
  it("returns true when at least one marker is present", () => {
    expect(
      hasGeoMarkers([
        {
          addr: "10.0.0.1",
          role: "source",
          latitude: 1,
          longitude: 2,
          country: null,
        },
      ]),
    ).toBe(true);
  });

  it("returns false when no markers are present", () => {
    expect(hasGeoMarkers([])).toBe(false);
  });
});
