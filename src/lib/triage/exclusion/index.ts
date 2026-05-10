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
  compileStoredRowsToActiveSet,
  EMPTY_EXCLUSION_SET_RESOLVER,
} from "./active-set";
export { loadActiveExclusions } from "./active-set-storage";
export {
  computeExclusionsFingerprint,
  EMPTY_EXCLUSIONS_FINGERPRINT,
} from "./fingerprint";
export { isExcluded } from "./match";
export { normalizeEventColumns } from "./normalize";
export {
  type EventTriageExclusionInputShape,
  ExclusionInputParseError,
  type HostNetworkGroupInputShape,
  type IpRangeInputShape,
  parseExclusionInput,
  parseExclusionInputs,
} from "./parse";
export {
  compileDomainPatterns,
  type DomainPatternValidationResult,
  validateDomainPattern,
} from "./regex";
export {
  MAX_STORED_EXCLUSION_NOTE_LENGTH,
  MAX_STORED_EXCLUSION_VALUE_LENGTH,
  type ParsedStoredExclusion,
  parseStoredExclusionInput,
  STORED_EXCLUSION_KINDS,
  type StoredExclusionInput,
  type StoredExclusionKind,
  StoredExclusionValidationError,
} from "./storage-input";
export {
  type DomainSuffixReduction,
  reduceDomainPatternToSuffix,
} from "./suffix-reducer";
export type {
  ActiveExclusionSet,
  ExclusionRule,
  IpAddressExclusionInput,
  NormalizedEventColumns,
} from "./types";
