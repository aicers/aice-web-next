/**
 * Corpus B run / event domain types.
 *
 * Mirrors the columns in `migrations/customer/0008_policy_corpus_b.sql`.
 * Used by the runner, repository, and (eventually) the menu read-path
 * for "With my policies" mode.
 */

export type PolicyTriageRunStatus =
  | "computing"
  | "ready"
  | "failed"
  | "superseded";

/**
 * Corpus B-specific triage outcome stored on each
 * `policy_triaged_event` row. Matches review-web's `TriageScore` shape
 * (one entry per matching policy with the raw score). Empty list when
 * no policy matched; the run still owns the row because the runner
 * persists everything that passed standard filter + exclusions.
 */
export interface PolicyTriageScoreSnapshot {
  scores: { policyId: number; score: number }[];
}

export interface PolicyTriageRunRow {
  id: string;
  ownerAccountId: string;
  periodStartIso: string;
  periodEndIso: string;
  policiesFingerprint: string;
  exclusionsFingerprint: string;
  baselineVersion: string;
  status: PolicyTriageRunStatus;
  replaces: string | null;
  supersededBy: string | null;
  refreshReason: string | null;
  computationDurationMs: number | null;
  lastError: string | null;
  createdAtIso: string;
  finalizedAtIso: string | null;
}

export interface PolicyTriagedEventRow {
  runId: string;
  eventKey: string;
  eventTimeIso: string;
  kind: string;
  sensor: string;
  origAddr: string | null;
  origPort: number | null;
  respAddr: string | null;
  respPort: number | null;
  proto: number | null;
  host: string | null;
  dnsQuery: string | null;
  uri: string | null;
  category: string | null;
  snapshot: PolicyTriageScoreSnapshot;
}
