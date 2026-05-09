import "server-only";

import type pg from "pg";

import { connectTo, query } from "@/lib/db/client";

/**
 * Per-process pool cache keyed by `customers.database_name`.
 *
 * The startup migration loop guarantees every active customer DB has
 * the triage_policy schema applied; we just need a connection pool to
 * reach it.
 */
const pools = new Map<string, pg.Pool>();

export class CustomerNotFoundError extends Error {
  constructor(customerId: number) {
    super(`Customer ${customerId} not found or not active`);
    this.name = "CustomerNotFoundError";
  }
}

interface CustomerDbInfo {
  databaseName: string;
}

async function lookupCustomerDb(
  customerId: number,
): Promise<CustomerDbInfo | null> {
  const { rows } = await query<{ database_name: string }>(
    "SELECT database_name FROM customers WHERE id = $1 AND status = 'active'",
    [customerId],
  );
  if (rows.length === 0) return null;
  return { databaseName: rows[0].database_name };
}

function buildCustomerUrl(databaseName: string): string {
  const base = process.env.DATABASE_URL;
  if (!base) {
    throw new Error("Missing environment variable: DATABASE_URL");
  }
  const url = new URL(base);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

/**
 * Resolve a tenant DB pool for the given customer. Throws
 * `CustomerNotFoundError` when no active customer matches. Pools are
 * cached per process by database name.
 */
export async function getCustomerPool(customerId: number): Promise<pg.Pool> {
  const info = await lookupCustomerDb(customerId);
  if (!info) throw new CustomerNotFoundError(customerId);

  const cached = pools.get(info.databaseName);
  if (cached) return cached;

  const pool = connectTo(buildCustomerUrl(info.databaseName));
  pools.set(info.databaseName, pool);
  return pool;
}

/**
 * Test/teardown hook: close every cached pool. Production code never
 * needs this — pools live for the lifetime of the process.
 */
export async function _resetCustomerPools(): Promise<void> {
  const entries = Array.from(pools.values());
  pools.clear();
  await Promise.all(entries.map((p) => p.end()));
}
