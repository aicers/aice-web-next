import "server-only";

/**
 * Shared active-customer enumerator for the triage fan-out paths
 * (issue #701).
 *
 * Both the 15-minute baseline cadence dispatcher (`./dispatcher.ts`)
 * and the hourly low-and-slow sweep dispatcher
 * (`./lowslow-dispatcher.ts`) need the same
 * `SELECT id FROM customers WHERE status = 'active'` enumeration.
 * Factored here so the query lives in one place rather than being
 * copied per dispatcher; each dispatcher still accepts a
 * `listActiveCustomers` override so tests can inject a fake.
 */
export async function listActiveCustomers(): Promise<number[]> {
  // Imported lazily so test harnesses that stub `listActiveCustomers`
  // never load the real `pg` client (and therefore never fail to read
  // `DATABASE_URL`).
  const { query } = await import("@/lib/db/client");
  const result = await query<{ id: number }>(
    "SELECT id FROM customers WHERE status = 'active' ORDER BY id",
  );
  return result.rows.map((r) => Number(r.id));
}
