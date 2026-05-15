/**
 * Audit-grade condition snapshots (#472).
 *
 * The fingerprint columns on `baseline_triaged_event` (#456) and
 * `policy_triage_run` (#460) are opaque SHA-256 digests — sufficient as
 * cache keys but not as audit / reproducibility records once the
 * source tables (`triage_exclusion`, `triage_policy`, the baseline
 * tunables module) mutate. The three snapshot tables this module
 * writes turn each fingerprint into a resolvable JSON payload so an
 * analyst can answer "what excluded this row?" / "what scoring rules
 * ran here?" / "what baseline parameters scored this?" weeks after
 * the source tables drifted.
 *
 * The payload shapes here are the public on-disk contract for the
 * three snapshot tables. Any change to a shape requires a migration:
 * existing rows are immutable once written.
 */

import type { Confidence, PacketAttr, Response } from "../policy/types";

/**
 * One stored exclusion as it appears in `exclusion_snapshot.snapshot`.
 *
 * `scope_first_observed` is the scope label captured the first time
 * this fingerprint was observed. A rule that later moves between
 * global and customer scopes does NOT bump the fingerprint (the
 * matcher de-dups across scopes per #457's `compileStoredRowsToActiveSet`
 * comment), so the snapshot row preserves the scope label as of first
 * observation. The `_first_observed` suffix encodes the diminished
 * semantics so audit consumers cannot misread it as "the scope at run
 * time."
 */
export interface ExclusionSnapshotRow {
  scope_first_observed: "global" | "customer";
  kind: "ipAddress" | "hostname" | "uri" | "domain";
  value: string;
}

/**
 * Canonical payload for `exclusion_snapshot.snapshot` — sorted
 * lexicographically by the row's stable serialization so two
 * captures of the same logical set produce byte-identical JSONB.
 */
export type ExclusionSnapshotPayload = ExclusionSnapshotRow[];

/**
 * One policy as it appears in `policy_snapshot.snapshot`.
 *
 * The three rule arrays match what `computePoliciesFingerprint` hashes,
 * so the snapshot is the canonical answer to "what scoring rules ran
 * under this fingerprint." `name_first_observed` is a best-effort
 * human label captured the first time the fingerprint was seen; the
 * snapshot writer uses `ON CONFLICT (fingerprint) DO NOTHING`, so a
 * subsequent rename does NOT update the recorded label — the field
 * name encodes that diminished semantics.
 */
export interface PolicySnapshotRow {
  id: number;
  name_first_observed: string;
  packet_attr: PacketAttr[];
  confidence: Confidence[];
  response: Response[];
}

/**
 * Canonical payload for `policy_snapshot.snapshot` — sorted by `id`
 * so two captures of the same logical policy set produce
 * byte-identical JSONB.
 */
export type PolicySnapshotPayload = PolicySnapshotRow[];

/**
 * Canonical payload for `baseline_version_snapshot.parameters` —
 * captures every exported group from
 * `src/lib/triage/baseline/tunables.ts` for the active
 * `baseline_version`. A bump in any of these values requires a
 * `baseline_version` bump (per `tunables.ts` §10), so one snapshot
 * row per version is sufficient and immutable.
 */
export interface BaselineVersionParameters {
  selectorWeights: {
    w_S1: number;
    w_S2: number;
    w_S3: number;
    w_S4: number;
    w_UNLABELED: number;
  };
  selectorSaturation: {
    R: number;
    C: number;
  };
  tagThresholds: {
    s1_high: number;
    s3_recurring: number;
    s4_correlated: number;
  };
  slotAllocation: {
    base_share: number;
    alpha: number;
    beta: number;
  };
  finalCount: {
    LOWER_FLOOR: number;
    scale: number;
    MIN_NONZERO_FLOOR: number;
  };
  statisticsWindowDays: readonly number[];
  maxTags: number;
  selectorTags: {
    S1_HIGH: string;
    S2_SEVERE: string;
    S3_RECURRING: string;
    S4_CORRELATED: string;
    UNLABELED_CLUSTER: string;
  };
}
