/**
 * Phase 1.B menu composition (RFC 0001 §3 steps (4)–(7), §4, §6).
 *
 * The runtime now lives in the plain-ESM module `./compose.mjs` so
 * the measurement harness (`scripts/measure-baseline-read-path.mjs`)
 * can execute the SAME composition code as the production read path.
 * This file is a thin TypeScript re-export façade — every named
 * export below maps 1:1 onto a symbol in `compose.mjs`. Algorithm
 * details and the RFC mapping are documented in `compose.mjs`.
 *
 * Existing TS callers (e.g. `server-actions.ts`, the menu tests)
 * keep importing from `@/lib/triage/baseline/menu` unchanged.
 */

export type {
  AssembleResult,
  BucketAggregate,
  BucketEngagement,
  ComposeMenuInput,
  MenuRow,
  SlotBucket,
} from "./compose.mjs";
export {
  _testing,
  assembleMenu,
  bucketKey,
  compareEventKeyDesc,
  composeMenu,
  computeBucketQuotas,
  computeDefaultN,
  DEFAULT_MENU_CUTOFF,
  slotBucket,
} from "./compose.mjs";
