/**
 * Corpus B run / event domain types.
 *
 * Mirrors the `policy_triage_run` / `policy_triaged_event` columns in
 * the tenant schema.
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
 * (one entry per matching policy with the raw score). Every persisted
 * row carries at least one matching policy score — the runner drops
 * events whose `triageScores` is null or empty after the app-side
 * exclusion pass, so a no-match period materialises as a `ready` run
 * with zero `policy_triaged_event` rows rather than rows with empty
 * score lists.
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
