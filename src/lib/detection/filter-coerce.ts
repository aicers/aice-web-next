/**
 * Runtime shape coercion for an inbound {@link Filter} payload.
 *
 * Both the shareable `?f=` URL blob and the personal saved-filter
 * store hand a JSON-shaped value back to the Detection shell, where
 * chip / draft / endpoint helpers assume a schema-valid
 * {@link EventListFilterInput} (e.g. `categories.flatMap(...)`,
 * `keywords.filter(...)`). A crafted payload — `?f=`-encoded link or
 * a server-action call from a malicious authenticated client — could
 * otherwise plant a row like `{ keywords: "not-an-array" }` and crash
 * the page on the next render.
 *
 * The coercer below walks every field on the generated
 * {@link EventListFilterInput} contract and drops any that does not
 * match the expected primitive type. Returns `null` only when the
 * outer shape is unrecoverable (unknown mode, missing query text);
 * a structured filter with all fields stripped is still a valid
 * filter and round-trips as the default `{ mode: "structured", input: {} }`.
 */

import type { Filter } from "./filter";
import type {
  EndpointInput,
  EventListFilterInput,
  FlowKind,
  HostNetworkGroupInput,
  IpRangeInput,
  LearningMethod,
  TrafficDirection,
} from "./types";

const FLOW_KIND_VALUES = new Set<FlowKind>(["INBOUND", "OUTBOUND", "INTERNAL"]);
const LEARNING_METHOD_VALUES = new Set<LearningMethod>([
  "UNSUPERVISED",
  "SEMI_SUPERVISED",
]);
const TRAFFIC_DIRECTION_VALUES = new Set<TrafficDirection>(["FROM", "TO"]);

export function coerceFilter(value: unknown): Filter | null {
  if (!value || typeof value !== "object") return null;
  const v = value as { mode?: unknown; input?: unknown; text?: unknown };
  if (v.mode === "structured") {
    if (!v.input || typeof v.input !== "object" || Array.isArray(v.input)) {
      return null;
    }
    return {
      mode: "structured",
      input: coerceEventListFilterInput(v.input),
    };
  }
  if (v.mode === "query") {
    if (typeof v.text !== "string") return null;
    return { mode: "query", text: v.text };
  }
  return null;
}

export function coerceEventListFilterInput(
  value: object,
): EventListFilterInput {
  const v = value as Record<string, unknown>;
  const out: EventListFilterInput = {};
  if (typeof v.start === "string") out.start = v.start;
  if (typeof v.end === "string") out.end = v.end;
  if (typeof v.source === "string") out.source = v.source;
  if (typeof v.destination === "string") out.destination = v.destination;
  const stringArrayFields = [
    "customers",
    "keywords",
    "networkTags",
    "sensors",
    "os",
    "devices",
    "hostnames",
    "userIds",
    "userNames",
    "userDepartments",
    "countries",
    "kinds",
    "triagePolicies",
  ] as const;
  for (const key of stringArrayFields) {
    const arr = filterStringArray(v[key]);
    if (arr) out[key] = arr;
  }
  const numberArrayFields = ["levels"] as const;
  for (const key of numberArrayFields) {
    const arr = filterNumberArray(v[key]);
    if (arr) out[key] = arr;
  }
  if (Array.isArray(v.categories)) {
    out.categories = v.categories.filter(
      (item): item is number | null =>
        item === null || typeof item === "number",
    );
  }
  if (Array.isArray(v.directions)) {
    out.directions = v.directions.filter(
      (item): item is FlowKind =>
        typeof item === "string" && FLOW_KIND_VALUES.has(item as FlowKind),
    );
  }
  if (Array.isArray(v.learningMethods)) {
    out.learningMethods = v.learningMethods.filter(
      (item): item is LearningMethod =>
        typeof item === "string" &&
        LEARNING_METHOD_VALUES.has(item as LearningMethod),
    );
  }
  if (typeof v.confidenceMin === "number" && Number.isFinite(v.confidenceMin)) {
    out.confidenceMin = v.confidenceMin;
  }
  if (typeof v.confidenceMax === "number" && Number.isFinite(v.confidenceMax)) {
    out.confidenceMax = v.confidenceMax;
  }
  if (Array.isArray(v.endpoints)) {
    const eps = v.endpoints
      .map(coerceEndpointInput)
      .filter((ep): ep is EndpointInput => ep !== null);
    if (eps.length > 0) out.endpoints = eps;
  }
  return out;
}

export function coerceEndpointInput(value: unknown): EndpointInput | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const out: EndpointInput = {};
  if (
    typeof v.direction === "string" &&
    TRAFFIC_DIRECTION_VALUES.has(v.direction as TrafficDirection)
  ) {
    out.direction = v.direction as TrafficDirection;
  } else if (v.direction === null) {
    out.direction = null;
  }
  if (typeof v.predefined === "string") out.predefined = v.predefined;
  const custom = coerceHostNetworkGroup(v.custom);
  if (custom) out.custom = custom;
  return out;
}

function coerceHostNetworkGroup(value: unknown): HostNetworkGroupInput | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  return {
    hosts: filterStringArray(v.hosts) ?? [],
    networks: filterStringArray(v.networks) ?? [],
    ranges: Array.isArray(v.ranges)
      ? v.ranges.map(coerceIpRange).filter((r): r is IpRangeInput => r !== null)
      : [],
  };
}

export function coerceIpRange(value: unknown): IpRangeInput | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.start !== "string" || typeof v.end !== "string") return null;
  return { start: v.start, end: v.end };
}

function filterStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((item): item is string => typeof item === "string");
}

function filterNumberArray(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter(
    (item): item is number => typeof item === "number" && Number.isFinite(item),
  );
}
