/**
 * Build a Tier 2 `EventListFilterInput` for a single pivot dimension
 * value (discussion #447 §3.3).
 *
 * Tier 2 dimensions split into three classes:
 *
 *   - **Server-filtered, Tier-2-only.** `kinds`, `categories`,
 *     `levels`, `learningMethods`, `keywords` — these have no Tier 1
 *     extractor and exist only in Tier 2 mode. The clicked value
 *     becomes the corresponding `EventListFilterInput.*` array.
 *   - **Server-filtered, Tier-1-overlapping.** `externalIp`,
 *     `internalIp`, `country` — same dimension row in both modes;
 *     the click action differs by mode. `sameSensor` is also in this
 *     class but the panel hides it until a `triage:read`-compatible
 *     sensor lookup exists (see issue #453).
 *   - **Client-intersection.** `ja3`, `ja3s`, `sni`, `host`, …
 *     — computed against the corpus + prior Tier 2 results, no
 *     extra round-trips. The fetch hook never reaches this module
 *     for these dimensions.
 *
 * IP filter mapping note: `externalIp` / `internalIp` are
 * side-agnostic in Tier 1 (extract from both `origAddr` and
 * `respAddr`). Tier 2 preserves that semantics by emitting one
 * `EndpointInput` with `direction: null` and the clicked address
 * packed into `custom: HostNetworkGroupInput`.
 */

import type {
  EventListFilterInput,
  HostNetworkGroupInput,
} from "@/lib/detection";
import { THREAT_CATEGORY_VALUE_BY_KEY } from "@/lib/detection/filter-options";

import { classifyTriageEndpoint } from "./classify";
import type { PivotDimensionId } from "./pivot/dimensions";
import type { TriageEvent } from "./types";

/**
 * Pivot dimensions that map to a Tier 2 server-side filter. Anything
 * outside this set is a client-intersection dimension — Tier 2 still
 * uses the cached/loaded events to populate it but no fresh round-
 * trip is issued.
 */
export type Tier2Dimension =
  | "kinds"
  | "categories"
  | "levels"
  | "learningMethods"
  | "keywords"
  | "externalIp"
  | "internalIp"
  | "country"
  | "sameSensor";

/** `true` when the dimension fetches against REview in Tier 2 mode. */
export function isTier2ServerDimension(
  id: PivotDimensionId | Tier2Dimension,
): id is Tier2Dimension {
  return TIER2_SERVER_DIMENSIONS.has(id as Tier2Dimension);
}

// `sameSensor` is included here as of #502: the Tier 2 sensor pivot
// resolves the sensor *name* to REview's opaque `nodeId` against the
// shared {@link listSensors} lookup (relaxed to `triage:read |
// detection:read`) before invoking {@link buildTier2Filter}, so the
// `case "sameSensor"` arm now sees the resolved `nodeId` as
// `valueKey`. URL-hash restore re-issues the same resolution path,
// and a name that does not resolve within the asset's customer scope
// falls back to the asset root with the stale-name toast.
const TIER2_SERVER_DIMENSIONS: ReadonlySet<Tier2Dimension> = new Set([
  "kinds",
  "categories",
  "levels",
  "learningMethods",
  "keywords",
  "externalIp",
  "internalIp",
  "country",
  "sameSensor",
] as const satisfies readonly Tier2Dimension[]);

interface BuildTier2FilterArgs {
  /** Period bounds — always carried so retention windows match. */
  periodStartIso: string;
  periodEndIso: string;
  dimension: Tier2Dimension;
  /**
   * The clicked pivot value's `key`. For `country` this is an
   * uppercase ISO-2 string; for IP dimensions it is a literal
   * address; for `kinds` / `categories` / `levels` / `learningMethods`
   * it is the enum spelling REview's GraphQL schema accepts.
   */
  valueKey: string;
}

/**
 * Convert a single (dimension, valueKey) into an
 * {@link EventListFilterInput}. Returns `null` when the value cannot
 * be coerced into a legal filter shape (e.g. a non-IP literal for
 * an IP dimension); the caller treats `null` as "skip the fetch".
 */
export function buildTier2Filter(
  args: BuildTier2FilterArgs,
): EventListFilterInput | null {
  const { periodStartIso, periodEndIso, dimension, valueKey } = args;
  const base: EventListFilterInput = {
    start: periodStartIso,
    end: periodEndIso,
  };
  switch (dimension) {
    case "kinds":
      return { ...base, kinds: [valueKey] };
    case "levels":
      // `levels` is a `ThreatLevel[]` enum on the schema; pass the
      // string through — REview will reject unknown values with a
      // GraphQL-level error, which the BFF surfaces as the generic
      // banner.
      return { ...base, levels: [valueKey as never] };
    case "learningMethods":
      return { ...base, learningMethods: [valueKey as never] };
    case "categories": {
      const n = Number.parseInt(valueKey, 10);
      if (!Number.isFinite(n)) return null;
      return { ...base, categories: [n] };
    }
    case "keywords":
      return { ...base, keywords: [valueKey] };
    case "country":
      return { ...base, countries: [valueKey] };
    case "externalIp":
    case "internalIp": {
      const host = valueKey.trim();
      if (host.length === 0) return null;
      const custom: HostNetworkGroupInput = {
        hosts: [host],
        networks: [],
        ranges: [],
      };
      return {
        ...base,
        endpoints: [{ direction: null, custom }],
      };
    }
    case "sameSensor":
      // `EventListFilterInput.sensors` is `[ID!]`. The async caller
      // (`fetchTier2DimensionWithSession`) resolves the sensor name
      // to REview's opaque `nodeId` against {@link listSensors},
      // keyed on `(name, customerId)`, and passes that resolved id as
      // `valueKey` so the literal sensor name never reaches REview as
      // an `ID`.
      return { ...base, sensors: [valueKey] };
  }
}

/**
 * Per-event Tier 2 predicate (#561). Returns `true` when `event` would
 * be matched by the {@link buildTier2Filter} `(dimension, valueKey)`
 * pair under REview's server-side semantics.
 *
 * The Story-member resolver fetches each member event by id and
 * applies this predicate in-app rather than walking REview's universe-
 * wide `eventList(filter)` stream — that walk would only stop after
 * every member appeared in the filtered stream, which for high-
 * cardinality / partially-matching pivots either runs to the universe
 * page tail (slow + risks dropping members past the walk-cap) or
 * truncates wrongly when unrelated members never satisfy the filter.
 *
 * Matching rules mirror the {@link buildTier2Filter} encoding:
 *
 *   - `kinds` — `event.__typename === valueKey` (the server filter
 *     accepts the typename spelling per the `kinds` dimension docs).
 *   - `categories` — `THREAT_CATEGORY_VALUE_BY_KEY[event.category]`
 *     equals the parsed integer `valueKey` (symmetric to the filter
 *     building, which packs the ordinal as `categories: [n]`).
 *   - `levels` — `event.level === valueKey` (the schema enum literal).
 *   - `learningMethods` — `event.learningMethod === valueKey`. Subtypes
 *     without the field are dropped.
 *   - `keywords` — case-insensitive substring match across operator-
 *     meaningful textual fields (host, uri, query, answer, sensor,
 *     subtype-specific identifiers). Best-effort approximation of
 *     REview's keyword filter, which the issue's "Out of scope" notes
 *     would be replaced cleanly by an upstream `event_key IN (…)`
 *     filter on `EventListFilterInput`. Documented inline so a future
 *     consolidation issue can swap this branch out.
 *   - `country` — case-insensitive match on `origCountry` or
 *     `respCountry`.
 *   - `externalIp` / `internalIp` — classify each side via
 *     {@link classifyTriageEndpoint}; match when the side's address
 *     equals `valueKey` and the side falls on the requested half of
 *     the perimeter classification.
 *   - `sameSensor` — `event.sensor === valueKey`. The cohort branch
 *     skips the `listSensors()` name → `nodeId` resolution
 *     (`fetchTier2DimensionWithSession` documents the bypass), so this
 *     predicate matches the literal sensor *name* on the event payload.
 */
export function tier2MatchesEvent(
  event: TriageEvent,
  dimension: Tier2Dimension,
  valueKey: string,
): boolean {
  switch (dimension) {
    case "kinds":
      return event.__typename === valueKey;
    case "categories": {
      const cat = event.category;
      if (cat === null || cat === undefined) return false;
      const ordinal = THREAT_CATEGORY_VALUE_BY_KEY[cat];
      if (ordinal === undefined) return false;
      return String(ordinal) === valueKey;
    }
    case "levels":
      return typeof event.level === "string" && event.level === valueKey;
    case "learningMethods":
      return (
        typeof event.learningMethod === "string" &&
        event.learningMethod === valueKey
      );
    case "keywords": {
      const needle = valueKey.toLowerCase();
      if (needle.length === 0) return false;
      return KEYWORD_HAYSTACK_FIELDS.some((pick) => {
        const raw = pick(event);
        if (typeof raw === "string") {
          return raw.toLowerCase().includes(needle);
        }
        if (Array.isArray(raw)) {
          return raw.some(
            (entry) =>
              typeof entry === "string" && entry.toLowerCase().includes(needle),
          );
        }
        return false;
      });
    }
    case "country": {
      const target = valueKey.toUpperCase();
      const orig = event.origCountry?.toUpperCase() ?? null;
      const resp = event.respCountry?.toUpperCase() ?? null;
      return orig === target || resp === target;
    }
    case "externalIp":
    case "internalIp": {
      const wantInternal = dimension === "internalIp";
      for (const side of ["orig", "resp"] as const) {
        const addr =
          side === "orig" ? (event.origAddr ?? null) : (event.respAddr ?? null);
        if (typeof addr !== "string" || addr.length === 0) continue;
        if (addr !== valueKey) continue;
        const klass = classifyTriageEndpoint(event, side);
        if (klass === "unknown") continue;
        if ((klass === "internal") === wantInternal) return true;
      }
      return false;
    }
    case "sameSensor":
      return event.sensor === valueKey;
  }
}

/**
 * Textual fields the `keywords` predicate scans. Picked to mirror the
 * operator-meaningful content REview's keyword filter typically
 * matches against — content payload (host / uri / query / answer /
 * subtype-specific identifiers), the sensor name, and the event
 * typename. The list is intentionally narrow: matching against every
 * scalar would surface false positives on stable identifiers (event
 * id, cluster id) that are not part of the operator's mental model.
 */
const KEYWORD_HAYSTACK_FIELDS: ReadonlyArray<
  (event: TriageEvent) => string | readonly string[] | null | undefined
> = [
  (e) => e.__typename,
  (e) => e.sensor,
  (e) => e.host,
  (e) => e.uri,
  (e) => e.userAgent,
  (e) => e.query,
  (e) => e.answer,
  (e) => e.serverName,
  (e) => e.subjectCommonName,
  (e) => e.sshClient,
  (e) => e.sshServer,
  (e) => e.smbPath,
  (e) => e.smbService,
  (e) => e.smbFileName,
  (e) => e.ftpCommands?.map((c) => c.command),
  (e) => e.ldapOpcode,
  (e) => e.ldapObject,
  (e) => e.ldapArgument,
  (e) => e.mqttSubscribe,
];
