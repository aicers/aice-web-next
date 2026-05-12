/**
 * Corpus B (on-demand, "With my policies") barrel.
 *
 * Lives inside `triage/policy/` per §6 of #447 — removing the policy
 * mode removes this directory. The shared exclusion / inline-policy
 * helpers stay in place because baseline-side code still uses them.
 */

export {
  computePoliciesFingerprint,
  EMPTY_POLICIES_FINGERPRINT,
} from "./fingerprint";
export {
  findActiveRun,
  getRunById,
  insertComputingRun,
  insertTriagedEventsBatch,
  listTriagedEvents,
  markRunFailed,
  markRunReady,
  PolicyTriageRunActiveSlotConflict,
  recomputeRun,
} from "./repository";
export {
  CORPUS_B_BASELINE_VERSION,
  CORPUS_B_PAGE_SIZE,
  type CorpusBRunnerOptions,
  type CorpusBRunRequest,
  type CorpusBRunResult,
  recomputeCorpusBRun,
  runCorpusBTriage,
} from "./runner";
export type {
  PolicyTriagedEventRow,
  PolicyTriageRunRow,
  PolicyTriageRunStatus,
  PolicyTriageScoreSnapshot,
} from "./types";
