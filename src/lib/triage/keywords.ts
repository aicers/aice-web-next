/**
 * Free-form input contract for the Tier 2 `keywords` pivot dimension
 * (#499).
 *
 * Unlike the enum-shaped Tier-2-only dimensions (`kinds` / `categories`
 * / `levels` / `learningMethods`), `keywords` carries an operator-
 * supplied free-text value. The panel renders a typed-input chip
 * section with explicit submit — every fetch is gated by an operator
 * action so the pre-fetch projection modal still bounds large
 * projections naturally. Recent submissions are remembered for the
 * duration of the page session only (not persisted across reloads or
 * URL hash) so a stale typed value cannot be revived without the
 * operator re-typing it.
 *
 * The panel, the hash parser, and the recents helpers all import
 * {@link MAX_KEYWORD_LENGTH} / {@link MAX_RECENT_KEYWORDS} from here so
 * the bounds are defined once. {@link validateKeywordInput} returns
 * the trimmed value or a discriminated error so callers do not have to
 * duplicate the trim / empty / length rules at each call site.
 */

/**
 * Hard ceiling on submitted keyword length. REview's `keywords` filter
 * is unbounded server-side, but a per-value cap keeps the URL hash
 * representation and the LRU cache key from blowing up — both encode
 * the value verbatim. Operators that need to express a longer pattern
 * should rely on the corpus's content fields instead.
 */
export const MAX_KEYWORD_LENGTH = 256;

/**
 * Maximum number of remembered chips. The oldest entry is evicted when
 * a sixth distinct submission lands. Bounded to keep the affordance
 * small enough that an operator can scan it at a glance.
 */
export const MAX_RECENT_KEYWORDS = 5;

export type KeywordValidationError = "empty" | "tooLong";

export type KeywordValidationResult =
  | { ok: true; value: string }
  | { ok: false; error: KeywordValidationError };

/**
 * Apply the submit-time rules to a raw input string: trim, reject
 * empty / whitespace-only, reject when the trimmed length exceeds
 * {@link MAX_KEYWORD_LENGTH}. Returns a discriminated result so the
 * caller can map `error` to an inline validation message without
 * duplicating the rule chain.
 */
export function validateKeywordInput(raw: string): KeywordValidationResult {
  const value = raw.trim();
  if (value.length === 0) return { ok: false, error: "empty" };
  if (value.length > MAX_KEYWORD_LENGTH) return { ok: false, error: "tooLong" };
  return { ok: true, value };
}

/**
 * Update the page-session recent-keywords list with a new submission.
 * The list is most-recent-first. If the value already exists it is
 * moved to the head rather than duplicated (the "duplicate-of-recent"
 * rule from #499). Otherwise it is prepended and the list is bounded
 * at {@link MAX_RECENT_KEYWORDS}.
 *
 * The function does not mutate its input — callers can feed it to a
 * React setter directly.
 */
export function appendRecentKeyword(
  current: readonly string[],
  value: string,
): string[] {
  const next: string[] = [value];
  for (const existing of current) {
    if (existing === value) continue;
    next.push(existing);
    if (next.length >= MAX_RECENT_KEYWORDS) break;
  }
  return next;
}
