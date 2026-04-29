import { z } from "zod";

/**
 * Validation primitives shared by the per-service configuration forms.
 *
 * Mirrors the helpers in aice-web's `src/validation.rs` so that
 * client-side errors surface the same way the server-side checks
 * accept them. The wire-format regression tests in
 * `src/__tests__/lib/node/services/` exercise these against the
 * hand-authored reference fixtures under `__tests__/lib/node/fixtures/`
 * (see that directory's README for the limits of those fixtures).
 */

// The aice-web `disallow_xss_chars` set is `<>&"'/\\\`=(){}[]`. Encoding
// the set as a Set of code points (rather than a regex literal that
// embeds those chars verbatim) keeps the source free of stray quote /
// backtick characters that would confuse a naive source-text scanner.
const XSS_CODE_POINTS: ReadonlySet<number> = new Set([
  0x3c, 0x3e, 0x26, 0x22, 0x27, 0x2f, 0x5c, 0x60, 0x3d, 0x28, 0x29, 0x7b, 0x7d,
  0x5b, 0x5d,
]);

export function disallowXss(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    if (XSS_CODE_POINTS.has(value.charCodeAt(i))) return false;
  }
  return true;
}

export function noLeadingTrailingWhitespace(value: string): boolean {
  if (value.length === 0) return true;
  return value.trim() === value;
}

export function generalText(value: string): boolean {
  return disallowXss(value) && noLeadingTrailingWhitespace(value);
}

const HOSTNAME_CHARS = /^[a-z0-9.-]+$/;

export function nodeHostnameChars(value: string): boolean {
  if (value.length === 0) return false;
  if (!HOSTNAME_CHARS.test(value)) return false;
  if (value.startsWith(".") || value.startsWith("-")) return false;
  if (value.endsWith(".") || value.endsWith("-")) return false;
  return !/[.-]{2,}/.test(value);
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export function ipV4(value: string): boolean {
  const m = IPV4.exec(value);
  if (!m) return false;
  for (let i = 1; i <= 4; i += 1) {
    const part = m[i];
    if (part === undefined) return false;
    if (part.length > 1 && part.startsWith("0")) return false;
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return false;
  }
  return true;
}

/**
 * IPv6 literal validator. Accepts the canonical RFC 4291 forms
 * including `::` zero-compression and the IPv4-embedded suffix
 * (`::ffff:192.0.2.1`). Zone-id suffixes (`%eth0`) are rejected —
 * the on-the-wire socket-addr format does not carry them.
 */
export function ipV6(value: string): boolean {
  if (value.length === 0) return false;
  if (!/^[0-9a-fA-F:.]+$/.test(value)) return false;
  const doubleColons = value.match(/::/g);
  if (doubleColons && doubleColons.length > 1) return false;

  // Treat the embedded IPv4 suffix (`::ffff:192.0.2.1`) as two extra
  // 16-bit groups so the rest of the parser only deals with hex
  // groups.
  let head = value;
  let required = 8;
  if (value.includes(".")) {
    const lastColon = value.lastIndexOf(":");
    if (lastColon === -1) return false;
    const tail = value.slice(lastColon + 1);
    if (!ipV4(tail)) return false;
    required = 6;
    head = value.slice(0, lastColon);
    // For `::192.0.2.1`, slicing off the dotted-quad leaves a single
    // `:`. Restore the `::` token so the compression branch fires.
    if (head === ":") head = "::";
  }

  let parts: string[];
  if (head === "::") {
    parts = Array(required).fill("0");
  } else if (head.includes("::")) {
    const segments = head.split("::");
    if (segments.length !== 2) return false;
    const leftSeg = segments[0] ?? "";
    const rightSeg = segments[1] ?? "";
    const left = leftSeg === "" ? [] : leftSeg.split(":");
    const right = rightSeg === "" ? [] : rightSeg.split(":");
    if (left.length + right.length >= required) return false;
    const fill = required - (left.length + right.length);
    parts = [...left, ...Array(fill).fill("0"), ...right];
  } else {
    parts = head.split(":");
    if (parts.length !== required) return false;
  }

  for (const p of parts) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(p)) return false;
  }
  return true;
}

export function ipAddress(value: string): boolean {
  return ipV4(value) || ipV6(value);
}

export function portRange(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 65535;
}

const RETENTION_DURATION = /^[1-9]\d*[dwM]$/;

/**
 * Humantime-compatible retention string. The form serialises a
 * `{ value, unit }` pair into the wire string; this validator runs on
 * the wire form so a hand-edited draft surface still rejects junk.
 */
export function retentionDuration(value: string): boolean {
  return RETENTION_DURATION.test(value);
}

// ── Zod refinements ───────────────────────────────────────────────

/**
 * Localizable messages for the schema-level error strings. Each builder
 * accepts an optional `messages` object so the dialog can pass through
 * pre-translated strings from `useTranslations("nodes.dialog.validation")`,
 * keeping the rule layer pure of locale knowledge. Defaults are the
 * historic English literals so the per-service form schemas (Phase
 * Node-10) and unit tests keep working without modification — the
 * dialog's metadata form is the surface that the issue's "Hardcode
 * nothing" requirement covers.
 */
export interface NodeValidationMessages {
  required?: string;
  tooLong?: (max: number) => string;
  disallowedChar?: string;
  noWhitespace?: string;
  invalidHostname?: string;
}

const DEFAULT_MESSAGES: Required<NodeValidationMessages> = {
  required: "Required",
  tooLong: (max: number) => `Must be at most ${max} characters`,
  disallowedChar: "Disallowed character",
  noWhitespace: "No leading/trailing whitespace",
  invalidHostname: "Invalid hostname",
};

function withDefaults(
  messages?: NodeValidationMessages,
): Required<NodeValidationMessages> {
  return { ...DEFAULT_MESSAGES, ...messages };
}

export const nodeNameSchema = (max = 32, messages?: NodeValidationMessages) => {
  const m = withDefaults(messages);
  return z
    .string()
    .min(1, m.required)
    .max(max, m.tooLong(max))
    .refine(disallowXss, m.disallowedChar)
    .refine(noLeadingTrailingWhitespace, m.noWhitespace);
};

export const nodeDescriptionSchema = (
  max = 64,
  messages?: NodeValidationMessages,
) => {
  const m = withDefaults(messages);
  return z
    .string()
    .max(max, m.tooLong(max))
    .refine(disallowXss, m.disallowedChar)
    .refine(noLeadingTrailingWhitespace, m.noWhitespace);
};

export const nodeHostnameSchema = (
  max = 64,
  messages?: NodeValidationMessages,
) => {
  const m = withDefaults(messages);
  return z
    .string()
    .min(1, m.required)
    .max(max, m.tooLong(max))
    .refine(nodeHostnameChars, m.invalidHostname);
};

/**
 * Hostname schema for fields the catalog marks `Option<string>`. An
 * empty string is accepted (it serialises as an absent key); any
 * non-empty value still has to satisfy the regular hostname rule.
 */
export const nodeHostnameOptionalSchema = (
  max = 64,
  messages?: NodeValidationMessages,
) => {
  const m = withDefaults(messages);
  return z
    .string()
    .max(max, m.tooLong(max))
    .refine(
      (value) => value.length === 0 || nodeHostnameChars(value),
      m.invalidHostname,
    );
};

export const ipV4Schema = z
  .string()
  .min(1, "Required")
  .refine(ipV4, "Invalid IPv4 address");

/**
 * Accepts either an IPv4 dotted-quad or an IPv6 literal (without the
 * surrounding brackets). Service IPs are typed `IpAddr` on the Rust
 * side; the catalog calls for parsing both families in Zod.
 */
export const ipAddressSchema = z
  .string()
  .min(1, "Required")
  .refine(ipAddress, "Invalid IP address");

export const portSchema = z
  .number({ error: "Must be a number" })
  .int("Must be an integer")
  .refine(portRange, "Must be between 0 and 65535");

export const retentionUnitSchema = z.enum(["d", "w", "M"]);

export const retentionSchema = z.object({
  value: z
    .number({ error: "Must be a number" })
    .int("Must be an integer")
    .min(1, "Must be at least 1"),
  unit: retentionUnitSchema,
});

export type RetentionValue = z.infer<typeof retentionSchema>;

export function retentionToWire(r: RetentionValue): string {
  return `${r.value}${r.unit}`;
}

export function retentionFromWire(s: string): RetentionValue {
  const match = /^(\d+)([dwM])$/.exec(s);
  if (!match) throw new Error(`Invalid retention duration: ${s}`);
  const valueStr = match[1] as string;
  const unit = match[2] as "d" | "w" | "M";
  return { value: Number(valueStr), unit };
}
