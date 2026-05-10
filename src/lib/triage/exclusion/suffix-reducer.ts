/**
 * Domain regex suffix reducer (#457).
 *
 * The retroactive DELETE planner can only honor Domain exclusions whose
 * regex reduces to a hostname suffix or exact match — PostgreSQL btree
 * on `text` cannot evaluate arbitrary regex efficiently. The reducer
 * is conservative; a pattern reduces only if it matches one of the
 * shapes documented in #457:
 *
 *   - `^foo\.example\.com$`           → exact `foo.example.com`
 *   - `^.*\.example\.com$`            → suffix `.example.com`
 *   - `^.+\.example\.com$`            → suffix `.example.com`
 *   - `^[^.]+\.example\.com$`         → suffix `.example.com`
 *   - `^([a-z0-9-]+\.)*example\.com$` → suffix `.example.com`
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
 * Result of applying the reducer to a single pattern. The reducer is
 * always conservative: when in doubt it returns `null`, never an
 * incorrect suffix.
 */
export interface DomainSuffixReduction {
  /** Either an exact hostname (no leading dot) or a suffix (`.example.com`). */
  value: string;
  /** `true` iff the pattern matches the literal hostname only. */
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

  // Try the prefix shapes that imply a suffix (leading dot retained).
  const suffixPrefixes: { token: string }[] = [
    { token: ".*\\." },
    { token: ".+\\." },
    { token: "[^.]+\\." },
  ];
  for (const { token } of suffixPrefixes) {
    if (body.startsWith(token)) {
      const tail = body.slice(token.length);
      const literal = unescapeHostnameLiteral(tail);
      if (literal === null) return null;
      return { value: `.${literal}`, exact: false };
    }
  }

  // Repeating-label shape: `([a-z0-9-]+\.)*<host>` — matches `<host>`
  // alone OR any number of `label.` prefixes followed by `<host>`. The
  // reduction maps to the suffix form `.<host>` (exact `<host>` is
  // also covered, since the suffix matcher is `host = <h>` OR `host
  // ends with .<h>`; the SQL planner uses the suffix branch and the
  // exact branch separately).
  const repeatingLabel = "([a-z0-9-]+\\.)*";
  if (body.startsWith(repeatingLabel)) {
    const tail = body.slice(repeatingLabel.length);
    const literal = unescapeHostnameLiteral(tail);
    if (literal === null) return null;
    return { value: `.${literal}`, exact: false };
  }

  // Exact-hostname shape: `\.`-escaped literals only.
  const literal = unescapeHostnameLiteral(body);
  if (literal !== null) {
    return { value: literal, exact: true };
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
