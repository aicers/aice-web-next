import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { EndpointsMap } from "@/components/events/tabs/endpoints-map";
import type { MapMarker } from "@/components/events/tabs/endpoints-map-utils";

const LABELS = {
  title: "Endpoints map",
  sourceLegend: "Source",
  destinationLegend: "Destination",
};

function marker(
  addr: string,
  role: "source" | "destination",
  latitude: number,
  longitude: number,
): MapMarker {
  return { addr, role, latitude, longitude, country: null };
}

describe("EndpointsMap rendering", () => {
  it("renders both a source circle and a destination diamond for the same address", () => {
    const html = renderToStaticMarkup(
      <EndpointsMap
        markers={[
          marker("10.0.0.9", "source", 37.5, 126.9),
          marker("10.0.0.9", "destination", 37.5, 126.9),
        ]}
        labels={LABELS}
      />,
    );

    // Both role-specific glyphs must be present in the output —
    // the renderer must not let the destination overpaint the source.
    const sourceMatches = html.match(
      /<circle[^>]*data-role="source"[^>]*data-addr="10\.0\.0\.9"/g,
    );
    const destMatches = html.match(
      /<g[^>]*data-role="destination"[^>]*data-addr="10\.0\.0\.9"/g,
    );
    expect(sourceMatches).toHaveLength(1);
    expect(destMatches).toHaveLength(1);

    // And they must not project to the same pixel (otherwise the
    // data-role attrs are present but the user sees a single glyph).
    const sourceCx = /<circle[^>]*cx="([-\d.]+)"[^>]*data-role="source"/.exec(
      html,
    );
    const destTransform =
      /<g[^>]*transform="translate\(([-\d.]+), ([-\d.]+)\)[^"]*"[^>]*data-role="destination"/.exec(
        html,
      );
    expect(sourceCx).not.toBeNull();
    expect(destTransform).not.toBeNull();
    expect(sourceCx?.[1]).not.toEqual(destTransform?.[1]);
  });

  it("renders markers without offset when coordinates do not collide", () => {
    const html = renderToStaticMarkup(
      <EndpointsMap
        markers={[
          marker("10.0.0.1", "source", 37.5, 126.9),
          marker("10.0.0.2", "destination", 40.7, -74),
        ]}
        labels={LABELS}
      />,
    );

    expect(html).toContain('data-role="source"');
    expect(html).toContain('data-role="destination"');
  });

  it("renders nothing when the marker list is empty", () => {
    const html = renderToStaticMarkup(
      <EndpointsMap markers={[]} labels={LABELS} />,
    );
    expect(html).toBe("");
  });
});
