/**
 * Public surface of the engagement-capture module (#588). The client
 * subtree imports from this index so the server-only modules
 * (`hmac.ts`, `storage.ts`, `ingest.ts`, `parse.ts`) stay out of the
 * browser bundle.
 *
 * Only client-safe modules (`types.ts`, `client.ts`) are re-exported
 * here. Server-side callers import the server-only modules directly.
 */

export {
  postEngagementAction,
  postImpressionBatch,
} from "./client";
export {
  ENGAGEMENT_ACTION_RETENTION_DAYS,
  ENGAGEMENT_IMPRESSION_RETENTION_DAYS,
  ENGAGEMENT_JOIN_ID_DIMENSIONS,
  ENGAGEMENT_SURFACE_BASELINE,
  type EngagementAction,
  type EngagementActionType,
  type EngagementAssetSelect,
  type EngagementExclusionCreate,
  type EngagementImpression,
  type EngagementImpressionBatch,
  type EngagementPivotClick,
  type EngagementShownBy,
  type EngagementStoryPivotClick,
  type EngagementStrictnessChange,
  pivotValuePayload,
} from "./types";
