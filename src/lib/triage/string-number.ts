/**
 * BigInt-safe helpers for `StringNumber` comparisons.
 *
 * REview types `EventConnection.totalCount` (and several other
 * counters) as `StringNumber` — a 64-bit count serialized as a
 * decimal string so the BFF never loses precision on a 2^53+ event
 * backlog. The repo convention (see `src/lib/detection/pagination.ts`)
 * is to keep the value as a string end-to-end and compare via
 * {@link BigInt}; never cast to {@link Number}.
 *
 * The Tier 2 pre-fetch modal is the first triage-side caller that
 * needs to ask "is this count above a threshold?" — these helpers
 * keep the contract explicit so future callers don't reach for
 * `Number(totalCount)` and silently break on huge corpora.
 */

/** Parse a `StringNumber` into a BigInt; returns `null` on malformed input. */
export function parseStringNumber(
  value: string | null | undefined,
): bigint | null {
  if (value === null || value === undefined) return null;
  // Reject scientific notation, signed numbers, decimals, and empty
  // strings up front so the BigInt() throw isn't silently swallowed.
  if (!/^\d+$/.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

/**
 * `true` when `totalCount > threshold` interpreting both sides as
 * non-negative integers. Returns `false` on parse failure so a
 * malformed `totalCount` does not trigger the pre-fetch modal — the
 * fetch hook falls back to a "≥ N" estimate from the cursor walk's
 * first page when the projection can't be evaluated.
 */
export function stringNumberGreaterThan(
  totalCount: string | null | undefined,
  threshold: bigint | number,
): boolean {
  const parsed = parseStringNumber(totalCount);
  if (parsed === null) return false;
  const bound = typeof threshold === "bigint" ? threshold : BigInt(threshold);
  return parsed > bound;
}

/** `0` when equal, `<0` when `a < b`, `>0` when `a > b`. */
export function compareStringNumber(
  a: string | null | undefined,
  b: string | null | undefined,
): number {
  const left = parseStringNumber(a);
  const right = parseStringNumber(b);
  if (left === null && right === null) return 0;
  if (left === null) return -1;
  if (right === null) return 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
