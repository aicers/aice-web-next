/**
 * URL hash parser/serializer for Triage menu pivot state.
 *
 * The hash carries the asset focus + each pivot step's dimension and
 * value so a Triage URL is shareable / reload-stable. Hash keys are
 * namespaced under `triage.pivot.*` so #471's `triage.strictness.*`
 * keys (landing in a separate PR) can coexist without collision.
 *
 * Encoding form (location.hash without the leading `#`):
 *
 *     triage.pivot.asset=<address>
 *     &triage.pivot.step=<dimension>:<encoded-value>
 *     &triage.pivot.step=<dimension>:<encoded-value>
 *     &triage.pivot.mode=tier2
 *
 * Steps appear in trail order. The value portion of a step is
 * percent-encoded so colons / ampersands inside a key (e.g. an IPv6
 * literal) don't collide with the separators.
 *
 * Restoration is client-only (Server Components cannot read the
 * URL hash) — see `baseline-content.tsx` for the wire-up.
 */

import type { PivotDimensionId, PivotValue } from "./pivot/dimensions";

/** Triage Tier 1 / Tier 2 mode encoded in the hash. */
export type TriagePivotMode = "tier1" | "tier2";

export interface TriagePivotHashStep {
  dimension: PivotDimensionId;
  /** The pivot value's `key` (the indexable identity). */
  valueKey: string;
}

/**
 * Composite asset focus encoded in the hash. Two customers can host
 * the same RFC1918 address on different perimeters, so the focus key
 * carries `customerId/address`. Hashes produced by an earlier build
 * that wrote a single-component asset (just the address) parse with
 * `customerId === null`; the caller treats those as stale and falls
 * back to the asset root rather than mis-resolving against the first
 * customer's matching address.
 */
export interface TriagePivotAssetFocus {
  customerId: number | null;
  address: string;
}

export interface TriagePivotHashState {
  /** Asset focus (composite `(customerId, address)`); `null` when absent. */
  asset: TriagePivotAssetFocus | null;
  /** Pivot dimension steps in trail order, after the asset root. */
  steps: TriagePivotHashStep[];
  /** Mode toggle state; `null` means "absent" — caller defaults. */
  mode: TriagePivotMode | null;
}

const HASH_PREFIX = "triage.pivot.";
const ASSET_KEY = "triage.pivot.asset";
const STEP_KEY = "triage.pivot.step";
const MODE_KEY = "triage.pivot.mode";

const KNOWN_DIMENSIONS: ReadonlySet<PivotDimensionId> = new Set([
  "externalIp",
  "internalIp",
  "port",
  "country",
  "registrableDomain",
  "host",
  "uriPattern",
  "userAgent",
  "ja3",
  "ja3s",
  "sni",
  "certSerial",
  "certSubjectCn",
  "dnsQuery",
  "dnsAnswer",
  "sameKindWithin15Min",
  "sameSensor",
  "clusterId",
  "kinds",
  "categories",
  "levels",
] as const satisfies readonly PivotDimensionId[]);

function isKnownDimension(value: string): value is PivotDimensionId {
  return KNOWN_DIMENSIONS.has(value as PivotDimensionId);
}

/**
 * Parse a `location.hash` string into a Triage pivot hash state.
 * Unknown keys are ignored — the hash is shared with #471's
 * `triage.strictness.*` namespace and any future Triage hash
 * extensions, so a foreign key must not invalidate the parse.
 *
 * Malformed step entries are dropped silently rather than poisoning
 * the whole hash; the caller falls back to the asset root with a
 * stale-hash toast when the breadcrumb cannot be restored.
 */
export function parseTriagePivotHash(hash: string): TriagePivotHashState {
  const empty: TriagePivotHashState = { asset: null, steps: [], mode: null };
  if (!hash) return empty;
  const trimmed = hash.startsWith("#") ? hash.slice(1) : hash;
  if (trimmed.length === 0) return empty;

  let asset: TriagePivotAssetFocus | null = null;
  let mode: TriagePivotMode | null = null;
  const steps: TriagePivotHashStep[] = [];

  for (const segment of trimmed.split("&")) {
    if (segment.length === 0) continue;
    const eq = segment.indexOf("=");
    if (eq <= 0) continue;
    const key = segment.slice(0, eq);
    const rawValue = segment.slice(eq + 1);
    if (!key.startsWith(HASH_PREFIX)) continue;
    let value: string;
    try {
      value = decodeURIComponent(rawValue);
    } catch {
      continue;
    }
    if (key === ASSET_KEY) {
      const parsed = parseAssetValue(value);
      if (parsed) asset = parsed;
    } else if (key === MODE_KEY) {
      if (value === "tier1" || value === "tier2") mode = value;
    } else if (key === STEP_KEY) {
      const step = parseStepValue(value);
      if (step) steps.push(step);
    }
  }

  return { asset, steps, mode };
}

/**
 * Decode the `triage.pivot.asset` value into its composite shape.
 * Two encodings are accepted:
 *
 *   - `customerId/address` — the current shape. `customerId` parses
 *     as a non-negative integer; `address` is the rest of the value
 *     (preserving any further `/` characters in case a future address
 *     format includes them).
 *   - `address` (no `/`) — legacy single-component shape from URLs
 *     produced before the multi-customer key landed. Returns
 *     `customerId: null` so the caller can render the stale-hash
 *     toast and fall back to the asset root rather than mis-resolving
 *     against the first customer's matching address.
 */
function parseAssetValue(value: string): TriagePivotAssetFocus | null {
  if (value.length === 0) return null;
  const slash = value.indexOf("/");
  if (slash < 0) {
    return { customerId: null, address: value };
  }
  const customerStr = value.slice(0, slash);
  const address = value.slice(slash + 1);
  if (customerStr.length === 0 || address.length === 0) return null;
  // Reject empty / non-numeric / negative customer ids — those would
  // also mis-resolve. They get the same stale-hash treatment as the
  // legacy single-component encoding.
  if (!/^\d+$/.test(customerStr)) return null;
  const customerId = Number.parseInt(customerStr, 10);
  if (!Number.isFinite(customerId) || customerId < 0) return null;
  return { customerId, address };
}

function parseStepValue(value: string): TriagePivotHashStep | null {
  const colon = value.indexOf(":");
  if (colon <= 0 || colon === value.length - 1) return null;
  const dimension = value.slice(0, colon);
  const valueKey = value.slice(colon + 1);
  if (!isKnownDimension(dimension)) return null;
  if (valueKey.length === 0) return null;
  return { dimension, valueKey };
}

/**
 * Serialize a pivot hash state back into a `location.hash` string
 * (without the leading `#`). Empty / null fields are omitted so a
 * fresh menu URL stays tidy.
 *
 * The asset focus is encoded as `customerId/address` whenever a
 * `customerId` is present, falling back to bare `address` only for
 * the legacy single-component round-trip shape (which a freshly-
 * built state should never need).
 */
export function serializeTriagePivotHash(state: TriagePivotHashState): string {
  const entries: string[] = [];
  if (state.asset && state.asset.address.length > 0) {
    const encoded = encodeURIComponent(serializeAssetFocus(state.asset));
    entries.push(`${ASSET_KEY}=${encoded}`);
  }
  for (const step of state.steps) {
    if (!isKnownDimension(step.dimension)) continue;
    if (!step.valueKey || step.valueKey.length === 0) continue;
    const encoded = encodeURIComponent(`${step.dimension}:${step.valueKey}`);
    entries.push(`${STEP_KEY}=${encoded}`);
  }
  if (state.mode !== null) {
    entries.push(`${MODE_KEY}=${encodeURIComponent(state.mode)}`);
  }
  return entries.join("&");
}

function serializeAssetFocus(asset: TriagePivotAssetFocus): string {
  if (asset.customerId === null) return asset.address;
  return `${asset.customerId}/${asset.address}`;
}

/** Build a hash state from breadcrumb steps for serialization. */
export function pivotHashFromTrail(
  trail: ReadonlyArray<
    | { kind: "asset"; customerId: number; address: string }
    | {
        kind: "dimension";
        dimension: PivotDimensionId;
        value: PivotValue;
      }
  >,
  mode: TriagePivotMode | null,
): TriagePivotHashState {
  let asset: TriagePivotAssetFocus | null = null;
  const steps: TriagePivotHashStep[] = [];
  for (const step of trail) {
    if (step.kind === "asset") {
      // The first asset crumb wins; nested asset crumbs are not
      // expected in the Phase 1 trail model but we keep the first
      // for resilience.
      if (asset === null) {
        asset = { customerId: step.customerId, address: step.address };
      }
    } else {
      steps.push({ dimension: step.dimension, valueKey: step.value.key });
    }
  }
  return { asset, steps, mode };
}

/**
 * Update only the `triage.pivot.*` keys inside a hash string,
 * preserving any foreign keys (e.g. #471 strictness keys) so the two
 * features cooperate without overwriting each other.
 */
export function replaceTriagePivotHash(
  existingHash: string,
  state: TriagePivotHashState,
): string {
  const trimmed = existingHash.startsWith("#")
    ? existingHash.slice(1)
    : existingHash;
  const foreign: string[] = [];
  for (const segment of trimmed.split("&")) {
    if (segment.length === 0) continue;
    const eq = segment.indexOf("=");
    const key = eq > 0 ? segment.slice(0, eq) : segment;
    if (!key.startsWith(HASH_PREFIX)) {
      foreign.push(segment);
      continue;
    }
    if (key === ASSET_KEY || key === STEP_KEY || key === MODE_KEY) continue;
    foreign.push(segment);
  }
  const ours = serializeTriagePivotHash(state);
  const merged = [...foreign, ours].filter((s) => s.length > 0).join("&");
  return merged;
}
