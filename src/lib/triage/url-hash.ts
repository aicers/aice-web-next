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
 *     &triage.pivot.story=<customerId>/<storyId>
 *     &triage.pivot.step=<dimension>:<encoded-value>
 *     &triage.pivot.step=<dimension>:<encoded-value>
 *     &triage.pivot.mode=tier2
 *     &triage.tab=stories
 *     &triage.story=<customerId>/<storyId>
 *
 * Steps appear in trail order. The value portion of a step is
 * percent-encoded so colons / ampersands inside a key (e.g. an IPv6
 * literal) don't collide with the separators.
 *
 * Stories tab state (#490) lives in a sibling namespace
 * (`triage.tab=stories` + optional `triage.story=customerId/storyId`)
 * so the existing `triage.pivot.*` parsing path is unaffected. A
 * `triage.story=<id>` value missing the `customerId/` prefix is
 * treated as stale: the caller renders the Stories list root and
 * surfaces a "Stale Story link — open from the list" toast.
 *
 * Pivot-from-Story (#553) carries a separate `triage.pivot.story`
 * marker under the pivot namespace so the Pivot-origin survives a
 * Stories↔Pivot tab swap. `triage.story` (Stories tab focus) clears
 * on the tab swap by design, but `triage.pivot.story` must persist —
 * splitting the two keys keeps each consumer's clear-on-swap rules
 * independent of the other's.
 *
 * Restoration is client-only (Server Components cannot read the
 * URL hash) — see `baseline-content.tsx` for the wire-up.
 */

import { MAX_KEYWORD_LENGTH } from "./keywords";
import { isLearningMethodValue } from "./learning-methods";
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
 * carries `customerId/address`. A bare address (no `customerId/`) is
 * rejected at parse time rather than mis-resolving against the first
 * customer's matching address.
 */
export interface TriagePivotAssetFocus {
  customerId: number;
  address: string;
}

/**
 * Composite Story focus encoded in the Pivot-origin marker
 * (`triage.pivot.story`) added by #553. Same `(customerId, storyId)`
 * shape as the Stories-tab focus, but kept under the `triage.pivot.*`
 * namespace so it persists across a Stories↔Pivot tab swap (the
 * Stories tab clears `triage.story` on swap by design). A bare
 * `storyId` (no `customerId/`) is rejected because `event_group.id`
 * is `BIGSERIAL` per tenant DB.
 */
export interface TriagePivotStoryOrigin {
  customerId: number;
  storyId: string;
}

export interface TriagePivotHashState {
  /** Asset focus (composite `(customerId, address)`); `null` when absent. */
  asset: TriagePivotAssetFocus | null;
  /**
   * Story-origin marker (#553). When non-null the trail is rooted at
   * a Story rather than an asset — the asset crumb is absent and the
   * pivot panel reads the Story's member events as its corpus.
   */
  story: TriagePivotStoryOrigin | null;
  /** Pivot dimension steps in trail order, after the asset root. */
  steps: TriagePivotHashStep[];
  /** Mode toggle state; `null` means "absent" — caller defaults. */
  mode: TriagePivotMode | null;
  /**
   * Count of `triage.pivot.step` segments that were present in the
   * hash but could not be turned into a valid step (unknown dimension,
   * empty value, static-options enum miss). Distinguishes "no step in
   * URL" from "step was present but invalid" so the caller can surface
   * the stale-hash toast for the latter (#498 negative-path
   * requirement).
   */
  rejectedStepCount: number;
  /**
   * `true` when a `triage.pivot.story=...` value was present but
   * rejected (bare storyId, empty halves, non-numeric customerId).
   * Treated like a rejected step on restore — the caller surfaces the
   * stale-hash toast and falls back to the asset root.
   */
  storyOriginStaleHash: boolean;
}

const HASH_PREFIX = "triage.pivot.";
const ASSET_KEY = "triage.pivot.asset";
const STORY_ORIGIN_KEY = "triage.pivot.story";
const STEP_KEY = "triage.pivot.step";
const MODE_KEY = "triage.pivot.mode";

const TAB_KEY = "triage.tab";
const STORY_KEY = "triage.story";

/**
 * Discriminator for the active Triage subview inside Baseline mode.
 * The default value (`asset-list`) is implicit — absence in the hash
 * means "asset list", same as the Phase 1.A landing tab.
 */
export type TriageTabId = "asset-list" | "stories" | "pivot";

/**
 * Composite Story focus encoded in the hash (#490). `customerId` is
 * mandatory because `event_group.id` is `BIGSERIAL` per tenant DB. A
 * bare `storyId` (no `customerId/`) is rejected at parse time so the
 * consumer renders the stale-hash fallback toast.
 */
export interface TriageStoryHashFocus {
  customerId: number;
  storyId: string;
}

export interface TriageStoriesHashState {
  /** `null` when the hash has no `triage.tab=...` key (caller defaults). */
  tab: TriageTabId | null;
  /** `null` when no `triage.story=...` key is present. */
  story: TriageStoryHashFocus | null;
  /**
   * `true` when a `triage.story=...` value was present but rejected
   * (bare storyId, empty halves, non-numeric customerId). The caller
   * surfaces the stale-hash toast in that case.
   */
  storyStaleHash: boolean;
}

const KNOWN_TABS: ReadonlySet<TriageTabId> = new Set([
  "asset-list",
  "stories",
  "pivot",
]);

function isKnownTab(value: string): value is TriageTabId {
  return KNOWN_TABS.has(value as TriageTabId);
}

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
  "sshClient",
  "sshServer",
  "sshHassh",
  "sshHasshServer",
  "smbPath",
  "smbService",
  "smbFileName",
  "ftpCommand",
  "ldapOpcode",
  "ldapObject",
  "ldapArgument",
  "mqttSubscribe",
  "sameKindWithin15Min",
  "sameSensor",
  "clusterId",
  "kinds",
  "categories",
  "levels",
  "learningMethods",
  "keywords",
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
  const empty: TriagePivotHashState = {
    asset: null,
    story: null,
    steps: [],
    mode: null,
    rejectedStepCount: 0,
    storyOriginStaleHash: false,
  };
  if (!hash) return empty;
  const trimmed = hash.startsWith("#") ? hash.slice(1) : hash;
  if (trimmed.length === 0) return empty;

  let asset: TriagePivotAssetFocus | null = null;
  let story: TriagePivotStoryOrigin | null = null;
  let storyOriginStaleHash = false;
  let mode: TriagePivotMode | null = null;
  const steps: TriagePivotHashStep[] = [];
  let rejectedStepCount = 0;

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
      // A `triage.pivot.step` with an undecodable percent-escape is a
      // present-but-invalid step — count it so the caller falls back
      // to the asset root with the stale-hash toast.
      if (key === STEP_KEY) rejectedStepCount += 1;
      if (key === STORY_ORIGIN_KEY) storyOriginStaleHash = true;
      continue;
    }
    if (key === ASSET_KEY) {
      const parsed = parseAssetValue(value);
      if (parsed) asset = parsed;
    } else if (key === STORY_ORIGIN_KEY) {
      const parsed = parseStoryOriginValue(value);
      if (parsed) {
        story = parsed;
      } else {
        storyOriginStaleHash = true;
      }
    } else if (key === MODE_KEY) {
      if (value === "tier1" || value === "tier2") mode = value;
    } else if (key === STEP_KEY) {
      const step = parseStepValue(value);
      if (step) {
        steps.push(step);
      } else {
        rejectedStepCount += 1;
      }
    }
  }

  return {
    asset,
    story,
    steps,
    mode,
    rejectedStepCount,
    storyOriginStaleHash,
  };
}

/**
 * Decode the `triage.pivot.story` value into the composite Story
 * origin. Mirrors the validation rules of {@link parseStoryFocus}:
 * `customerId` must be numeric and non-negative, `storyId` must be
 * numeric (matches `event_group.id`'s BIGSERIAL serialization), and a
 * bare `storyId` (no `customerId/`) is rejected because two tenants
 * can host the same id.
 */
function parseStoryOriginValue(value: string): TriagePivotStoryOrigin | null {
  if (value.length === 0) return null;
  const slash = value.indexOf("/");
  if (slash < 0) return null;
  const customerStr = value.slice(0, slash);
  const storyId = value.slice(slash + 1);
  if (customerStr.length === 0 || storyId.length === 0) return null;
  if (!/^\d+$/.test(customerStr)) return null;
  if (!/^\d+$/.test(storyId)) return null;
  const customerId = Number.parseInt(customerStr, 10);
  if (!Number.isFinite(customerId) || customerId < 0) return null;
  return { customerId, storyId };
}

/**
 * Decode the `triage.pivot.asset` value into its composite
 * `customerId/address` shape. `customerId` parses as a non-negative
 * integer; `address` is the rest of the value (preserving any further
 * `/` characters in case a future address format includes them). A
 * bare address (no `/`) is rejected like any other malformed value.
 */
function parseAssetValue(value: string): TriagePivotAssetFocus | null {
  if (value.length === 0) return null;
  const slash = value.indexOf("/");
  if (slash < 0) return null;
  const customerStr = value.slice(0, slash);
  const address = value.slice(slash + 1);
  if (customerStr.length === 0 || address.length === 0) return null;
  // Reject empty / non-numeric / negative customer ids — those would
  // mis-resolve against the wrong tenant.
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
  // Static-options dimensions whitelist their value keys here so a
  // shared URL with `learningMethods:UNSUPERVISED` parses, but
  // `learningMethods:INVALID_VALUE` falls through to the asset-root
  // fallback (#498). The URL is the only place an arbitrary string
  // can reach `Tier2Dimension`'s `learningMethods` arm without the
  // panel's static-section button — without this guard, REview would
  // reject a typo'd enum literal at the GraphQL layer and the
  // operator would see the generic error banner instead of the
  // stale-hash toast.
  if (dimension === "learningMethods" && !isLearningMethodValue(valueKey)) {
    return null;
  }
  // Free-text `keywords` (#499) — the parser still enforces the
  // submit-time max length so a shared URL with an oversized blob is
  // treated as stale rather than reaching the Tier 2 fetch path. The
  // panel's submit handler applies the same ceiling, so a legitimate
  // shared link is always under the cap by construction.
  if (dimension === "keywords" && valueKey.length > MAX_KEYWORD_LENGTH) {
    return null;
  }
  return { dimension, valueKey };
}

/**
 * Serialize a pivot hash state back into a `location.hash` string
 * (without the leading `#`). Empty / null fields are omitted so a
 * fresh menu URL stays tidy. The asset focus is encoded as
 * `customerId/address`.
 */
export function serializeTriagePivotHash(state: TriagePivotHashState): string {
  const entries: string[] = [];
  if (state.asset && state.asset.address.length > 0) {
    const encoded = encodeURIComponent(serializeAssetFocus(state.asset));
    entries.push(`${ASSET_KEY}=${encoded}`);
  }
  if (state.story) {
    const value = `${state.story.customerId}/${state.story.storyId}`;
    entries.push(`${STORY_ORIGIN_KEY}=${encodeURIComponent(value)}`);
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
  return `${asset.customerId}/${asset.address}`;
}

/**
 * Build a hash state from breadcrumb steps for serialization.
 *
 * `storyOrigin` (added by #553) is the Pivot-origin marker for the
 * Story-rooted trail. When non-null the trail has no asset crumb —
 * only dimension steps — and the asset-root assumption documented at
 * top of file is replaced by Story-member-set seeding.
 */
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
  storyOrigin: TriagePivotStoryOrigin | null = null,
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
  return {
    asset,
    story: storyOrigin,
    steps,
    mode,
    rejectedStepCount: 0,
    storyOriginStaleHash: false,
  };
}

/**
 * Parse the Stories-tab segments out of a hash string. Foreign keys
 * (`triage.pivot.*`, `triage.strictness.*`) are ignored — the caller
 * runs {@link parseTriagePivotHash} separately when it needs the
 * pivot state too.
 *
 * A `triage.story=<value>` segment where `<value>` lacks the
 * mandatory `customerId/` prefix is rejected (`storyStaleHash = true`)
 * because two tenants can host the same `event_group.id`; falling
 * back to "open whichever tenant has that id" would mis-resolve.
 */
export function parseTriageStoriesHash(hash: string): TriageStoriesHashState {
  const empty: TriageStoriesHashState = {
    tab: null,
    story: null,
    storyStaleHash: false,
  };
  if (!hash) return empty;
  const trimmed = hash.startsWith("#") ? hash.slice(1) : hash;
  if (trimmed.length === 0) return empty;

  let tab: TriageTabId | null = null;
  let story: TriageStoryHashFocus | null = null;
  let storyStaleHash = false;

  for (const segment of trimmed.split("&")) {
    if (segment.length === 0) continue;
    const eq = segment.indexOf("=");
    if (eq <= 0) continue;
    const key = segment.slice(0, eq);
    const rawValue = segment.slice(eq + 1);
    let value: string;
    try {
      value = decodeURIComponent(rawValue);
    } catch {
      if (key === STORY_KEY) storyStaleHash = true;
      continue;
    }
    if (key === TAB_KEY) {
      if (isKnownTab(value)) tab = value;
    } else if (key === STORY_KEY) {
      const parsed = parseStoryFocus(value);
      if (parsed === null) {
        storyStaleHash = true;
      } else {
        story = parsed;
      }
    }
  }

  return { tab, story, storyStaleHash };
}

function parseStoryFocus(value: string): TriageStoryHashFocus | null {
  if (value.length === 0) return null;
  const slash = value.indexOf("/");
  if (slash < 0) return null;
  const customerStr = value.slice(0, slash);
  const storyId = value.slice(slash + 1);
  if (customerStr.length === 0 || storyId.length === 0) return null;
  if (!/^\d+$/.test(customerStr)) return null;
  if (!/^\d+$/.test(storyId)) return null;
  const customerId = Number.parseInt(customerStr, 10);
  if (!Number.isFinite(customerId) || customerId < 0) return null;
  return { customerId, storyId };
}

/**
 * Serialize the Stories tab segments back into a hash fragment
 * (without the leading `#`). Stable ordering: `triage.tab` first,
 * then optional `triage.story`. Empty / null fields are omitted.
 */
export function serializeTriageStoriesHash(
  state: TriageStoriesHashState,
): string {
  const entries: string[] = [];
  if (state.tab !== null) {
    entries.push(`${TAB_KEY}=${encodeURIComponent(state.tab)}`);
  }
  if (state.story) {
    const value = `${state.story.customerId}/${state.story.storyId}`;
    entries.push(`${STORY_KEY}=${encodeURIComponent(value)}`);
  }
  return entries.join("&");
}

/**
 * Update only the `triage.tab` / `triage.story` keys inside a hash
 * string, preserving every other segment (including the entire
 * `triage.pivot.*` block and any future Triage namespace).
 */
export function replaceTriageStoriesHash(
  existingHash: string,
  state: TriageStoriesHashState,
): string {
  const trimmed = existingHash.startsWith("#")
    ? existingHash.slice(1)
    : existingHash;
  const foreign: string[] = [];
  for (const segment of trimmed.split("&")) {
    if (segment.length === 0) continue;
    const eq = segment.indexOf("=");
    const key = eq > 0 ? segment.slice(0, eq) : segment;
    if (key === TAB_KEY || key === STORY_KEY) continue;
    foreign.push(segment);
  }
  const ours = serializeTriageStoriesHash(state);
  const merged = [...foreign, ours].filter((s) => s.length > 0).join("&");
  return merged;
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
    if (
      key === ASSET_KEY ||
      key === STORY_ORIGIN_KEY ||
      key === STEP_KEY ||
      key === MODE_KEY
    )
      continue;
    foreign.push(segment);
  }
  const ours = serializeTriagePivotHash(state);
  const merged = [...foreign, ours].filter((s) => s.length > 0).join("&");
  return merged;
}

const STRICTNESS_STOP_KEY = "triage.strictness.stop";

/**
 * Parse the strictness slider stop id out of a hash string (#471).
 * Returns `null` when the key is absent so the caller can apply its
 * own precedence (`?strictness=` query param > hash > localStorage >
 * default). When the key is present, the raw (decoded) value is
 * returned even for unknown ids — the caller's precedence chain
 * decides the fallback rather than this parser collapsing unknowns
 * to `null`.
 */
export function parseTriageStrictnessHash(hash: string): string | null {
  if (!hash) return null;
  const trimmed = hash.startsWith("#") ? hash.slice(1) : hash;
  if (trimmed.length === 0) return null;
  for (const segment of trimmed.split("&")) {
    if (segment.length === 0) continue;
    const eq = segment.indexOf("=");
    if (eq <= 0) continue;
    const key = segment.slice(0, eq);
    if (key !== STRICTNESS_STOP_KEY) continue;
    try {
      return decodeURIComponent(segment.slice(eq + 1));
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Update only the `triage.strictness.stop` key inside a hash string,
 * preserving every other segment (`triage.pivot.*`, `triage.tab`,
 * `triage.story`). `stopId = null` clears the key entirely so a
 * default-stop reload does not write a redundant segment back into
 * the URL.
 */
export function replaceTriageStrictnessHash(
  existingHash: string,
  stopId: string | null,
): string {
  const trimmed = existingHash.startsWith("#")
    ? existingHash.slice(1)
    : existingHash;
  const foreign: string[] = [];
  for (const segment of trimmed.split("&")) {
    if (segment.length === 0) continue;
    const eq = segment.indexOf("=");
    const key = eq > 0 ? segment.slice(0, eq) : segment;
    if (key === STRICTNESS_STOP_KEY) continue;
    foreign.push(segment);
  }
  const entries =
    stopId === null
      ? foreign
      : [...foreign, `${STRICTNESS_STOP_KEY}=${encodeURIComponent(stopId)}`];
  return entries.filter((s) => s.length > 0).join("&");
}
