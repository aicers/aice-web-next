import "server-only";

import { hasPermission } from "@/lib/auth/permissions";
import { query } from "@/lib/db/client";

import { hmacAccountId } from "./hmac";
import { recordAction, recordImpressions } from "./storage";
import type { EngagementAction, EngagementImpressionBatch } from "./types";

/**
 * Customer-scope guard for the engagement endpoint. Mirrors the
 * existing exclusions route check: the caller must either hold
 * `customers:access-all` or have an explicit
 * `account_customer (account_id, customer_id)` row.
 */
export async function callerCanAccessCustomer(
  accountId: string,
  roles: string[],
  customerId: number,
): Promise<boolean> {
  if (await hasPermission(roles, "customers:access-all")) return true;
  const { rows } = await query<{ customer_id: number }>(
    "SELECT customer_id FROM account_customer WHERE account_id = $1 AND customer_id = $2",
    [accountId, customerId],
  );
  return rows.length > 0;
}

/**
 * Ingest one impression batch. The caller is responsible for the
 * customer-scope check; this helper consumes an already-authorized
 * call.
 */
export async function ingestImpressionBatch(
  accountId: string,
  batch: EngagementImpressionBatch,
): Promise<{ inserted: number }> {
  const inserted = await recordImpressions(hmacAccountId(accountId), batch);
  return { inserted };
}

/**
 * Ingest one engagement action. Used by both the HTTP route (client-
 * initiated actions) and server-side capture points (e.g. the
 * exclusion route emits an `exclusion_create` row inline).
 */
export async function ingestEngagementAction(
  accountId: string,
  action: EngagementAction,
): Promise<void> {
  await recordAction(hmacAccountId(accountId), action);
}
