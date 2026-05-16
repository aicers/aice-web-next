/**
 * Engagement-signal capture types (#588 Phase 1).
 *
 * These types are shared between server (storage / endpoint) and
 * client (the fire-and-forget invocation). No `server-only` here so
 * the client wrapper can import them.
 */

import type { StrictnessStopId } from "../strictness/stops";

/** Surface label propagated through every engagement row. */
export const ENGAGEMENT_SURFACE_BASELINE = "baseline";

/** Retention floors (informational mirror of migration comments). */
export const ENGAGEMENT_IMPRESSION_RETENTION_DAYS = 90;
export const ENGAGEMENT_ACTION_RETENTION_DAYS = 180;

export type EngagementShownBy = "quota" | "fallback" | "story_protected";

export type EngagementActionType =
  | "asset_select"
  | "pivot_click"
  | "story_pivot_click"
  | "exclusion_create"
  | "strictness_change";

/**
 * Pivot dimension labels carried on `pivot_click` / `story_pivot_click`
 * action rows. The set mirrors the Triage pivot index dimensions
 * (`src/lib/triage/pivot`) but lives here as a string union for the
 * storage shape — Phase 2 reads pivot-action rows directly without
 * pulling in the pivot module.
 */
export type EngagementPivotDimension = string;

export interface EngagementImpression {
  eventKey: string;
  kind: string;
  slotBucket: string;
  rank: number;
  baselineVersion: string;
  shownBy: EngagementShownBy;
}

export interface EngagementImpressionBatch {
  /** UUID generated client-side; the schema's idempotency key. */
  menuLoadId: string;
  customerId: number;
  surface: string;
  strictnessStop: StrictnessStopId;
  periodStartIso: string;
  periodEndIso: string;
  impressions: ReadonlyArray<EngagementImpression>;
}

/**
 * Wire shape — the client sends the raw asset address (the same
 * value used as the row's `orig_addr` lookup key). The server
 * normalizes + HMACs before any storage write; the raw value never
 * lands on disk in this store.
 */
export interface EngagementAssetSelect {
  type: "asset_select";
  customerId: number;
  surface: string;
  assetAddress: string;
}

/**
 * Wire shape — the client sends either:
 *   * `pivotValueJoinId` for dimensions whose value is itself a
 *     server-side id (no HMAC needed; the join key is the join key);
 *   * `pivotValue` (raw) for dimensions whose value is raw-ish
 *     (IP, domain, JA3, SNI, country, generic). The server picks the
 *     right normalizer from `dimension` and stores the resulting
 *     HMAC on `pivot_value_hmac`.
 *
 * Exactly one of `pivotValueJoinId` / `pivotValue` is required.
 */
export interface EngagementPivotClick {
  type: "pivot_click";
  customerId: number;
  surface: string;
  eventKey: string;
  kind: string;
  baselineVersion: string;
  dimension: EngagementPivotDimension;
  pivotValueJoinId?: string;
  pivotValue?: string;
}

export interface EngagementStoryPivotClick {
  type: "story_pivot_click";
  customerId: number;
  surface: string;
  eventKey: string;
  kind: string;
  baselineVersion: string;
  storyId: string;
  dimension: EngagementPivotDimension;
  pivotValueJoinId?: string;
  pivotValue?: string;
}

export interface EngagementExclusionCreate {
  type: "exclusion_create";
  customerId: number;
  surface: string;
  exclusionId: string;
}

export interface EngagementStrictnessChange {
  type: "strictness_change";
  customerId: number;
  surface: string;
  strictnessFrom: StrictnessStopId;
  strictnessTo: StrictnessStopId;
}

export type EngagementAction =
  | EngagementAssetSelect
  | EngagementPivotClick
  | EngagementStoryPivotClick
  | EngagementExclusionCreate
  | EngagementStrictnessChange;
