/**
 * Pure display helpers for network raw-event fields. Kept in the lib
 * (not the component) so they are unit-testable and shared between the
 * generic results table and the row-detail view.
 *
 * The 64-bit counts and the duration arrive as strings (Giganto's
 * `StringNumber*` scalars) and are formatted via `BigInt` — never
 * `Number` — so precision survives above 2^53.
 */

import type { FieldFormat, ScalarKind } from "./descriptors";
import type { RawEventFieldValue } from "./types";

/** Placeholder shown for empty strings and empty lists. */
export const EMPTY_VALUE = "—";

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

/**
 * Render a single scalar field value as display text, driven by its
 * descriptor `scalar` kind (and optional `format` override). This is the
 * shared mapping the generic table and detail view both use, so a field
 * is formatted identically wherever it appears.
 *
 *   - `proto` → protocol label; `duration`-formatted `i64` → human
 *     duration; the other `StringNumber*` kinds → grouped counts.
 *   - empty strings collapse to {@link EMPTY_VALUE}.
 *
 * Non-scalar kinds (lists, byte matrices, sub-records) are not handled
 * here — the callers render those structurally; see {@link summaryText}
 * for their compact one-line form.
 */
export function scalarText(
  value: RawEventFieldValue | undefined,
  scalar: ScalarKind,
  format: FieldFormat | undefined,
  locale: string,
): string {
  if (value === undefined || value === null) return EMPTY_VALUE;
  if (format === "proto" && typeof value === "number") {
    return protoLabel(value);
  }
  if (format === "duration" && typeof value === "string") {
    return formatDurationNs(value);
  }
  switch (scalar) {
    case "bool":
      return value ? "true" : "false";
    case "u64":
    case "i64":
    case "u32":
    case "usize":
      return formatCount(String(value), locale);
    case "int":
      return String(value);
    default:
      // string / datetime
      return value === "" ? EMPTY_VALUE : String(value);
  }
}

/** Join a list of scalars for compact display, or {@link EMPTY_VALUE}. */
export function listText(values: ReadonlyArray<string | number>): string {
  return values.length > 0 ? values.join(", ") : EMPTY_VALUE;
}

/**
 * Compact one-line text for any field value, including the non-scalar
 * kinds — used for table cells where structural rendering is not
 * possible. Lists join with commas; byte matrices and sub-records
 * collapse to a count so a wide field stays a single readable cell.
 */
export function summaryText(
  value: RawEventFieldValue | undefined,
  scalar: ScalarKind,
  format: FieldFormat | undefined,
  locale: string,
): string {
  if (value === undefined || value === null) return EMPTY_VALUE;
  switch (scalar) {
    case "stringList":
    case "intList":
      return Array.isArray(value)
        ? listText(value as Array<string | number>)
        : EMPTY_VALUE;
    case "intMatrix":
      return Array.isArray(value) ? String(value.length) : EMPTY_VALUE;
    case "sub:dceRpcContext":
    case "sub:ftpCommand":
    case "sub:dhcpOption":
      return Array.isArray(value) ? String(value.length) : EMPTY_VALUE;
    default:
      return scalarText(value, scalar, format, locale);
  }
}
