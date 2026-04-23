"use client";

import { geoEquirectangular, geoPath } from "d3-geo";
import { feature } from "topojson-client";
import type { GeometryCollection, Topology } from "topojson-specification";
import landTopology from "world-atlas/land-110m.json";

import {
  type EndpointsMapLabels,
  layoutMarkers,
  type MapMarker,
  type PositionedMarker,
} from "./endpoints-map-utils";

interface Props {
  markers: readonly MapMarker[];
  labels: EndpointsMapLabels;
}

const WIDTH = 960;
const HEIGHT = 480;

// The land-110m atlas is a single MultiPolygon — compute the path
// once at module scope. The projection has no dynamic inputs, so
// neither does the resulting `d` attribute.
const projection = geoEquirectangular()
  .scale(WIDTH / (2 * Math.PI))
  .translate([WIDTH / 2, HEIGHT / 2]);
const pathGenerator = geoPath(projection);
const landTopo = landTopology as unknown as Topology<{
  land: GeometryCollection;
}>;
const landFeatures = feature(landTopo, landTopo.objects.land);
const LAND_PATH = pathGenerator(landFeatures) ?? "";

export function EndpointsMap({ markers, labels }: Props) {
  if (markers.length === 0) return null;

  const projected: PositionedMarker[] = [];
  for (const marker of markers) {
    const point = projection([marker.longitude, marker.latitude]);
    if (!point) continue;
    projected.push({ marker, x: point[0], y: point[1] });
  }
  const laidOut = layoutMarkers(projected);

  return (
    <section
      aria-label={labels.title}
      className="border-border bg-card flex flex-col gap-3 rounded-md border p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-foreground text-sm font-semibold">
          {labels.title}
        </h2>
        <ul className="text-muted-foreground flex items-center gap-4 text-xs">
          <li className="flex items-center gap-1.5">
            <span
              className="inline-block size-2.5 rounded-full bg-sky-500"
              aria-hidden="true"
            />
            {labels.sourceLegend}
          </li>
          <li className="flex items-center gap-1.5">
            <span
              className="inline-block size-2.5 rotate-45 bg-rose-500"
              aria-hidden="true"
            />
            {labels.destinationLegend}
          </li>
        </ul>
      </div>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label={labels.title}
        className="h-auto w-full"
        preserveAspectRatio="xMidYMid meet"
      >
        <rect width={WIDTH} height={HEIGHT} className="fill-muted/30" />
        <path
          d={LAND_PATH}
          className="fill-muted-foreground/20 stroke-border"
          strokeWidth={0.5}
        />
        {laidOut.map(({ marker, x, y }) => {
          const key = `${marker.role}:${marker.addr}`;
          const tooltip = marker.country
            ? `${marker.addr} · ${marker.country}`
            : marker.addr;
          if (marker.role === "source") {
            return (
              <circle
                key={key}
                cx={x}
                cy={y}
                r={5}
                className="fill-sky-500 stroke-white"
                strokeWidth={1.5}
                data-role="source"
                data-addr={marker.addr}
              >
                <title>{tooltip}</title>
              </circle>
            );
          }
          return (
            <g
              key={key}
              transform={`translate(${x}, ${y}) rotate(45)`}
              data-role="destination"
              data-addr={marker.addr}
            >
              <rect
                x={-4}
                y={-4}
                width={8}
                height={8}
                className="fill-rose-500 stroke-white"
                strokeWidth={1.5}
              >
                <title>{tooltip}</title>
              </rect>
            </g>
          );
        })}
      </svg>
    </section>
  );
}
