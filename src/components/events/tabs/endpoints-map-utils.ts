import type { IpLocationResult } from "@/lib/detection/types";
import type { EndpointEnrichmentMap } from "@/lib/events/endpoint-enrichment-types";

export type EndpointRole = "source" | "destination";

export interface MapMarker {
  addr: string;
  role: EndpointRole;
  latitude: number;
  longitude: number;
  country: string | null;
}

export interface EndpointsMapLabels {
  title: string;
  sourceLegend: string;
  destinationLegend: string;
}

export interface PositionedMarker {
  marker: MapMarker;
  x: number;
  y: number;
}

// When multiple markers land on the same projected pixel — most
// commonly a source/destination pair sharing an IP — they overlap
// and the last one painted hides the others. Offset the members
// of each collision group so every role stays visible. Sources
// shift up-left, destinations shift down-right; within-role ties
// fan out along the same axis by their input order.
const COLLISION_PIXEL = 1;
const COLLISION_OFFSET = 6;

export function layoutMarkers(
  positioned: readonly PositionedMarker[],
): PositionedMarker[] {
  const groups = new Map<string, PositionedMarker[]>();
  for (const p of positioned) {
    const key = `${Math.round(p.x / COLLISION_PIXEL)},${Math.round(p.y / COLLISION_PIXEL)}`;
    const existing = groups.get(key);
    if (existing) existing.push(p);
    else groups.set(key, [p]);
  }

  const out: PositionedMarker[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      const [only] = group;
      if (only) out.push(only);
      continue;
    }
    let sourceRank = 0;
    let destRank = 0;
    for (const p of group) {
      if (p.marker.role === "source") {
        const step = sourceRank++;
        out.push({
          ...p,
          x: p.x - COLLISION_OFFSET - step * COLLISION_OFFSET,
          y: p.y - COLLISION_OFFSET,
        });
      } else {
        const step = destRank++;
        out.push({
          ...p,
          x: p.x + COLLISION_OFFSET + step * COLLISION_OFFSET,
          y: p.y + COLLISION_OFFSET,
        });
      }
    }
  }
  return out;
}

interface Endpointish {
  addr?: string;
}

type Enrichment = IpLocationResult["ipLocation"];

/**
 * Collect plottable markers from the endpoint lists and their
 * enrichment map. An endpoint contributes a marker only when
 * `ipLocation` supplied both latitude and longitude; endpoints
 * without coordinates are skipped silently so the map stays
 * accurate even when enrichment is partial.
 *
 * Duplicates are de-duplicated per (addr, role) — the same IP
 * can legitimately appear multiple times in an array-responder
 * event (different ports / customers) but we only want one
 * dot per geographic position per role.
 */
export function collectMapMarkers(
  sources: readonly Endpointish[],
  destinations: readonly Endpointish[],
  enrichments: EndpointEnrichmentMap,
): MapMarker[] {
  const seen = new Set<string>();
  const markers: MapMarker[] = [];
  const add = (role: EndpointRole, endpoints: readonly Endpointish[]) => {
    for (const ep of endpoints) {
      if (!ep.addr) continue;
      const key = `${role}:${ep.addr}`;
      if (seen.has(key)) continue;
      const enrichment: Enrichment | undefined = enrichments[ep.addr];
      if (
        !enrichment ||
        enrichment.latitude === null ||
        enrichment.longitude === null
      ) {
        continue;
      }
      seen.add(key);
      markers.push({
        addr: ep.addr,
        role,
        latitude: enrichment.latitude,
        longitude: enrichment.longitude,
        country: enrichment.country,
      });
    }
  };
  add("source", sources);
  add("destination", destinations);
  return markers;
}

export function hasGeoMarkers(markers: readonly MapMarker[]): boolean {
  return markers.length > 0;
}
