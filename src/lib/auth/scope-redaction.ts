import "server-only";

/**
 * Scope-aware error / log message helper (#387).
 *
 * The umbrella's principle is that an account restricted to a subset of
 * customers must not reach any path — UI, API, log, error message — that
 * exposes information about a customer outside that subset. Naive string
 * redaction (`message.replace(...)`) cannot honour this contract: the
 * helper has no way to know which substring is a customer name vs a
 * sensor name vs an unrelated word. The structured form below pushes the
 * decision back to the call site: each interpolated identifier is
 * declared as a `Reference` carrying both its kind (`customer`,
 * `sensor`, or `address`) and the customer it belongs to. The helper
 * substitutes the literal value when the caller has scope on the
 * referenced customer, and replaces it with a generic stand-in
 * otherwise.
 *
 * Call-site pattern (mechanical refactor of an embedded literal):
 *
 *     // Before (literal embedded in the format string — cannot be
 *     // redacted without parsing the string):
 *     return `Customer "${name}" not found`;
 *
 *     // After (template + structured references):
 *     return formatScopedError(
 *       {
 *         template: 'Customer "{customer}" not found',
 *         references: [
 *           { kind: "customer", id, placeholder: "customer", literal: name },
 *         ],
 *       },
 *       allowedCustomerIds,
 *     );
 *
 * The helper is deterministic and side-effect-free. It does not consult
 * the request context — every input is explicit.
 */

export type Reference =
  | {
      kind: "customer";
      id: number;
      placeholder: string;
      literal: string;
    }
  | {
      kind: "sensor";
      customerId: number;
      placeholder: string;
      literal: string;
    }
  | {
      kind: "address";
      customerId: number;
      placeholder: string;
      literal: string;
    };

export interface ScopedMessage {
  /** Template string with `{placeholder}` markers. */
  template: string;
  /** Structured references, one per `{placeholder}` in the template. */
  references: readonly Reference[];
}

const REDACTED_BY_KIND = {
  customer: "[redacted customer]",
  sensor: "[redacted sensor]",
  address: "[redacted address]",
} as const;

function customerOf(ref: Reference): number {
  return ref.kind === "customer" ? ref.id : ref.customerId;
}

/**
 * Substitute every `{placeholder}` in `template` using `references`.
 *
 * For each reference, the literal value is emitted iff the referenced
 * customer is present in `allowedCustomerIds`. Otherwise a kind-specific
 * stand-in (`[redacted customer]`, `[redacted sensor]`, `[redacted
 * address]`) is emitted in its place.
 *
 * Templates with no references degrade to a plain `template` (no
 * substitution work). A reference whose `placeholder` does not appear in
 * the template is silently ignored — the call site is responsible for
 * keeping the two in sync, but a stale reference is harmless.
 */
export function formatScopedError(
  message: ScopedMessage,
  allowedCustomerIds: readonly number[],
): string {
  if (message.references.length === 0) return message.template;
  const allowed = new Set(allowedCustomerIds);
  let out = message.template;
  for (const ref of message.references) {
    const value = allowed.has(customerOf(ref))
      ? ref.literal
      : REDACTED_BY_KIND[ref.kind];
    out = out.replaceAll(`{${ref.placeholder}}`, value);
  }
  return out;
}

/**
 * Thin alias kept for callers that prefer a positional signature
 * (`message, references, allowedCustomerIds`) over the object form.
 * Behaviour is identical to `formatScopedError`.
 */
export function redactForScope(
  template: string,
  references: readonly Reference[],
  allowedCustomerIds: readonly number[],
): string {
  return formatScopedError({ template, references }, allowedCustomerIds);
}
