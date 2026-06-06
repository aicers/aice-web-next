// Type declarations for `read-path-sql.mjs`. Sibling to the JS so the
// production caller and tests get IDE / typecheck signal without a
// transpile step.

export const SELECT_STORIES_FOR_PERIOD_SQL: string;
export const SELECT_STORY_TOP_MEMBERS_SQL: string;
export const SELECT_STORY_MEMBERS_DETAIL_SQL: string;
export const SELECT_BASELINE_EVENTS_BY_KEY_SQL: string;

export function buildSelectStoriesForPeriodSql(opts: {
  sortOrder: "time-window-end" | "score";
  unsentOnly: boolean;
}): string;

export function buildReadR1CandidatesSql(opts: {
  memberScanStartIsNull: boolean;
  endExclusive?: boolean;
}): string;

export function buildReadR3CandidatesPhase1Sql(opts: {
  memberScanStartIsNull: boolean;
  endExclusive?: boolean;
}): string;

export function buildReadR3CandidatesPhase2Sql(opts: {
  memberScanStartIsNull: boolean;
  endExclusive?: boolean;
}): string;

export function buildReadR4CandidatesPhase1Sql(opts: {
  memberScanStartIsNull: boolean;
  endExclusive?: boolean;
}): string;

export function buildReadR4CandidatesPhase2Sql(opts: {
  memberScanStartIsNull: boolean;
  endExclusive?: boolean;
}): string;

export function buildReadR5CandidatesPhase1Sql(opts: {
  memberScanStartIsNull: boolean;
  endExclusive?: boolean;
}): string;

export function buildReadR5CandidatesPhase2Sql(opts: {
  memberScanStartIsNull: boolean;
  endExclusive?: boolean;
}): string;

export function buildReadR6CandidatesPhase1Sql(opts: {
  memberScanStartIsNull: boolean;
  endExclusive?: boolean;
}): string;

export function buildReadR6CandidatesPhase2Sql(opts: {
  memberScanStartIsNull: boolean;
  endExclusive?: boolean;
}): string;

export function buildReadR2CandidatesPhase1Sql(opts: {
  memberScanStartIsNull: boolean;
  endExclusive?: boolean;
}): string;

export function buildReadR2CandidatesPhase2Sql(opts: {
  memberScanStartIsNull: boolean;
  endExclusive?: boolean;
}): string;
