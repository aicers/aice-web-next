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

import type { PivotDimensionId } from "./pivot/dimensions";

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
      // `EventListFilterInput.sensors` is `[ID!]`. We never reach
      // here in Phase 1 (the panel hides the row until a triage:read
      // -compatible sensor name→ID lookup exists), but if the click
      // does fire, treat the clicked name literally — REview will
      // either accept it as an opaque ID or reject the query.
      return { ...base, sensors: [valueKey] };
  }
}
