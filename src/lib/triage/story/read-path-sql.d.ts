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
