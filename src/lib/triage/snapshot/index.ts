/**
 * Triage condition snapshots (#472).
 *
 * Audit/reproducibility substrate for the fingerprint columns on
 * `baseline_triaged_event` (#456) and `policy_triage_run` (#460).
 * See `./writer.ts` for the per-snapshot semantics and `./retention.ts`
 * for the join-aware cleanup sweep.
 */

export { currentBaselineParameters } from "./baseline-parameters";
export {
  DEFAULT_DELETE_BATCH_SIZE as SNAPSHOT_DEFAULT_DELETE_BATCH_SIZE,
  EXCLUSION_SNAPSHOT_MAX_REFERENCE_WINDOW_DAYS,
  POLICY_SNAPSHOT_MAX_REFERENCE_WINDOW_DAYS,
  runSnapshotRetentionDispatch,
  runSnapshotRetentionForCustomer,
  SNAPSHOT_GRACE_DAYS,
  type SnapshotRetentionCounts,
  type SnapshotRetentionCustomerResult,
  type SnapshotRetentionResult,
  verifyTriageSnapshotRetentionToken,
} from "./retention";
export type {
  BaselineVersionParameters,
  ExclusionSnapshotPayload,
  ExclusionSnapshotRow,
  PolicySnapshotPayload,
  PolicySnapshotRow,
} from "./types";
export {
  canonicalizeExclusionSnapshot,
  canonicalizePolicySnapshot,
  recordBaselineVersionSnapshot,
  recordExclusionSnapshot,
  recordPolicySnapshot,
} from "./writer";
