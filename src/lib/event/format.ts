/**
 * Pure display helpers for Conn raw-event fields. Kept in the lib (not
 * the component) so they are unit-testable and shared between the table
 * and the row-detail view.
 *
 * The 64-bit counts and the duration arrive as strings (Giganto's
 * `StringNumberU64` / `StringNumberI64`) and are formatted via `BigInt`
 * — never `Number` — so precision survives above 2^53.
 */

import type { FieldKind } from "./records";

/** Shown for an empty text/list field so cells never render blank. */
const EMPTY = "—";

/** Locale-aware labels for a `Boolean!` field, supplied by the caller. */
export interface BooleanLabels {
  /** Label for `true` (e.g. "Yes"). */
  true: string;
  /** Label for `false` (e.g. "No"). */
  false: string;
}

/**
 * Render a generic Sysmon field value by its {@link FieldKind}. This is
 * the single formatting switch the generic table/detail renderer drives
 * off the record definition — there is no per-field special-casing in
 * JSX.
 *
 * - `datetime`: shown verbatim (consistent with E0's Conn time display).
 * - `list`: a `[String!]!` joined with `, ` (empty → em dash).
 * - `boolean`: a locale-aware label from {@link BooleanLabels}.
 * - `text`: a `String!` or `StringNumber*` scalar shown as-is. The
 *   string-serialized 32/64-bit numbers are **never** coerced to a JS
 *   number, so precision is preserved; a numeric `Int` (e.g. a Sysmon
 *   network port) is stringified without locale grouping.
 */
export function formatFieldValue(
  value: unknown,
  kind: FieldKind,
  booleanLabels: BooleanLabels,
): string {
  switch (kind) {
    case "boolean":
      return value ? booleanLabels.true : booleanLabels.false;
    case "list": {
      if (!Array.isArray(value)) return value == null ? EMPTY : String(value);
      return value.length > 0 ? value.join(", ") : EMPTY;
    }
    case "datetime":
    case "text":
      return value == null || value === "" ? EMPTY : String(value);
  }
}

/**
 * Map an IP protocol number to a short label. TCP (6) and UDP (17) are
 * the common cases; anything else renders as the bare number so an
 * unexpected protocol is still legible.
 */
export function protoLabel(proto: number): string {
  switch (proto) {
    case 6:
      return "TCP";
    case 17:
      return "UDP";
    case 1:
      return "ICMP";
    default:
      return String(proto);
  }
}

/**
 * Format a `StringNumberU64` count with locale grouping. Falls back to
 * the raw string if it is not a valid integer literal, so malformed
 * upstream data is shown verbatim rather than as `NaN`.
 */
export function formatCount(value: string, locale: string): string {
  if (!/^-?\d+$/.test(value)) return value;
  try {
    return BigInt(value).toLocaleString(locale);
  } catch {
    return value;
  }
}

/**
 * Render an `addr:port` endpoint. IPv6 addresses are bracketed so the
 * port separator stays unambiguous (`[::1]:443`).
 */
export function formatEndpoint(addr: string, port: number): string {
  const host = addr.includes(":") ? `[${addr}]` : addr;
  return `${host}:${port}`;
}

const ZERO = BigInt(0);
const NS_PER_US = BigInt(1_000);
const NS_PER_MS = BigInt(1_000_000);
const NS_PER_S = BigInt(1_000_000_000);

/**
 * Format a `StringNumberI64` nanosecond duration into a compact
 * human-readable string (`ns` / `µs` / `ms` / `s`). Uses `BigInt` for
 * the magnitude check so large durations do not lose precision; the
 * fractional part is computed only after the unit is chosen.
 */
export function formatDurationNs(value: string): string {
  if (!/^-?\d+$/.test(value)) return value;
  let ns: bigint;
  try {
    ns = BigInt(value);
  } catch {
    return value;
  }
  const negative = ns < ZERO;
  const abs = negative ? -ns : ns;
  const sign = negative ? "-" : "";

  if (abs < NS_PER_US) return `${value} ns`;
  if (abs < NS_PER_MS) return `${sign}${formatFixed(abs, NS_PER_US)} µs`;
  if (abs < NS_PER_S) return `${sign}${formatFixed(abs, NS_PER_MS)} ms`;
  return `${sign}${formatFixed(abs, NS_PER_S)} s`;
}

/** Format `abs / unit` with two fractional digits, BigInt-safe. */
function formatFixed(abs: bigint, unit: bigint): string {
  let whole = abs / unit;
  const remainder = abs % unit;
  // Two fractional digits, rounded half-up.
  let scaled = (remainder * BigInt(100) + unit / BigInt(2)) / unit;
  // Carry: when the fraction rounds up to a full 100 hundredths it must
  // roll into the whole part, otherwise the two-digit formatter would emit
  // an impossible three-digit fraction (e.g. `999.100 µs` for 999995 ns).
  if (scaled >= BigInt(100)) {
    whole += BigInt(1);
    scaled -= BigInt(100);
  }
  const frac = scaled.toString().padStart(2, "0");
  return `${whole.toString()}.${frac}`;
}
