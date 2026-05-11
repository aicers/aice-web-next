/**
 * Pivot-dimension registry for the Triage menu (Phase 1.A — Tier 1).
 *
 * Each dimension declares how to extract its values from a single
 * scored event. The pivot index in `./index.ts` walks every event
 * through every dimension once to build a `Map<value, events[]>`
 * grouping; the Related-events panel reads from that grouping.
 *
 * Per #447 §6 (deprecatable seam) this module — and everything else
 * under `src/lib/triage/pivot/` — must not import from the policy
 * subtree. Tier 2 weak-signal rendering and the mode toggle wiring
 * are #453's scope, not this issue's.
 */

import { THREAT_CATEGORY_VALUE_BY_KEY } from "@/lib/detection/filter-options";

import { classifyTriageEndpoint } from "../classify";
import type { ScoredTriageEvent } from "../types";
import {
  extractRegistrableDomain,
  isIpLiteral,
  normalizeUriPattern,
  TRIAGE_SAME_KIND_WINDOW_MS,
} from "./normalize";

/**
 * Stable identifier set for the pivot dimensions surfaced by the
 * Triage menu. Strings, not enums, so the panel can render i18n
 * labels keyed by id without threading the enum through every prop.
 *
 * `kinds`, `categories`, `levels` are server-filtered Tier-2-only
 * dimensions: they exist as `EventListFilterInput` fields and are
 * surfaced as a separate group in Tier 2 mode (#453 §"Server-
 * filtered, Tier-2-only"). Their click action issues a Tier 2 fetch
 * rather than reading from the loaded corpus.
 *
 * `learningMethods` is also a Tier-2-only server-filtered dimension
 * but is rendered as a *static-options* section (#498) — its values
 * come from a fixed two-element enum on the SDL, not from the loaded
 * corpus, so there is no `PivotDimension` object in
 * {@link PIVOT_DIMENSIONS}. The id is included in the union so the
 * click handler, hash parser, cache key, and `Tier2Pending*` types
 * can refer to it; the static section metadata lives in
 * `src/lib/triage/learning-methods.ts`.
 *
 * `keywords` is a Tier-2-only server-filtered free-text dimension
 * (#499). It has no corpus extractor and no fixed enum — the panel
 * renders a typed-input chip section and submits the trimmed value
 * verbatim through the same `tier2.startFetch` path as the other
 * server-filtered dimensions. Like `learningMethods`, the id is in
 * the union for the type integration but there is no `PivotDimension`
 * object in {@link PIVOT_DIMENSIONS}.
 */
export type PivotDimensionId =
  | "externalIp"
  | "internalIp"
  | "port"
  | "country"
  | "registrableDomain"
  | "host"
  | "uriPattern"
  | "userAgent"
  | "ja3"
  | "ja3s"
  | "sni"
  | "certSerial"
  | "certSubjectCn"
  | "dnsQuery"
  | "dnsAnswer"
  | "sameKindWithin15Min"
  | "sameSensor"
  | "clusterId"
  | "kinds"
  | "categories"
  | "levels"
  | "learningMethods"
  | "keywords";

/**
 * Pivot value. Carries both the canonical pivot key (the index key
 * the panel groups events by) and a human-readable label the panel
 * shows to the operator. Two values are equal iff their `key` is
 * equal — `label` is presentational only.
 */
export interface PivotValue {
  key: string;
  label: string;
}

/**
 * One pivot dimension. The extractor returns the values present on
 * this event; an event can carry multiple values for one dimension
 * (e.g. an event with both an external `origAddr` and an external
 * `respAddr` produces two `externalIp` values).
 */
export interface PivotDimension {
  id: PivotDimensionId;
  /**
   * `network`, `application`, `tls`, `dns`, `time-structure`,
   * `tier2-only`. Used by the panel only for grouping section
   * headers; not part of the pivot key.
   */
  family: PivotDimensionFamily;
  /**
   * `true` for Tier-2-only server-filtered dimensions (`kinds`,
   * `categories`, `levels`). The panel hides them in Tier 1 mode and
   * surfaces them as a separate group in Tier 2; clicks issue a
   * Tier 2 fetch rather than reading from the corpus.
   */
  tier2Only?: boolean;
  /**
   * `true` when the dimension reads from a `TriageEvent` field that
   * is NOT present on the Baseline-mode corpus row
   * (`baseline_triaged_event`). Examples: `country` (no orig/resp
   * country column), `userAgent` (HTTP subtype-specific), TLS
   * subtype fields, `dnsAnswer`, `clusterId`. The panel and pivot
   * Tier 1 index builder skip these dimensions when the active mode
   * is `"baseline"` so the operator does not see a section that can
   * never produce a value. The "With my policies" mode (#460)
   * preserves the full `eventList` payload through corpus B and
   * keeps these dimensions live.
   */
  policyOnly?: boolean;
  extract(event: ScoredTriageEvent): PivotValue[];
}

export type PivotDimensionFamily =
  | "network"
  | "application"
  | "tls"
  | "dns"
  | "time-structure"
  | "tier2-only";

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function ipDimension(id: "externalIp" | "internalIp"): PivotDimension {
  const wantInternal = id === "internalIp";
  return {
    id,
    family: "network",
    extract(event) {
      const out: PivotValue[] = [];
      const seen = new Set<string>();
      for (const side of ["orig", "resp"] as const) {
        const addr =
          side === "orig" ? (event.origAddr ?? null) : (event.respAddr ?? null);
        if (typeof addr !== "string" || addr.length === 0) continue;
        const klass = classifyTriageEndpoint(event, side);
        if (klass === "unknown") continue;
        const isInternal = klass === "internal";
        if (isInternal !== wantInternal) continue;
        if (seen.has(addr)) continue;
        seen.add(addr);
        out.push({ key: addr, label: addr });
      }
      return out;
    },
  };
}

const PORT_DIMENSION: PivotDimension = {
  id: "port",
  family: "network",
  extract(event) {
    // Index on `respPort` (destination port) — that is the
    // operator-meaningful pivot for "what service is the asset
    // talking to". `origPort` is ephemeral and mostly random.
    const respPort = event.respPort;
    if (typeof respPort !== "number" || !Number.isFinite(respPort)) return [];
    const key = String(respPort);
    return [{ key, label: key }];
  },
};

const COUNTRY_DIMENSION: PivotDimension = {
  id: "country",
  family: "network",
  policyOnly: true,
  extract(event) {
    const out: PivotValue[] = [];
    const seen = new Set<string>();
    for (const cc of [event.origCountry, event.respCountry]) {
      const value = nonEmptyString(cc);
      if (!value) continue;
      const upper = value.toUpperCase();
      if (seen.has(upper)) continue;
      seen.add(upper);
      out.push({ key: upper, label: upper });
    }
    return out;
  },
};

const REGISTRABLE_DOMAIN_DIMENSION: PivotDimension = {
  id: "registrableDomain",
  family: "application",
  extract(event) {
    const out: PivotValue[] = [];
    const seen = new Set<string>();
    for (const candidate of [event.host, event.serverName, event.query]) {
      const domain = extractRegistrableDomain(candidate);
      if (!domain || seen.has(domain)) continue;
      seen.add(domain);
      out.push({ key: domain, label: domain });
    }
    return out;
  },
};

const HOST_DIMENSION: PivotDimension = {
  id: "host",
  family: "application",
  extract(event) {
    const value = nonEmptyString(event.host);
    if (!value) return [];
    const lower = value.toLowerCase();
    return [{ key: lower, label: lower }];
  },
};

const URI_PATTERN_DIMENSION: PivotDimension = {
  id: "uriPattern",
  family: "application",
  extract(event) {
    const pattern = normalizeUriPattern(event.uri);
    if (!pattern) return [];
    return [{ key: pattern, label: pattern }];
  },
};

const USER_AGENT_DIMENSION: PivotDimension = {
  id: "userAgent",
  family: "application",
  policyOnly: true,
  extract(event) {
    const value = nonEmptyString(event.userAgent);
    if (!value) return [];
    return [{ key: value, label: value }];
  },
};

function tlsField(
  id: "ja3" | "ja3s" | "sni" | "certSerial" | "certSubjectCn",
  pick: (event: ScoredTriageEvent) => string | null | undefined,
): PivotDimension {
  return {
    id,
    family: "tls",
    policyOnly: true,
    extract(event) {
      const value = nonEmptyString(pick(event));
      if (!value) return [];
      return [{ key: value, label: value }];
    },
  };
}

const JA3_DIMENSION = tlsField("ja3", (e) => e.ja3);
const JA3S_DIMENSION = tlsField("ja3s", (e) => e.ja3S);
const SNI_DIMENSION = tlsField("sni", (e) => e.serverName);
const CERT_SERIAL_DIMENSION = tlsField("certSerial", (e) => e.serial);
const CERT_SUBJECT_CN_DIMENSION = tlsField(
  "certSubjectCn",
  (e) => e.subjectCommonName,
);

const DNS_QUERY_DIMENSION: PivotDimension = {
  id: "dnsQuery",
  family: "dns",
  extract(event) {
    const value = nonEmptyString(event.query);
    if (!value) return [];
    const lower = value.toLowerCase();
    return [{ key: lower, label: lower }];
  },
};

const DNS_ANSWER_DIMENSION: PivotDimension = {
  id: "dnsAnswer",
  family: "dns",
  policyOnly: true,
  extract(event) {
    const value = nonEmptyString(event.answer);
    if (!value) return [];
    // `answer` may carry comma- or space-separated multiple tokens
    // (REview emits a flat string per row). The dimension's contract
    // is "answer IP", so non-address tokens (CNAMEs, status text like
    // `NXDOMAIN`) are filtered out — pivoting on them would conflate
    // the IP-pivot affordance with hostname/error pivots.
    const tokens = value
      .split(/[\s,]+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 0 && isIpLiteral(t));
    if (tokens.length === 0) return [];
    const seen = new Set<string>();
    const out: PivotValue[] = [];
    for (const token of tokens) {
      if (seen.has(token)) continue;
      seen.add(token);
      out.push({ key: token, label: token });
    }
    return out;
  },
};

/**
 * Encode the event's typename and exact time-as-ms into the value
 * key. Each event carries a unique key — matching is not done by
 * key intersection (that would only ever match the event with
 * itself) but by `matchSameKindWithin15Min` below, which interprets
 * the key as a center and returns events with the same typename
 * whose time falls within `±TRIAGE_SAME_KIND_WINDOW_MS` of that
 * center. This is what gives the pivot exact ±15-minute membership
 * rather than the bucket-floor approximation that earlier revisions
 * shipped with.
 */
const SAME_KIND_WITHIN_15_MIN_DIMENSION: PivotDimension = {
  id: "sameKindWithin15Min",
  family: "time-structure",
  extract(event) {
    const ms = Date.parse(event.time);
    if (!Number.isFinite(ms)) return [];
    const key = `${event.__typename}@${ms}`;
    const label = `${event.__typename} near ${new Date(ms).toISOString()}`;
    return [{ key, label }];
  },
};

/**
 * Parse a `sameKindWithin15Min` value key back into its components.
 * Returns `null` when the key is malformed (the panel falls back to
 * an empty match set in that case).
 */
export function parseSameKindKey(
  key: string,
): { typename: string; centerMs: number } | null {
  const at = key.lastIndexOf("@");
  if (at <= 0 || at === key.length - 1) return null;
  const typename = key.slice(0, at);
  const ms = Number(key.slice(at + 1));
  if (!Number.isFinite(ms)) return null;
  return { typename, centerMs: ms };
}

/**
 * Resolve the focus-relative event set for a `sameKindWithin15Min`
 * dimension lookup: events with `__typename === typename` whose time
 * is within `±TRIAGE_SAME_KIND_WINDOW_MS` of `centerMs`. The exact
 * ±15-minute membership is what discussion #447 §3.3 calls for; the
 * earlier 30-minute floor produced false positives at the bucket
 * boundary and false negatives across boundaries.
 */
export function eventsWithinSameKindWindow(
  corpus: readonly ScoredTriageEvent[],
  typename: string,
  centerMs: number,
): ScoredTriageEvent[] {
  const out: ScoredTriageEvent[] = [];
  for (const ev of corpus) {
    if (ev.__typename !== typename) continue;
    const t = Date.parse(ev.time);
    if (!Number.isFinite(t)) continue;
    if (Math.abs(t - centerMs) <= TRIAGE_SAME_KIND_WINDOW_MS) {
      out.push(ev);
    }
  }
  return out;
}

const SAME_SENSOR_DIMENSION: PivotDimension = {
  id: "sameSensor",
  family: "time-structure",
  extract(event) {
    const value = nonEmptyString(event.sensor);
    if (!value) return [];
    return [{ key: value, label: value }];
  },
};

const CLUSTER_ID_DIMENSION: PivotDimension = {
  id: "clusterId",
  family: "time-structure",
  policyOnly: true,
  extract(event) {
    const value = nonEmptyString(event.clusterId);
    if (!value) return [];
    return [{ key: value, label: value }];
  },
};

/**
 * Tier-2-only server-filtered dimension: `kinds`. Each event's
 * `__typename` becomes a candidate value; clicking issues a fetch
 * filtered by `EventListFilterInput.kinds`. The schema's `kinds`
 * field is a `RawEventKind!` enum, but the dimension uses the
 * `__typename` literal as the value key — REview's GraphQL layer
 * accepts the spelling that matches the typename.
 */
const KINDS_DIMENSION: PivotDimension = {
  id: "kinds",
  family: "tier2-only",
  tier2Only: true,
  extract(event) {
    const value = nonEmptyString(event.__typename);
    if (!value) return [];
    return [{ key: value, label: value }];
  },
};

/**
 * Tier-2-only server-filtered dimension: `categories`. The value key
 * is the numeric `ThreatCategory` ordinal as a string, so it
 * round-trips through {@link buildTier2Filter} (which parses the int
 * back). The display label is the category enum spelling — operators
 * see `COMMAND_AND_CONTROL`, the Tier 2 filter receives `7`. Events
 * whose `category` is missing from the encoding map (a future schema
 * addition not yet mirrored in `THREAT_CATEGORY_VALUE_BY_KEY`) are
 * dropped so we never emit a value key the filter cannot translate.
 */
const CATEGORIES_DIMENSION: PivotDimension = {
  id: "categories",
  family: "tier2-only",
  tier2Only: true,
  extract(event) {
    const cat = event.category;
    if (cat === null || cat === undefined) return [];
    const ordinal = THREAT_CATEGORY_VALUE_BY_KEY[cat];
    if (ordinal === undefined) return [];
    return [{ key: String(ordinal), label: String(cat) }];
  },
};

const LEVELS_DIMENSION: PivotDimension = {
  id: "levels",
  family: "tier2-only",
  tier2Only: true,
  policyOnly: true,
  extract(event) {
    const value = nonEmptyString(event.level);
    if (!value) return [];
    return [{ key: value, label: value }];
  },
};

/**
 * Ordered list of every Phase 1.A pivot dimension. The panel renders
 * dimensions in this order — most-specific (operator-relevant)
 * dimensions first, structural ones last.
 */
export const PIVOT_DIMENSIONS: readonly PivotDimension[] = [
  ipDimension("externalIp"),
  ipDimension("internalIp"),
  PORT_DIMENSION,
  COUNTRY_DIMENSION,
  REGISTRABLE_DOMAIN_DIMENSION,
  HOST_DIMENSION,
  URI_PATTERN_DIMENSION,
  USER_AGENT_DIMENSION,
  JA3_DIMENSION,
  JA3S_DIMENSION,
  SNI_DIMENSION,
  CERT_SERIAL_DIMENSION,
  CERT_SUBJECT_CN_DIMENSION,
  DNS_QUERY_DIMENSION,
  DNS_ANSWER_DIMENSION,
  SAME_KIND_WITHIN_15_MIN_DIMENSION,
  SAME_SENSOR_DIMENSION,
  CLUSTER_ID_DIMENSION,
  KINDS_DIMENSION,
  CATEGORIES_DIMENSION,
  LEVELS_DIMENSION,
];

const DIMENSION_BY_ID = new Map<PivotDimensionId, PivotDimension>(
  PIVOT_DIMENSIONS.map((d) => [d.id, d]),
);

/**
 * Pivot dimensions that have no `PivotDimension` object in
 * {@link PIVOT_DIMENSIONS} because their values come from a fixed
 * static enum rather than per-event extraction. The Tier 2 panel
 * renders these as a separate static section (see #498).
 */
const STATIC_TIER2_DIMENSION_IDS: ReadonlySet<PivotDimensionId> = new Set([
  "learningMethods",
  "keywords",
] as const satisfies readonly PivotDimensionId[]);

/**
 * `true` when the dimension has no per-event extractor and is
 * surfaced through the panel's static section path instead of
 * `buildPivotPanel()`. Callers that walk the index by id (restore,
 * focus resolution) consult this before calling
 * {@link getPivotDimension} so they do not throw on a known-but-
 * static id.
 */
export function isStaticTier2Dimension(
  id: PivotDimensionId,
): id is "learningMethods" | "keywords" {
  return STATIC_TIER2_DIMENSION_IDS.has(id);
}

export function getPivotDimension(id: PivotDimensionId): PivotDimension {
  const dim = DIMENSION_BY_ID.get(id);
  if (!dim) throw new Error(`Unknown pivot dimension: ${id}`);
  return dim;
}

/**
 * `true` when the dimension reads only fields present on the
 * Baseline-mode corpus row (`baseline_triaged_event` columns plus
 * the addresses/ports it carries). Used by the Tier 1 panel and the
 * pivot index builder to gate Policy-only dimensions when the active
 * mode is `"baseline"`.
 */
export function isDimensionAvailableInBaseline(
  dimension: PivotDimension,
): boolean {
  return dimension.policyOnly !== true;
}

/**
 * The subset of {@link PIVOT_DIMENSIONS} that reads only fields
 * present in `baseline_triaged_event`. The pivot Tier 1 panel and
 * the pivot index builder filter on this list when the active mode
 * is `"baseline"` so the operator never sees a section that cannot
 * produce a value.
 */
export const PIVOT_DIMENSIONS_BASELINE: readonly PivotDimension[] =
  PIVOT_DIMENSIONS.filter(isDimensionAvailableInBaseline);
