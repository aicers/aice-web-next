/**
 * Pure display helpers for Conn raw-event fields. Kept in the lib (not
 * the component) so they are unit-testable and shared between the table
 * and the row-detail view.
 *
 * The 64-bit counts and the duration arrive as strings (Giganto's
 * `StringNumberU64` / `StringNumberI64`) and are formatted via `BigInt`
 * — never `Number` — so precision survives above 2^53.
 */

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
