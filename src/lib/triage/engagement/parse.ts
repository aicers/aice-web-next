/**
 * Body-shape validation for the engagement endpoint. Lives in its
 * own module so the route handler stays small and the parser can be
 * unit-tested without standing up Next.
 *
 * The parser is intentionally strict: anything not on the documented
 * shape is rejected with a 400, even if it would otherwise be a
 * harmless extra field. Engagement signals are long-lived analytics
 * — a permissive parser would silently accept malformed rows that
 * Phase 2 cannot read.
 */

import { parseStrictnessStopId } from "../strictness/stops";
import {
  ENGAGEMENT_JOIN_ID_DIMENSIONS,
  type EngagementAction,
  type EngagementImpression,
  type EngagementImpressionBatch,
  type EngagementShownBy,
} from "./types";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const SHOWN_BY: ReadonlySet<EngagementShownBy> = new Set([
  "quota",
  "fallback",
  "story_protected",
]);
const MAX_IMPRESSIONS_PER_BATCH = 10_000;

export class EngagementValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngagementValidationError";
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function requireString(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new EngagementValidationError(`Missing or invalid ${key}`);
  }
  return v;
}

function optionalString(
  o: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || v.length === 0) {
    throw new EngagementValidationError(`Invalid ${key}`);
  }
  return v;
}

function requireUuid(o: Record<string, unknown>, key: string): string {
  const v = requireString(o, key);
  if (!UUID_RE.test(v)) {
    throw new EngagementValidationError(`Invalid ${key} (expected UUID)`);
  }
  return v;
}

function requireIsoTs(o: Record<string, unknown>, key: string): string {
  const v = requireString(o, key);
  if (!ISO_TS_RE.test(v)) {
    throw new EngagementValidationError(
      `Invalid ${key} (expected ISO-8601 timestamp)`,
    );
  }
  return v;
}

function requireInt(o: Record<string, unknown>, key: string): number {
  const v = o[key];
  if (typeof v !== "number" || !Number.isInteger(v)) {
    throw new EngagementValidationError(`Missing or invalid ${key}`);
  }
  return v;
}

function requirePositiveInt(o: Record<string, unknown>, key: string): number {
  const v = requireInt(o, key);
  if (v <= 0) {
    throw new EngagementValidationError(`${key} must be > 0`);
  }
  return v;
}

/**
 * Pull and validate the `pivotValueJoinId` / `pivotValue` pair from a
 * pivot-action payload. Enforces the documented contract in both
 * directions:
 *
 *  1. Exactly one of the two fields must be present.
 *  2. Allowlisted natural-join dimensions
 *     ({@link ENGAGEMENT_JOIN_ID_DIMENSIONS}) MUST use
 *     `pivotValueJoinId`. Posting `{ dimension: "sameSensor",
 *     pivotValue: "sensor-alpha" }` is rejected so a stale client
 *     cannot accidentally HMAC a value that should have been stored as
 *     the raw join id (which Phase 2 reads as a join key).
 *  3. Every other (raw-ish: IP, domain, JA3, SNI, country, free-text)
 *     dimension MUST route through HMAC via `pivotValue`. A bug or
 *     stale client posting `{ dimension: "sni", pivotValueJoinId:
 *     "Example.COM" }` is rejected so a raw value never lands in
 *     `engagement_action.pivot_value_join_id`.
 *
 * Together these guards are the server-side enforcement of #588's
 * privacy acceptance and Phase 2's join-key contract: every pivot row
 * lands in exactly the column its dimension owns, regardless of
 * client-side drift.
 */
function parsePivotValueFields(
  payload: Record<string, unknown>,
  dimension: string,
): { pivotValueJoinId: string | undefined; pivotValue: string | undefined } {
  const pivotValueJoinId = optionalString(payload, "pivotValueJoinId");
  const pivotValue = optionalString(payload, "pivotValue");
  if (
    (pivotValueJoinId === undefined && pivotValue === undefined) ||
    (pivotValueJoinId !== undefined && pivotValue !== undefined)
  ) {
    throw new EngagementValidationError(
      "Exactly one of pivotValueJoinId or pivotValue is required",
    );
  }
  const isJoinIdDimension = ENGAGEMENT_JOIN_ID_DIMENSIONS.has(dimension);
  if (pivotValueJoinId !== undefined && !isJoinIdDimension) {
    throw new EngagementValidationError(
      `Dimension "${dimension}" is raw-ish; use pivotValue (HMAC path) instead of pivotValueJoinId`,
    );
  }
  if (pivotValue !== undefined && isJoinIdDimension) {
    throw new EngagementValidationError(
      `Dimension "${dimension}" is a natural-join dimension; use pivotValueJoinId instead of pivotValue`,
    );
  }
  return { pivotValueJoinId, pivotValue };
}

function parseImpression(o: unknown): EngagementImpression {
  if (!isObject(o)) {
    throw new EngagementValidationError("Invalid impression entry");
  }
  const shownBy = requireString(o, "shownBy");
  if (!SHOWN_BY.has(shownBy as EngagementShownBy)) {
    throw new EngagementValidationError(`Invalid shownBy "${shownBy}"`);
  }
  return {
    eventKey: requireString(o, "eventKey"),
    kind: requireString(o, "kind"),
    slotBucket: requireString(o, "slotBucket"),
    rank: requirePositiveInt(o, "rank"),
    baselineVersion: requireString(o, "baselineVersion"),
    shownBy: shownBy as EngagementShownBy,
  };
}

export function parseImpressionBatch(raw: unknown): EngagementImpressionBatch {
  if (!isObject(raw)) {
    throw new EngagementValidationError("Body must be a JSON object");
  }
  if (raw.kind !== "impressions") {
    throw new EngagementValidationError('kind must be "impressions"');
  }
  const customerId = requirePositiveInt(raw, "customerId");
  const menuLoadId = requireUuid(raw, "menuLoadId");
  const strictnessStop = parseStrictnessStopId(
    typeof raw.strictnessStop === "string" ? raw.strictnessStop : null,
  );
  const surface = requireString(raw, "surface");
  const periodStartIso = requireIsoTs(raw, "periodStartIso");
  const periodEndIso = requireIsoTs(raw, "periodEndIso");
  const list = raw.impressions;
  if (!Array.isArray(list)) {
    throw new EngagementValidationError("impressions must be an array");
  }
  if (list.length > MAX_IMPRESSIONS_PER_BATCH) {
    throw new EngagementValidationError(
      `impressions exceed batch cap (${MAX_IMPRESSIONS_PER_BATCH})`,
    );
  }
  return {
    customerId,
    menuLoadId,
    strictnessStop,
    surface,
    periodStartIso,
    periodEndIso,
    impressions: list.map(parseImpression),
  };
}

export function parseAction(raw: unknown): EngagementAction {
  if (!isObject(raw)) {
    throw new EngagementValidationError("Body must be a JSON object");
  }
  if (raw.kind !== "action") {
    throw new EngagementValidationError('kind must be "action"');
  }
  const payload = raw.action;
  if (!isObject(payload)) {
    throw new EngagementValidationError("Missing action payload");
  }
  const type = requireString(payload, "type");
  const customerId = requirePositiveInt(payload, "customerId");
  const surface = requireString(payload, "surface");
  switch (type) {
    case "asset_select":
      return {
        type: "asset_select",
        customerId,
        surface,
        assetAddress: requireString(payload, "assetAddress"),
      };
    case "pivot_click": {
      const dimension = requireString(payload, "dimension");
      const { pivotValueJoinId, pivotValue } = parsePivotValueFields(
        payload,
        dimension,
      );
      return {
        type: "pivot_click",
        customerId,
        surface,
        eventKey: requireString(payload, "eventKey"),
        kind: requireString(payload, "kind"),
        baselineVersion: requireString(payload, "baselineVersion"),
        dimension,
        pivotValueJoinId,
        pivotValue,
      };
    }
    case "story_pivot_click": {
      const dimension = requireString(payload, "dimension");
      const { pivotValueJoinId, pivotValue } = parsePivotValueFields(
        payload,
        dimension,
      );
      return {
        type: "story_pivot_click",
        customerId,
        surface,
        eventKey: requireString(payload, "eventKey"),
        kind: requireString(payload, "kind"),
        baselineVersion: requireString(payload, "baselineVersion"),
        storyId: requireString(payload, "storyId"),
        dimension,
        pivotValueJoinId,
        pivotValue,
      };
    }
    case "strictness_change":
      return {
        type: "strictness_change",
        customerId,
        surface,
        strictnessFrom: parseStrictnessStopId(
          requireString(payload, "strictnessFrom"),
        ),
        strictnessTo: parseStrictnessStopId(
          requireString(payload, "strictnessTo"),
        ),
      };
    // `exclusion_create` is not accepted via the HTTP endpoint —
    // exclusions are server-side actions emitted directly by the
    // exclusion route. Returning a 400 here keeps a misconfigured
    // client from double-recording an exclusion (once server-side,
    // once via the endpoint).
    case "exclusion_create":
      throw new EngagementValidationError(
        "exclusion_create is recorded server-side and is not accepted via this endpoint",
      );
    default:
      throw new EngagementValidationError(`Unknown action type "${type}"`);
  }
}
