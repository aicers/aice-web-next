import { DetectionForbiddenError } from "./errors";
import type { Filter } from "./filter";

/**
 * BFF-side intersection check: every Detection server action that
 * accepts a {@link Filter} must reject when `filter.input.customers`
 * carries an ID outside the caller's effective customer scope.
 *
 * REview already intersects the JWT-carried scope with whatever
 * `filter.customers` the caller supplies. The check below makes the
 * BFF independently authoritative — per the project's
 * defense-in-depth principle, REview is not the only enforcement
 * point — and produces a typed rejection so the operator sees a
 * clear failure rather than partial results from a silent narrowing.
 *
 * The wire shape of `filter.input.customers` is `IDScalar[]` (i.e.
 * `string[]`), per the generated REview schema. The caller's
 * effective scope is `number[]` — the helper resolves this via
 * `resolveEffectiveCustomerIds` / `getEffectiveCustomerScope`. We
 * convert the wire string to a positive integer and reject any entry
 * that is not parseable, not finite, or non-positive: `customers.id`
 * is a `SERIAL`/`bigserial` PK, so a fractional / negative / NaN ID
 * cannot exist in the table and rejecting them up front prevents
 * `Number(NaN)` membership checks that would silently pass.
 *
 * Admins (`customers:access-all`) are not exempted: their scope is
 * already materialised into the explicit list of every registered
 * customer ID upstream, so the intersection check applies uniformly
 * and an admin selecting an unknown customer ID (e.g. `999999`, not
 * present in the `customers` table) is rejected here too.
 */
export function validateFilterScope(
  filter: Filter,
  customerIds: readonly number[],
): void {
  if (filter.mode !== "structured") return;
  const requested = filter.input.customers;
  if (!requested || requested.length === 0) return;

  const allowed = new Set<number>(customerIds);
  for (const raw of requested) {
    const parsed = parsePositiveCustomerId(raw);
    if (parsed === null) {
      throw new DetectionForbiddenError(
        `Filter references an invalid customer ID: ${String(raw)}`,
      );
    }
    if (!allowed.has(parsed)) {
      throw new DetectionForbiddenError(
        `Filter references customer ${parsed}, which is outside the caller's scope`,
      );
    }
  }
}

/**
 * Parse a wire-format `customers` entry into a positive integer.
 * Returns `null` on any non-integer / non-positive / non-finite
 * value so the validator can reject without ever falling back to a
 * loose `Number(...)` membership check.
 *
 * Exposed for tests so the parse contract can be exercised
 * independently of the surrounding scope check.
 */
export function parsePositiveCustomerId(raw: unknown): number | null {
  if (typeof raw === "number") {
    return Number.isInteger(raw) && raw > 0 ? raw : null;
  }
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  // Match a strictly positive integer with no leading sign or
  // decimal point. `Number("0x10")` would otherwise pass the
  // `Number.isInteger` check below.
  if (!/^[1-9][0-9]*$/.test(trimmed)) return null;
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}
