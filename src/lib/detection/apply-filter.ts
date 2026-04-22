import { directionsForFilterInput } from "./direction";
import { endpointsToEndpointInputs } from "./endpoint-filter";
import type { Filter } from "./filter";
import { type DetectionFilterDraft, isConfidenceDefault } from "./filter-draft";
import type { EventListFilterInput } from "./types";

/**
 * Build the structured `Filter` submitted by the Detection drawer's
 * Apply button.
 *
 * When the draft's confidence range is at the `[0, 1]` default, both
 * `confidenceMin` and `confidenceMax` are physically omitted from the
 * returned `EventListFilterInput` — not set to `null`. The drawer
 * treats the default as "no filter", and the GraphQL client forwards
 * whatever object we hand it unchanged (see `src/lib/graphql/client.ts`),
 * so sending explicit `null`s would leave the decision to REview's
 * null-vs-absent semantics. Omitting the keys matches the acceptance
 * criteria ("both fields omitted from submission") and is the safer
 * contract regardless.
 *
 * Any prior `confidenceMin` / `confidenceMax` carried by
 * `currentFilter.input` is also dropped before the new value is
 * applied, so a previous non-default commit cannot bleed through when
 * the user resets the range back to the default.
 */
export function buildAppliedFilter(
  currentFilter: Filter,
  applied: DetectionFilterDraft,
  sensorEndpointLive: boolean = false,
): Filter {
  if (!applied.startIso || !applied.endIso) {
    throw new Error("buildAppliedFilter requires both startIso and endIso");
  }

  const previousInput: Partial<EventListFilterInput> =
    currentFilter.mode === "structured" ? currentFilter.input : {};
  const {
    confidenceMin: _prevMin,
    confidenceMax: _prevMax,
    directions: _prevDirections,
    endpoints: _prevEndpoints,
    sensors: _prevSensors,
    ...previousWithoutConfidence
  } = previousInput;

  const directions = directionsForFilterInput(applied.directions);
  const endpoints = endpointsToEndpointInputs(applied.endpoints);

  const input: EventListFilterInput = {
    ...previousWithoutConfidence,
    start: applied.startIso,
    end: applied.endIso,
    endpoints: endpoints.length > 0 ? endpoints : null,
  };
  if (directions) {
    input.directions = directions;
  }
  if (!isConfidenceDefault(applied)) {
    input.confidenceMin = applied.confidenceMin;
    input.confidenceMax = applied.confidenceMax;
  }
  // Sensors only flow into the submitted filter when the REview
  // sensor-list endpoint is live AND the user picked at least one;
  // every other state strips the field so the fallback contract
  // ("no `sensors` reaches the filter unless ready") holds.
  if (sensorEndpointLive && applied.sensorIds.length > 0) {
    input.sensors = [...applied.sensorIds];
  }

  return { mode: "structured", input };
}
