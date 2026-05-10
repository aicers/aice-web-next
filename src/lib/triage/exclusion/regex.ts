/**
 * Domain regex matcher with a locked-in engine alignment.
 *
 * #481 picks **option (A)** — restrict stored Domain patterns to the
 * Rust ∩ JS regex intersection grammar with insert-time validation, and
 * compile + match in Node with the host JavaScript engine. Option (B)
 * (ship a Rust-equivalent matcher in Node, e.g. WASM `regex` crate)
 * was rejected for 1B-1: it adds a build-time dependency, complicates
 * the deployment, and is overkill for the small subset of regex
 * features stored Domain patterns actually need (anchors, character
 * classes, quantifiers, alternation).
 *
 * The intersection grammar accepts:
 *   - literal characters (Unicode)
 *   - escaped meta-characters (`\.`, `\*`, …)
 *   - `^`, `$` anchors (`\A`, `\z` are rejected because JS does not
 *     support them — both engines must agree)
 *   - character classes `[abc]`, `[^abc]`, ranges `[a-z]`
 *   - `.` (any-char-except-newline; both engines agree on this)
 *   - quantifiers `*`, `+`, `?`, `{n}`, `{n,}`, `{n,m}` (greedy and
 *     lazy with `?`)
 *   - non-capturing groups `(?:…)` and capture groups `(…)`
 *   - alternation `|`
 *
 * The intersection grammar rejects:
 *   - inline modifier flags `(?i)`, `(?x)`, `(?s)`, … (Rust supports
 *     them; JS does not)
 *   - `\A` / `\z` anchors (Rust supports them; JS does not)
 *   - lookbehind `(?<=…)`, `(?<!…)` (Rust does not support these in
 *     the default `regex` crate)
 *   - lookahead `(?=…)`, `(?!…)` (also unsupported by `regex`)
 *   - back-references `\1`, `\k<name>` (unsupported by `regex`)
 *   - named groups `(?<name>…)` (Rust supports `(?P<name>…)` but the
 *     intersection rejects both spellings to keep the validator
 *     simple)
 *
 * Both engines must produce the same matches against `host` /
 * `dns_query` strings; otherwise cadence-time matching diverges from
 * review-web's Stage 1 matching on stored patterns. The
 * `validateDomainPattern` function is the gate every persistence path
 * (cadence corpus fill, #457 storage CRUD, #460 corpus B fill) consults
 * before storing or matching a pattern.
 *
 * The matcher uses `RegExp` with the `u` flag (Unicode aware). Patterns
 * are anchored implicitly: review's Rust matcher uses `RegexSet::is_match`
 * which performs a substring search by default. To preserve identical
 * semantics the cadence-side matcher also performs a substring search
 * (i.e. the pattern is **not** wrapped in `^...$`).
 */

export type DomainPatternValidationResult =
  | { ok: true }
  | { ok: false; reason: string };

const REJECTED_TOKENS: { pattern: RegExp; reason: string }[] = [
  {
    pattern: /\(\?[a-zA-Z]+\)/,
    reason:
      "Inline modifier flags like (?i) / (?x) are rejected — JS regex does not support them.",
  },
  {
    pattern: /\(\?[a-zA-Z]+:/,
    reason:
      "Inline modifier groups like (?i:...) are rejected — JS regex does not support them.",
  },
  {
    pattern: /\(\?<=|\(\?<!/,
    reason:
      "Lookbehind assertions are rejected — Rust's regex crate does not support them.",
  },
  {
    pattern: /\(\?=|\(\?!/,
    reason:
      "Lookahead assertions are rejected — Rust's regex crate does not support them.",
  },
  {
    pattern: /\(\?<[a-zA-Z_]/,
    reason:
      "Named capture groups (?<name>...) are rejected — engine spellings differ.",
  },
  {
    pattern: /\(\?P</,
    reason:
      "Rust-style named capture groups (?P<name>...) are rejected — engine spellings differ.",
  },
  {
    pattern: /\\A|\\z|\\Z/,
    reason:
      "\\A / \\z / \\Z anchors are rejected — JS regex does not support them.",
  },
  {
    pattern: /\\[1-9]/,
    reason:
      "Back-references like \\1 are rejected — Rust's regex crate does not support them.",
  },
  {
    pattern: /\\k</,
    reason:
      "Named back-references \\k<name> are rejected — Rust's regex crate does not support them.",
  },
];

/**
 * Validate a stored Domain pattern against the Rust ∩ JS intersection
 * grammar. Returns `{ ok: true }` if the pattern is safe to store and
 * match in either engine; otherwise returns a structured error so the
 * #457 CRUD path can surface a precise rejection reason.
 */
export function validateDomainPattern(
  pattern: string,
): DomainPatternValidationResult {
  if (typeof pattern !== "string" || pattern.length === 0) {
    return { ok: false, reason: "Empty Domain pattern is not allowed." };
  }
  for (const token of REJECTED_TOKENS) {
    if (token.pattern.test(pattern)) {
      return { ok: false, reason: token.reason };
    }
  }
  // Final pass: the pattern must compile under JS too. This catches
  // nested-quantifier and unbalanced-paren cases without re-implementing
  // a parser.
  try {
    new RegExp(pattern, "u");
  } catch (err) {
    return {
      ok: false,
      reason: `Pattern does not compile in JavaScript regex: ${(err as Error).message}`,
    };
  }
  return { ok: true };
}

/**
 * Compile an array of validated Domain patterns into one combined
 * matcher that mirrors Rust's `RegexSet::is_match` semantics: the
 * matcher returns `true` iff *any* pattern matches anywhere inside the
 * input string. Patterns that fail validation throw — the storage
 * adapter (#457) is responsible for rejecting them at INSERT time so
 * cadence never sees an invalid pattern at runtime.
 */
export function compileDomainPatterns(patterns: string[]): RegExp | null {
  if (patterns.length === 0) return null;
  const wrapped: string[] = [];
  for (const pattern of patterns) {
    const result = validateDomainPattern(pattern);
    if (!result.ok) {
      throw new Error(
        `compileDomainPatterns: invalid pattern ${JSON.stringify(pattern)}: ${result.reason}`,
      );
    }
    // Wrap in a non-capturing group so alternation in any one pattern
    // does not bleed into siblings when joined by `|`.
    wrapped.push(`(?:${pattern})`);
  }
  return new RegExp(wrapped.join("|"), "u");
}
