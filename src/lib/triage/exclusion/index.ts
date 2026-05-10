/**
 * Shared exclusion / normalization helper barrel (#481, #460, #457).
 *
 * Lives outside `src/lib/triage/policy/` so the policy deprecatability
 * seam stays intact. The cadence runner, the corpus B runner, and the
 * retroactive-DELETE planner all import from this module so the
 * normalization mapping, the IpAddress / Domain / Hostname / Uri
 * matcher, and the `exclusions_fp` canonicalization are a single
 * source of truth.
 */

export {
  type ActiveExclusionSetResolver,
  EMPTY_EXCLUSION_SET_RESOLVER,
} from "./active-set";
export {
  computeExclusionsFingerprint,
  EMPTY_EXCLUSIONS_FINGERPRINT,
} from "./fingerprint";
export { isExcluded } from "./match";
export { normalizeEventColumns } from "./normalize";
export {
  compileDomainPatterns,
  type DomainPatternValidationResult,
  validateDomainPattern,
} from "./regex";
export type {
  ActiveExclusionSet,
  ExclusionRule,
  IpAddressExclusionInput,
  NormalizedEventColumns,
} from "./types";
