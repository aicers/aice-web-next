/**
 * Active filter chip orchestration for the Detection result list
 * (Phase Detection-9).
 *
 * `summarizeFilter(filter)` is the shared entry point the chip bar
 * uses, regardless of where chips are rendered. It accepts the
 * abstract {@link Filter} (Phase Detection-2) — not a raw
 * {@link EventListFilterInput} — so the future search-language
 * branch can be folded in without reshaping callers.
 *
 * Forward-compatibility note (umbrella issue #271 — "Forward
 * compatibility"): the v1 chip bar only handles `mode === "structured"`.
 * The `query` branch returns a single editable pill rather than
 * attempting per-field decomposition (the query language can express
 * OR / NOT / regex that the structured chip rules cannot represent).
 * Clicking the pill is wired to the dedicated query editor in the
 * Detection-* phase that introduces it; the editor itself is out of
 * scope for v1.
 */

import { directionsForFilterInput, FLOW_KINDS } from "./direction";
import type { EndpointEntry } from "./endpoint-filter";
import type { Filter } from "./filter";
import { CONFIDENCE_DEFAULT_MAX, CONFIDENCE_DEFAULT_MIN } from "./filter-draft";
import type { EventListFilterInput, FlowKind, LearningMethod } from "./types";

/**
 * Identifies which active chip a × press should remove. Each shape
 * is a small descriptor the helper {@link removeActiveChip} consumes
 * to produce the next {@link Filter}; chips render the descriptor as
 * an opaque payload on the × handler.
 */
export type ChipRemoveTarget =
  | { kind: "scalarField"; field: "source" | "destination" }
  | {
      kind: "arrayValue";
      field:
        | "keywords"
        | "hostnames"
        | "userIds"
        | "userNames"
        | "userDepartments"
        | "sensors";
      value: string;
    }
  | {
      kind: "arrayAggregate";
      field:
        | "keywords"
        | "hostnames"
        | "userIds"
        | "userNames"
        | "userDepartments"
        | "sensors";
    }
  | {
      kind: "categoricalValue";
      field: "levels" | "categories";
      value: number;
    }
  | { kind: "categoricalValue"; field: "countries" | "kinds"; value: string }
  | {
      kind: "categoricalValue";
      field: "learningMethods";
      value: LearningMethod;
    }
  | {
      kind: "categoricalAggregate";
      field:
        | "levels"
        | "countries"
        | "learningMethods"
        | "categories"
        | "kinds";
    }
  | { kind: "directionValue"; value: FlowKind }
  | { kind: "confidence" }
  | { kind: "period" }
  | { kind: "endpointEntry"; entryId: string }
  | { kind: "endpointAll" }
  | { kind: "queryPill" };

export interface ActiveChipRemoval {
  filter: Filter;
  endpoints: EndpointEntry[];
}

/**
 * Apply a chip × press to the committed state. Returns the next
 * {@link Filter} and {@link EndpointEntry} list. Endpoints are
 * threaded through because the drawer's Network/IP entries live in
 * client state alongside the filter input — the chip × must remove
 * the same row from both halves, otherwise removing an endpoint
 * chip would silently re-appear when the drawer was reopened.
 */
export function removeActiveChip(
  filter: Filter,
  endpoints: EndpointEntry[],
  target: ChipRemoveTarget,
): ActiveChipRemoval {
  if (filter.mode !== "structured") {
    // Query-mode pill removal clears the entire query text. Other
    // chip kinds cannot exist in query mode.
    if (target.kind === "queryPill") {
      return { filter: { mode: "query", text: "" }, endpoints };
    }
    return { filter, endpoints };
  }
  const input = { ...filter.input };

  switch (target.kind) {
    case "scalarField":
      delete input[target.field];
      break;
    case "arrayValue": {
      const list = input[target.field] ?? [];
      const next = list.filter((v) => v !== target.value);
      if (next.length === 0) delete input[target.field];
      else input[target.field] = next;
      break;
    }
    case "arrayAggregate":
      delete input[target.field];
      break;
    case "categoricalValue": {
      if (target.field === "categories") {
        const list = (input.categories ?? []).filter(
          (v): v is number => typeof v === "number",
        );
        const next = list.filter((v) => v !== target.value);
        if (next.length === 0) delete input.categories;
        else input.categories = next;
      } else if (target.field === "levels") {
        const list = input.levels ?? [];
        const next = list.filter((v) => v !== target.value);
        if (next.length === 0) delete input.levels;
        else input.levels = next;
      } else if (target.field === "countries") {
        const list = input.countries ?? [];
        const next = list.filter((v) => v !== target.value);
        if (next.length === 0) delete input.countries;
        else input.countries = next;
      } else if (target.field === "kinds") {
        const list = input.kinds ?? [];
        const next = list.filter((v) => v !== target.value);
        if (next.length === 0) delete input.kinds;
        else input.kinds = next;
      } else if (target.field === "learningMethods") {
        const list = input.learningMethods ?? [];
        const next = list.filter((v) => v !== target.value);
        if (next.length === 0) delete input.learningMethods;
        else input.learningMethods = next;
      }
      break;
    }
    case "categoricalAggregate":
      delete input[target.field];
      break;
    case "directionValue": {
      // Removing a direction chip drops the value from the active
      // selection. If that would leave the set empty, fall back to
      // the "all selected" default (= no filter), matching the
      // drawer's invariant that the operator can never reach an
      // empty direction set.
      const current = input.directions ?? [...FLOW_KINDS];
      const next = current.filter((v) => v !== target.value);
      const normalized = directionsForFilterInput(next);
      if (normalized) input.directions = normalized;
      else delete input.directions;
      break;
    }
    case "confidence":
      delete input.confidenceMin;
      delete input.confidenceMax;
      break;
    case "period":
      delete input.start;
      delete input.end;
      break;
    case "endpointEntry": {
      const next = endpoints.filter((e) => e.id !== target.entryId);
      // The endpoints field is rebuilt by buildAppliedFilter from the
      // remaining entries; here we just keep the input shape consistent
      // by clearing it when nothing is left.
      if (next.length === 0) delete input.endpoints;
      return { filter: { mode: "structured", input }, endpoints: next };
    }
    case "endpointAll":
      delete input.endpoints;
      return { filter: { mode: "structured", input }, endpoints: [] };
    case "queryPill":
      // No-op for structured mode — the pill only renders in query mode.
      break;
  }

  return { filter: { mode: "structured", input }, endpoints };
}

/**
 * Helper for tests/diagnostics: report whether the structured input
 * carries any non-time filter values. The chip bar's "no filter
 * applied" hint depends on this, but the live shell composes its
 * empty state from each chip group, not this helper.
 */
export function hasAnyActiveChip(filter: Filter): boolean {
  if (filter.mode !== "structured") return filter.text.trim().length > 0;
  const input: EventListFilterInput = filter.input;
  if (input.source) return true;
  if (input.destination) return true;
  for (const f of [
    "keywords",
    "hostnames",
    "userIds",
    "userNames",
    "userDepartments",
    "sensors",
  ] as const) {
    const v = input[f];
    if (v && v.length > 0) return true;
  }
  if (input.categories && input.categories.length > 0) return true;
  if (input.levels && input.levels.length > 0) return true;
  if (input.countries && input.countries.length > 0) return true;
  if (input.kinds && input.kinds.length > 0) return true;
  if (input.learningMethods && input.learningMethods.length > 0) return true;
  if (input.directions && input.directions.length > 0) return true;
  if (input.endpoints && input.endpoints.length > 0) return true;
  if (
    typeof input.confidenceMin === "number" &&
    input.confidenceMin > CONFIDENCE_DEFAULT_MIN
  ) {
    return true;
  }
  if (
    typeof input.confidenceMax === "number" &&
    input.confidenceMax < CONFIDENCE_DEFAULT_MAX
  ) {
    return true;
  }
  return false;
}
