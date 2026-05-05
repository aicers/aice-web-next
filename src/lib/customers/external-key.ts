/**
 * Validation and normalization for `customers.external_key` (#438).
 *
 * `external_key` is the cross-system bridge identifier paired with the
 * matching customer on aimer-web. The value is operator-supplied,
 * globally unique (DB-enforced), and may be NULL while a customer is
 * not yet onboarded for Send to Aimer.
 *
 * Input rules (see #438 scope):
 *   - omitted / `null` / empty / whitespace-only → stored as NULL.
 *     Empty/whitespace is treated as "operator chose not to set it"
 *     so the UI can clear the field by submitting an empty input.
 *   - non-empty string → `trim()`, max 256 chars, no control chars.
 *   - UNIQUE conflict from the DB is surfaced separately as a 409.
 */

export class ExternalKeyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExternalKeyValidationError";
  }
}

export const EXTERNAL_KEY_MAX_LENGTH = 256;

// Matches C0 + DEL + C1 control characters. We reject these so the
// stored value remains safe to render in operator UIs and embed in the
// context-token claim that aimer-web reads (see #439).
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control chars is the intent
const CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f]/;

/**
 * Normalize a raw `external_key` field from a request body.
 *
 * Returns one of:
 *   - `undefined` — key was omitted from the body (caller decides whether
 *     that means "no change" or "store NULL").
 *   - `null` — explicit clear (`null`, empty, or whitespace-only).
 *   - `string` — trimmed, validated, ready to persist.
 *
 * Throws {@link ExternalKeyValidationError} for malformed inputs
 * (wrong type, too long, control characters).
 */
export function normalizeExternalKey(raw: unknown): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== "string") {
    throw new ExternalKeyValidationError("external_key must be a string");
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > EXTERNAL_KEY_MAX_LENGTH) {
    throw new ExternalKeyValidationError(
      `external_key must be at most ${EXTERNAL_KEY_MAX_LENGTH} characters`,
    );
  }
  if (CONTROL_CHARS.test(trimmed)) {
    throw new ExternalKeyValidationError(
      "external_key must not contain control characters",
    );
  }
  return trimmed;
}

const PG_UNIQUE_VIOLATION = "23505";

export function isPgUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === PG_UNIQUE_VIOLATION
  );
}

/**
 * True when a Postgres unique-violation came from the
 * `customers.external_key` UNIQUE constraint (rather than e.g.
 * `database_name`). pg surfaces the constraint name on the error.
 */
export function isExternalKeyUniqueViolation(err: unknown): boolean {
  if (!isPgUniqueViolation(err)) return false;
  const constraint = (err as { constraint?: unknown }).constraint;
  return constraint === "customers_external_key_key";
}
