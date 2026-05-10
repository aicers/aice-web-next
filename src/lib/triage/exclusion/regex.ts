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
 *   - character classes `[abc]`, `[^abc]`, ranges `[a-z]` (use these
 *     for ASCII digit / word semantics — e.g. `[0-9]`, `[A-Za-z0-9_]`)
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
 *   - shorthand character classes `\d`, `\D`, `\w`, `\W`, `\s`, `\S`
 *     and word boundaries `\b`, `\B`. Rust's `regex` crate (Unicode
 *     mode is on by default) treats `\w` / `\d` / `\s` / `\b` as
 *     Unicode-aware: `\d` matches every Unicode decimal digit, `\w`
 *     matches Unicode word characters, `\b` is a Unicode word boundary.
 *     JavaScript's `RegExp` (even with the `u` flag) defines the same
 *     escapes against ASCII only. A pattern stored in review-web could
 *     therefore match a Unicode digit / word character at Stage 1 but
 *     fail to match in cadence-side JS, silently diverging the two
 *     engines on the same stored row. Force authors to spell the
 *     intent with explicit ASCII character classes (e.g. `[0-9]`,
 *     `[A-Za-z0-9_]`, `[ \t\r\n]`) so both engines agree.
 *   - character-class set operators `&&` (intersection), `--`
 *     (difference), `~~` (symmetric difference) and nested `[…]`
 *     classes. Rust's `regex` crate parses `[a&&b]` as a class
 *     intersection that matches nothing, while JavaScript's `RegExp`
 *     (without the `v` flag, which the matcher does not enable) parses
 *     `&` as a literal class member and matches `a`, `&`, or `b`. The
 *     same divergence applies to `[a--b]` (Rust difference vs JS literal
 *     `-`s) and to nested classes like `[[a-z]&&[^aeiou]]`. Allowing
 *     any of these would let a stored Domain pattern match in cadence-
 *     side JS but not in review-web Stage 1 (or vice-versa) — exactly
 *     the divergence option (A) is supposed to prevent. Authors should
 *     spell out the literal class with `\-` / `\&` / `\~` if they need
 *     those characters as members.
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
 * Walk the pattern to find an unescaped `\X` shorthand whose semantics
 * diverge between Rust's Unicode-aware `regex` crate and JavaScript's
 * `RegExp` (even with the `u` flag).
 *
 * `\d` / `\w` / `\s` and the negated forms match Unicode digits / word
 * characters / whitespace in Rust by default but only ASCII in JS. `\b`
 * and `\B` are Unicode word boundaries in Rust and ASCII-only in JS
 * outside of a character class. Allowing any of these would silently
 * diverge cadence matching from review-web Stage 1 on stored patterns,
 * which is exactly what option (A) is supposed to prevent.
 *
 * The walker counts consecutive backslashes so a literal `\\d` in the
 * pattern (escaped backslash followed by literal `d`) is **not**
 * rejected — only an unescaped `\d` shorthand is.
 */
function findDivergentShorthand(
  pattern: string,
): { token: string; index: number } | null {
  let i = 0;
  while (i < pattern.length) {
    if (pattern[i] !== "\\") {
      i += 1;
      continue;
    }
    let backslashes = 0;
    while (i < pattern.length && pattern[i] === "\\") {
      backslashes += 1;
      i += 1;
    }
    // An odd run leaves one unescaped backslash before the next char,
    // so the next char is treated as an escape sequence.
    if (backslashes % 2 === 1 && i < pattern.length) {
      const next = pattern[i];
      if (next === "d" || next === "D" || next === "w" || next === "W") {
        return { token: `\\${next}`, index: i - 1 };
      }
      if (next === "s" || next === "S") {
        return { token: `\\${next}`, index: i - 1 };
      }
      if (next === "b" || next === "B") {
        return { token: `\\${next}`, index: i - 1 };
      }
      i += 1;
    }
  }
  return null;
}

/**
 * Walk the pattern looking for character-class set operators that Rust's
 * `regex` crate honours but JavaScript's `RegExp` (without the `v` flag)
 * silently treats as literals.
 *
 * Inside a `[...]` character class:
 *   - `&&` is class intersection in Rust (`[a&&b]` matches nothing) but
 *     a literal `&` repeated twice in JS (`[a&&b]` matches `a`, `&`, or
 *     `b`).
 *   - `--` is class difference in Rust (`[a-z--[aeiou]]` excludes the
 *     vowels) but a literal `-` in JS at most positions, or part of a
 *     range otherwise.
 *   - `~~` is class symmetric difference in Rust but literal `~` in JS.
 *   - A nested `[…]` is the operand syntax for those operators in Rust,
 *     and a JS `RegExp` without the `v` flag rejects an unescaped inner
 *     `[`. Even if a pattern would fail to compile in JS, rejecting it
 *     here gives a precise reason rather than a generic SyntaxError.
 *
 * Backslash-escaped characters (`\&`, `\-`, `\~`, `\[`) are skipped — an
 * author who wants those as literal class members spells them with the
 * escape and both engines agree.
 */
function findClassSetOperator(
  pattern: string,
): { token: string; index: number } | null {
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "\\") {
      // Skip the escape sequence (one char of escape + the escaped
      // char). If the backslash is the final character, stop.
      i += 2;
      continue;
    }
    if (ch !== "[") {
      i += 1;
      continue;
    }
    // Enter a character class.
    let j = i + 1;
    if (pattern[j] === "^") j += 1;
    while (j < pattern.length && pattern[j] !== "]") {
      const cur = pattern[j];
      if (cur === "\\") {
        j += 2;
        continue;
      }
      if (cur === "[") {
        return { token: "[…]", index: j };
      }
      if (j + 1 < pattern.length) {
        const pair = pattern.slice(j, j + 2);
        if (pair === "&&" || pair === "--" || pair === "~~") {
          return { token: pair, index: j };
        }
      }
      j += 1;
    }
    i = j + 1;
  }
  return null;
}

const CLASS_SET_REJECTION_REASON: Record<string, string> = {
  "&&": "Class-set operator && is rejected — Rust treats it as character-class intersection, JS as two literal & characters. Spell the literal members explicitly (e.g. [a\\&b]).",
  "--": "Class-set operator -- is rejected — Rust treats it as character-class difference, JS as literal - characters. Spell the literal members explicitly (e.g. [a\\-b]).",
  "~~": "Class-set operator ~~ is rejected — Rust treats it as character-class symmetric difference, JS as two literal ~ characters. Spell the literal members explicitly.",
  "[…]":
    "Nested character class [...] is rejected — Rust treats it as the operand syntax for class-set operators, JS (without the v flag) does not support nested classes at all.",
};

const SHORTHAND_REJECTION_REASON: Record<string, string> = {
  "\\d":
    "Shorthand \\d is rejected — Rust matches Unicode digits, JS only ASCII. Use [0-9] instead.",
  "\\D":
    "Shorthand \\D is rejected — Rust matches non-Unicode-digits, JS non-ASCII-digits. Use [^0-9] instead.",
  "\\w":
    "Shorthand \\w is rejected — Rust matches Unicode word characters, JS only ASCII. Use [A-Za-z0-9_] instead.",
  "\\W":
    "Shorthand \\W is rejected — Rust matches non-Unicode-word, JS non-ASCII-word. Use [^A-Za-z0-9_] instead.",
  "\\s":
    "Shorthand \\s is rejected — Rust matches Unicode whitespace, JS only ASCII. Use an explicit class like [ \\t\\r\\n] instead.",
  "\\S":
    "Shorthand \\S is rejected — Rust matches non-Unicode-whitespace, JS non-ASCII-whitespace. Use an explicit negated class instead.",
  "\\b":
    "Shorthand \\b is rejected — outside a character class Rust treats it as a Unicode word boundary while JS uses ASCII; inside a class JS treats it as backspace. Use explicit anchors / character classes instead.",
  "\\B":
    "Shorthand \\B is rejected — Rust treats it as a Unicode non-word boundary, JS as ASCII. Use explicit anchors instead.",
};

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
  const shorthand = findDivergentShorthand(pattern);
  if (shorthand !== null) {
    const reason =
      SHORTHAND_REJECTION_REASON[shorthand.token] ??
      `Shorthand ${shorthand.token} is rejected — Rust and JS regex semantics diverge on this construct.`;
    return { ok: false, reason };
  }
  const classSet = findClassSetOperator(pattern);
  if (classSet !== null) {
    const reason =
      CLASS_SET_REJECTION_REASON[classSet.token] ??
      `Class-set operator ${classSet.token} is rejected — Rust and JS regex semantics diverge on this construct.`;
    return { ok: false, reason };
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
