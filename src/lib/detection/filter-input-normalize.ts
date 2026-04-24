/**
 * Strict field-level normalization for an already-parsed
 * `EventListFilterInput` object — the value you get back from
 * `JSON.parse` on a `tabs=<json>` URL payload or a stored
 * sessionStorage tab.
 *
 * The active-tab URL parser in `./filter-url.ts` applies a regex-based
 * strict parse to raw string parameters (`?cmin`, `?levels`, …) and
 * drops any token that doesn't match. This module mirrors the same
 * intent for callers that already have a parsed JS object: known fields
 * are validated against their schema (finite numbers, integers, enum
 * membership, deduped non-empty string arrays), malformed values are
 * dropped silently, and unknown keys are stripped so a hand-edited or
 * tampered payload cannot smuggle junk fields into `searchEvents()`.
 *
 * Nested `endpoints` is dropped from the raw input and rebuilt from a
 * separately-validated `EndpointEntry[]` by the caller — the UI-side
 * endpoint list is the source of truth for the endpoint strip and owns
 * the conversion into the GraphQL `EndpointInput` shape.
 */
import { FLOW_KINDS } from "./direction";
import { LEARNING_METHOD_VALUES } from "./filter-options";
import type { EventListFilterInput, FlowKind, LearningMethod } from "./types";

const FLOW_KIND_SET: ReadonlySet<FlowKind> = new Set(FLOW_KINDS);
const LEARNING_METHOD_SET: ReadonlySet<LearningMethod> = new Set(
  LEARNING_METHOD_VALUES,
);

function toNonEmptyString(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

function toFiniteNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function toInteger(v: unknown): number | undefined {
  return typeof v === "number" && Number.isInteger(v) ? v : undefined;
}

function normalizeStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of v) {
    const s = toNonEmptyString(entry);
    if (s === undefined || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out.length > 0 ? out : undefined;
}

function normalizeIntegerArray(v: unknown): number[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const seen = new Set<number>();
  const out: number[] = [];
  for (const entry of v) {
    const n = toInteger(entry);
    if (n === undefined || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out.length > 0 ? out : undefined;
}

function normalizeEnumArray<T extends string>(
  v: unknown,
  allowed: ReadonlySet<T>,
): T[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const seen = new Set<T>();
  const out: T[] = [];
  for (const entry of v) {
    if (
      typeof entry !== "string" ||
      !(allowed as ReadonlySet<string>).has(entry)
    )
      continue;
    const t = entry as T;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Normalize a structured filter `input` object. Only known keys are
 * kept; each is validated against its schema and dropped if malformed.
 * Nested `endpoints` is stripped — the caller must rebuild it from a
 * separately-validated `EndpointEntry[]`.
 */
export function normalizeStructuredInput(raw: unknown): EventListFilterInput {
  if (!raw || typeof raw !== "object") return {};
  const src = raw as Record<string, unknown>;
  const out: EventListFilterInput = {};

  const start = toNonEmptyString(src.start);
  const end = toNonEmptyString(src.end);
  if (start && end) {
    out.start = start;
    out.end = end;
  }

  const source = toNonEmptyString(src.source);
  if (source) out.source = source;
  const destination = toNonEmptyString(src.destination);
  if (destination) out.destination = destination;

  for (const f of [
    "keywords",
    "hostnames",
    "userIds",
    "userNames",
    "userDepartments",
    "countries",
    "kinds",
    "sensors",
    "customers",
    "networkTags",
    "os",
    "devices",
    "triagePolicies",
  ] as const) {
    const list = normalizeStringArray(src[f]);
    if (list) out[f] = list;
  }

  const directions = normalizeEnumArray<FlowKind>(
    src.directions,
    FLOW_KIND_SET,
  );
  if (directions) out.directions = directions;

  const cmin = toFiniteNumber(src.confidenceMin);
  if (cmin !== undefined) out.confidenceMin = cmin;
  const cmax = toFiniteNumber(src.confidenceMax);
  if (cmax !== undefined) out.confidenceMax = cmax;

  const levels = normalizeIntegerArray(src.levels);
  if (levels) out.levels = levels;
  const categories = normalizeIntegerArray(src.categories);
  if (categories) out.categories = categories;

  const learningMethods = normalizeEnumArray<LearningMethod>(
    src.learningMethods,
    LEARNING_METHOD_SET,
  );
  if (learningMethods) out.learningMethods = learningMethods;

  return out;
}
