/**
 * Domain regex suffix reducer (#457).
 *
 * The retroactive DELETE planner can only honor Domain exclusions whose
 * regex reduces to a hostname suffix or exact match — PostgreSQL btree
 * on `text` cannot evaluate arbitrary regex efficiently. The reducer
 * is conservative; a pattern reduces only if it matches one of the
 * shapes the SQL planner can emit a byte-equivalent predicate for.
 *
 * Each shape carries a `subset` tag so the planner does not over- or
 * under-delete relative to the regex's true match set:
 *
 *   - `^foo\.example\.com$`           → `{value: 'foo.example.com', subset: 'exact'}`
 *     SQL: `host = 'foo.example.com'`
 *   - `^.*\.example\.com$`            → `{value: '.example.com', subset: 'suffix'}`
 *     SQL: `host LIKE '%.example.com'` (matches `*.example.com` only,
 *     NOT bare `example.com` — the regex requires the literal dot.)
 *   - `^.+\.example\.com$`            → `{value: '.example.com', subset: 'suffix'}`
 *     Same as above; `.+` and `.*` differ only on the empty prefix,
 *     which the literal `\.` rules out anyway.
 *   - `^([a-z0-9-]+\.)*example\.com$` → `{value: '.example.com', subset: 'exactOrSuffix'}`
 *     SQL: `host = 'example.com' OR host LIKE '%.example.com'`. The
 *     `*` quantifier permits zero label prefixes, so the bare host
 *     matches too.
 *   - `^[^.]+\.example\.com$`         → not reducible. The regex matches
 *     exactly one label before the suffix, but `host LIKE '%.example.com'`
 *     also matches deeper names like `a.b.example.com`. Without an
 *     extra `host NOT LIKE '%.%.example.com'` predicate the SQL would
 *     over-delete. Treat as full-regex-only — forward matching still
 *     applies the regex correctly via the active set.
 *   - anything else                   → not reducible (full-regex-only)
 *
 * `domain_suffix` is populated only when reduction succeeds. For
 * non-reducible patterns the row remains fully valid — it just takes
 * effect from the next pipeline pass forward.
 *
 * The reducer is a small parser over the regex source (NOT a regex on
 * a regex). Extension space exists — alternation of suffixes,
 * anchored prefixes — but is deferred until operational signal demands
 * it.
 */

const HOSTNAME_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?$/;

/**
 * Subset of host strings the SQL planner can match for a given
 * reduction. Drives which DELETE predicate is emitted:
 *
 *   - `'exact'`         → `host = <value>` only.
 *   - `'suffix'`        → `host LIKE '%<value>'` only — `<value>`
 *                          carries the leading dot, so the bare host
 *                          is NOT matched.
 *   - `'exactOrSuffix'` → both predicates ORed together. Used by the
 *                          `([a-z0-9-]+\.)*<host>` shape, where the
 *                          `*` quantifier permits the bare host.
 */
export type DomainSuffixSubset = "exact" | "suffix" | "exactOrSuffix";

/**
 * Result of applying the reducer to a single pattern. The reducer is
 * always conservative: when in doubt it returns `null`, never an
 * incorrect suffix.
 */
export interface DomainSuffixReduction {
  /** Either an exact hostname (no leading dot) or a suffix (`.example.com`). */
  value: string;
  /** Which SQL predicate the planner can emit for this reduction. */
  subset: DomainSuffixSubset;
  /**
   * `true` iff the pattern matches the literal hostname only. Kept for
   * backward compatibility with existing call sites that only need the
   * exact-vs-suffix bit.
   *
   * @deprecated Inspect `subset` directly — `exact === true` iff
   * `subset === 'exact'`.
   */
  exact: boolean;
}

/**
 * Reduce a Domain regex pattern to its canonical hostname suffix /
 * exact-match form, or `null` if the pattern does not match one of the
 * supported shapes.
 *
 * The pattern MUST already have passed `validateDomainPattern` — the
 * reducer assumes the input compiles in JS regex and contains no
 * shorthand classes / lookaround / inline flags.
 */
export function reduceDomainPatternToSuffix(
  pattern: string,
): DomainSuffixReduction | null {
  if (typeof pattern !== "string" || pattern.length < 4) return null;
  if (!pattern.startsWith("^") || !pattern.endsWith("$")) return null;
  // Strip the anchors but keep the body for further matching.
  const body = pattern.slice(1, -1);
  if (body.length === 0) return null;

  // Suffix-only shapes: the regex requires at least one label before
  // the literal `\.<host>`, so the bare host is NOT a member of the
  // match set. SQL: `host LIKE '%.<host>'`.
  //
  // `[^.]+\.` is intentionally excluded — it matches a single label
  // only (`a.example.com`), but a `LIKE '%.example.com'` predicate
  // also covers deeper names (`a.b.example.com`). The SQL planner has
  // no efficient way to emit "exactly one label" against an indexed
  // text column without breaking the index plan, so we leave this
  // shape full-regex-only. Forward matching still applies.
  const suffixOnlyPrefixes: { token: string }[] = [
    { token: ".*\\." },
    { token: ".+\\." },
  ];
  for (const { token } of suffixOnlyPrefixes) {
    if (body.startsWith(token)) {
      const tail = body.slice(token.length);
      const literal = unescapeHostnameLiteral(tail);
      if (literal === null) return null;
      return { value: `.${literal}`, subset: "suffix", exact: false };
    }
  }

  // Repeating-label shape: `([a-z0-9-]+\.)*<host>` — matches `<host>`
  // alone OR any number of `label.` prefixes followed by `<host>`,
  // because the `*` quantifier permits zero repetitions. SQL emits
  // both `host = <h>` and `host LIKE '%.<h>'`.
  const repeatingLabel = "([a-z0-9-]+\\.)*";
  if (body.startsWith(repeatingLabel)) {
    const tail = body.slice(repeatingLabel.length);
    const literal = unescapeHostnameLiteral(tail);
    if (literal === null) return null;
    return { value: `.${literal}`, subset: "exactOrSuffix", exact: false };
  }

  // Exact-hostname shape: `\.`-escaped literals only.
  const literal = unescapeHostnameLiteral(body);
  if (literal !== null) {
    return { value: literal, subset: "exact", exact: true };
  }

  return null;
}

/**
 * Decode a regex tail of the form `foo\.example\.com` into the
 * hostname `foo.example.com`. Returns `null` if the tail contains any
 * regex meta-character other than the escape `\.`.
 *
 * The validator already excludes lookaround / shorthand / class
 * operators, but a literal hostname must still avoid bare `.`, `*`,
 * `+`, `(`, `[`, `|` — any of those means the pattern is not a plain
 * hostname suffix.
 */
function unescapeHostnameLiteral(input: string): string | null {
  if (input.length === 0) return null;
  let i = 0;
  let out = "";
  while (i < input.length) {
    const ch = input[i];
    if (ch === "\\") {
      const next = input[i + 1];
      if (next === ".") {
        out += ".";
        i += 2;
        continue;
      }
      // No other escape is permitted in the hostname tail.
      return null;
    }
    // Only ASCII letters / digits / hyphen are permitted unescaped.
    if (
      !(
        (ch >= "a" && ch <= "z") ||
        (ch >= "A" && ch <= "Z") ||
        (ch >= "0" && ch <= "9") ||
        ch === "-"
      )
    ) {
      return null;
    }
    out += ch;
    i += 1;
  }
  // The decoded form must be a sequence of valid DNS labels separated
  // by single dots — no leading / trailing dot, no empty label.
  return validateHostnameLiteral(out) ? out : null;
}

function validateHostnameLiteral(host: string): boolean {
  if (host.length === 0) return false;
  if (host.startsWith(".") || host.endsWith(".")) return false;
  for (const label of host.split(".")) {
    if (!HOSTNAME_LABEL.test(label)) return false;
  }
  return true;
}

export const _testing = {
  unescapeHostnameLiteral,
  validateHostnameLiteral,
};
