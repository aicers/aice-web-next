/**
 * Single-customer policy: derive the set of unique customers an event
 * "belongs to" so the Send to Aimer flow (Sub-7.2.E / #440) can pick
 * exactly one customer to bind the outgoing context token to.
 *
 * Different detection event subtypes (per `src/lib/detection/queries.ts`)
 * expose different customer field shapes — some only the singular
 * `origCustomer` / `respCustomer`, some only the plural `origCustomers`
 * / `respCustomers` (e.g. `MultiHostPortScan`, `RdpBruteForce`,
 * `ExternalDdos`), and some neither.  This helper reads each shape
 * defensively, type-guards every field, deduplicates by id, and
 * coerces the GraphQL `IDScalar` (string) id to the numeric id used by
 * `auth_db.customers`.
 */
import type { Event } from "@/lib/detection/types";

export interface AimerCustomerCandidate {
  id: number;
  name: string;
}

/**
 * GraphQL `Customer { id name }` — `id` is `IDScalar` (string), `name`
 * is `String`.  Both fields are required by the schema, so a missing
 * field on the wire is a malformed payload and dropped.
 */
function isCustomerLike(value: unknown): value is { id: string; name: string } {
  if (!value || typeof value !== "object") return false;
  const obj = value as { id?: unknown; name?: unknown };
  return typeof obj.id === "string" && typeof obj.name === "string";
}

/**
 * Coerce the GraphQL string id into the numeric DB id.  Reject any
 * value that does not round-trip cleanly through `parseInt` so a
 * malformed payload cannot drift `customer_id = 7abc` into `7`.
 */
function toNumericId(raw: string): number | null {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0 || String(n) !== raw) return null;
  return n;
}

function pushIfValid(
  out: AimerCustomerCandidate[],
  seen: Set<number>,
  value: unknown,
): void {
  if (!isCustomerLike(value)) return;
  const id = toNumericId(value.id);
  if (id === null) return;
  if (seen.has(id)) return;
  seen.add(id);
  out.push({ id, name: value.name });
}

/**
 * Read the customer fields off an event and return the deduplicated
 * candidate set the Send to Aimer modal should choose from.
 *
 * - Reads `origCustomer`, `origCustomers`, `respCustomer`,
 *   `respCustomers` defensively.  Missing fields, `null`, and empty
 *   arrays are all treated as "no candidate from this slot".
 * - Type-guards each entry so a malformed payload (missing `id`,
 *   wrong type, etc.) is dropped rather than crashing the page.
 * - Deduplicates by numeric id.
 * - Returns an empty array when no candidate is present.
 */
export function extractAimerCustomerCandidates(
  event: Event,
): AimerCustomerCandidate[] {
  const e = event as Partial<{
    origCustomer: unknown;
    origCustomers: unknown;
    respCustomer: unknown;
    respCustomers: unknown;
  }>;
  const out: AimerCustomerCandidate[] = [];
  const seen = new Set<number>();

  pushIfValid(out, seen, e.origCustomer);
  if (Array.isArray(e.origCustomers)) {
    for (const entry of e.origCustomers) pushIfValid(out, seen, entry);
  }
  pushIfValid(out, seen, e.respCustomer);
  if (Array.isArray(e.respCustomers)) {
    for (const entry of e.respCustomers) pushIfValid(out, seen, entry);
  }

  return out;
}
