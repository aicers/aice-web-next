/**
 * Static option sources for the Detection filter drawer's categorical
 * multi-select fields. The values here are shaped for direct
 * inclusion in `EventListFilterInput` — `ThreatLevel` is a string enum
 * (matching `levels: [ThreatLevel!]`) and `ThreatCategory` is an
 * integer array (matching `categories: [Int]`).
 */

import type { LearningMethod, ThreatCategory, ThreatLevel } from "./types";
import { CURATED_EVENT_TYPENAMES } from "./types";

/**
 * Subset of `ThreatLevel` exposed in the filter drawer. The schema
 * also defines `VERY_LOW` and `VERY_HIGH`; the UI keeps the
 * three-level surface today and labels the extras only when REview
 * surfaces them on output.
 */
export type ThreatLevelValue = Extract<ThreatLevel, "LOW" | "MEDIUM" | "HIGH">;

/** Ordered ascending so the drawer renders Low → High. */
export const THREAT_LEVEL_VALUES: readonly ThreatLevelValue[] = [
  "LOW",
  "MEDIUM",
  "HIGH",
];

/**
 * Integer encoding of `ThreatCategory` for `categories: [Int]` in
 * `EventListFilterInput`. Ordering mirrors the declaration order in
 * `schemas/review.graphql`; the mapping stays co-located with the
 * option list so a schema change is a one-file edit.
 */
export const THREAT_CATEGORY_VALUES: readonly number[] = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14,
];

export const THREAT_CATEGORY_KEY_BY_VALUE: Record<number, ThreatCategory> = {
  1: "RECONNAISSANCE",
  2: "INITIAL_ACCESS",
  3: "EXECUTION",
  4: "CREDENTIAL_ACCESS",
  5: "DISCOVERY",
  6: "LATERAL_MOVEMENT",
  7: "COMMAND_AND_CONTROL",
  8: "EXFILTRATION",
  9: "IMPACT",
  10: "COLLECTION",
  11: "DEFENSE_EVASION",
  12: "PERSISTENCE",
  13: "PRIVILEGE_ESCALATION",
  14: "RESOURCE_DEVELOPMENT",
};

export const LEARNING_METHOD_VALUES: readonly LearningMethod[] = [
  "UNSUPERVISED",
  "SEMI_SUPERVISED",
];

/**
 * Seed list of `kinds` shown before any REview-backed completion is
 * wired up. The tokens MUST match what REview accepts for
 * `EventListFilterInput.kinds` — the rest of the app (event locator
 * resolution in `src/lib/events/event-locator.ts`, the single-event
 * query in `src/lib/detection/server-actions.ts`) passes the
 * canonical `Event` subtype `__typename` there, so this seed reuses
 * `CURATED_EVENT_TYPENAMES` verbatim. The field is still treated as
 * an open list by the drawer (see `openList` in filter-chips.ts)
 * because REview may surface additional typenames beyond the
 * curated UI set — saturating the visible list must not be read as
 * "no filter".
 */
export const INITIAL_THREAT_KINDS: readonly string[] = CURATED_EVENT_TYPENAMES;
