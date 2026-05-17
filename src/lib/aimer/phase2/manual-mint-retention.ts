/**
 * Retention sweep for `aimer_phase2_manual_mint` (#493 review round 1).
 *
 * The manual Send path INSERTs one row per `build-envelope` call. Most
 * rows are consumed seconds later by the matching `ack-manual`, but an
 * abandoned send (browser closed before the multipart POST returns,
 * aimer-web 4xx between build-envelope and the user's retry, etc.)
 * leaves an unconsumed row behind. Without a periodic sweep the table
 * would grow unbounded.
 *
 * The single-use `context_jti` claim in the envelope carries a
 * server-enforced TTL well under 24h, so deleting rows older than 24h
 * is safe whether consumed or not — any `ack-manual` arriving after
 * that window would already be rejected at the JTI validity layer.
 */

import "server-only";

import type pg from "pg";

import { getCustomerPool } from "@/lib/triage/policy/customer-db";

export const DEFAULT_DELETE_BATCH_SIZE = 10_000;
export const MANUAL_MINT_RETENTION_HOURS = 24;

export interface ManualMintRetentionCounts {
  pruned: number;
}

export interface ManualMintRetentionCustomerResult {
  customerId: number;
  status: "ok" | "failed";
  counts: ManualMintRetentionCounts;
  error?: string;
}

export interface ManualMintRetentionResult {
  overall: "ok" | "partial" | "failed";
  perCustomer: ManualMintRetentionCustomerResult[];
}

async function sweepCustomer(
  pool: pg.Pool,
  batchSize: number,
): Promise<number> {
  let total = 0;
  while (true) {
    const result = await pool.query(
      `DELETE FROM aimer_phase2_manual_mint
        WHERE ctid IN (
          SELECT ctid FROM aimer_phase2_manual_mint
           WHERE minted_at < NOW() - ($1 || ' hours')::INTERVAL
           LIMIT ${batchSize}
        )`,
      [String(MANUAL_MINT_RETENTION_HOURS)],
    );
    const n = result.rowCount ?? 0;
    total += n;
    if (n < batchSize) break;
  }
  return total;
}

export async function runManualMintRetentionForCustomer(
  customerId: number,
  options: { batchSize?: number } = {},
): Promise<ManualMintRetentionCounts> {
  const batchSize = options.batchSize ?? DEFAULT_DELETE_BATCH_SIZE;
  const pool = await getCustomerPool(customerId);
  const pruned = await sweepCustomer(pool, batchSize);
  return { pruned };
}

async function defaultListActiveCustomers(): Promise<number[]> {
  const { query } = await import("@/lib/db/client");
  const result = await query<{ id: number }>(
    "SELECT id FROM customers WHERE status = 'active' ORDER BY id",
  );
  return result.rows.map((r) => Number(r.id));
}

export interface ManualMintRetentionOptions {
  batchSize?: number;
  listActiveCustomers?: () => Promise<number[]>;
  runForCustomer?: (
    customerId: number,
    options: { batchSize?: number },
  ) => Promise<ManualMintRetentionCounts>;
}

export async function runManualMintRetentionDispatch(
  options: ManualMintRetentionOptions = {},
): Promise<ManualMintRetentionResult> {
  const batchSize = options.batchSize ?? DEFAULT_DELETE_BATCH_SIZE;
  const listActiveCustomers =
    options.listActiveCustomers ?? defaultListActiveCustomers;
  const runForCustomer =
    options.runForCustomer ?? runManualMintRetentionForCustomer;

  const customerIds = await listActiveCustomers();
  const perCustomer: ManualMintRetentionCustomerResult[] = [];
  for (const customerId of customerIds) {
    try {
      const counts = await runForCustomer(customerId, { batchSize });
      perCustomer.push({ customerId, status: "ok", counts });
    } catch (err) {
      perCustomer.push({
        customerId,
        status: "failed",
        counts: { pruned: 0 },
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const overall: ManualMintRetentionResult["overall"] = perCustomer.some(
    (e) => e.status === "failed",
  )
    ? "partial"
    : "ok";
  return { overall, perCustomer };
}

export function verifyAimerPhase2ManualMintRetentionToken(
  provided: string | null,
): boolean {
  const expected =
    process.env.AIMER_PHASE2_MANUAL_MINT_RETENTION_INTERNAL_TOKEN;
  if (!expected) return false;
  if (!provided) return false;
  if (provided.length !== expected.length) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}
