import "server-only";

import { type NextRequest, NextResponse } from "next/server";
import type pg from "pg";

import { auditLog } from "@/lib/audit/logger";
import { withAuth } from "@/lib/auth/guard";
import { extractClientIp } from "@/lib/auth/ip";
import { hasPermission } from "@/lib/auth/permissions";
import { query, withTransaction } from "@/lib/db/client";
import { insertCustomerDrainFailureSentinel } from "@/lib/triage/exclusion/recovery";
import {
  acquireCustomerCadenceLock,
  drainRemainingRetroactiveDeletes,
  executeFirstRetroactiveDeleteBatch,
} from "@/lib/triage/exclusion/retroactive-delete";
import {
  connectCustomerClient,
  createCustomerExclusion,
  listCustomerExclusions,
  StoredExclusionConflictError,
} from "@/lib/triage/exclusion/storage";
import {
  type ParsedStoredExclusion,
  parseStoredExclusionInput,
  StoredExclusionValidationError,
} from "@/lib/triage/exclusion/storage-input";
import {
  CustomerNotFoundError,
  getCustomerPool,
} from "@/lib/triage/policy/customer-db";

/**
 * GET /api/triage/exclusions?customer_id=<id>
 *
 * Lists customer-scoped triage exclusions for one customer. Requires
 * `triage:read` plus that the caller's effective customer scope
 * includes `customer_id`.
 */
export const GET = withAuth(
  async (request, _context, session) => {
    const customerId = parseCustomerId(request);
    if (customerId === null) {
      return NextResponse.json(
        { error: "Missing or invalid customer_id" },
        { status: 400 },
      );
    }
    if (
      !(await callerCanAccessCustomer(
        session.accountId,
        session.roles,
        customerId,
      ))
    ) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    try {
      const rows = await listCustomerExclusions(customerId);
      return NextResponse.json({ data: rows });
    } catch (err) {
      if (err instanceof CustomerNotFoundError) {
        return NextResponse.json({ error: err.message }, { status: 404 });
      }
      throw err;
    }
  },
  { requiredPermissions: ["triage:read"] },
);

/**
 * POST /api/triage/exclusions?customer_id=<id>
 *
 * Creates a customer-scoped exclusion. INSERT and the first DELETE
 * batch share one transaction so a crashed runner cannot leave a row
 * inserted with no DELETE applied. Subsequent batches run in separate
 * transactions; a concurrent cadence tick that sees a partially-cleaned
 * corpus is benign because the new exclusion row is already visible
 * and cadence step (c) applies it forward from that point.
 *
 * Acquires the per-customer cadence advisory lock (blocking variant)
 * before issuing the DELETE so cadence's `pg_try_advisory_xact_lock`
 * exits cleanly and resumes via `last_event_cursor`.
 */
export const POST = withAuth(
  async (request, _context, session) => {
    const customerId = parseCustomerId(request);
    if (customerId === null) {
      return NextResponse.json(
        { error: "Missing or invalid customer_id" },
        { status: 400 },
      );
    }
    if (
      !(await callerCanAccessCustomer(
        session.accountId,
        session.roles,
        customerId,
      ))
    ) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return NextResponse.json(
        { error: "Body must be a JSON object" },
        { status: 400 },
      );
    }
    const body = raw as { kind?: unknown; value?: unknown; note?: unknown };

    let parsed: ParsedStoredExclusion;
    try {
      parsed = parseStoredExclusionInput({
        kind: typeof body.kind === "string" ? body.kind : "",
        value: typeof body.value === "string" ? body.value : "",
        note:
          body.note === undefined || body.note === null
            ? null
            : typeof body.note === "string"
              ? body.note
              : "",
      });
    } catch (err) {
      if (err instanceof StoredExclusionValidationError) {
        return NextResponse.json(
          { error: err.message, field: err.field, code: err.code },
          { status: 400 },
        );
      }
      throw err;
    }

    let client: pg.PoolClient;
    try {
      client = await connectCustomerClient(customerId);
    } catch (err) {
      if (err instanceof CustomerNotFoundError) {
        return NextResponse.json({ error: err.message }, { status: 404 });
      }
      throw err;
    }

    let row: Awaited<ReturnType<typeof createCustomerExclusion>>;
    let firstBatchCounts: Awaited<
      ReturnType<typeof executeFirstRetroactiveDeleteBatch>
    >["counts"];
    let pending: Awaited<
      ReturnType<typeof executeFirstRetroactiveDeleteBatch>
    >["pending"];
    try {
      await client.query("BEGIN");
      await acquireCustomerCadenceLock(client, customerId);

      row = await createCustomerExclusion(
        customerId,
        {
          kind: parsed.kind,
          value: parsed.value,
          domainSuffix: parsed.domainSuffix,
          note: parsed.note,
          createdBy: session.accountId,
        },
        client,
      );

      const firstBatch = await executeFirstRetroactiveDeleteBatch(client, {
        kind: parsed.kind,
        value: parsed.value,
        domainSuffix: parsed.domainSuffix,
      });
      firstBatchCounts = firstBatch.counts;
      pending = firstBatch.pending;

      // Commit the INSERT + first DELETE batch together so the row is
      // durable even if the drain phase crashes. The cadence advisory
      // lock releases on COMMIT; subsequent batches run without the
      // lock per #457 — a concurrent cadence tick that sees a
      // partially-cleaned corpus is benign because the new exclusion
      // row is already visible and cadence step (c) applies it forward
      // from that point.
      await client.query("COMMIT");
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // ignore rollback failures
      }
      client.release();
      if (err instanceof StoredExclusionConflictError) {
        return NextResponse.json(
          { error: err.message, field: "value", code: "duplicate" },
          { status: 409 },
        );
      }
      throw err;
    }
    client.release();

    // Drain the remainder in fresh per-batch transactions to bound
    // lock duration and WAL pressure. Drain failures do NOT roll back
    // the INSERT — the row stays in place and forward enforcement is
    // already in effect — but a partial cleanup leaves stale corpus
    // rows that cadence will not revisit, so we surface a hard 500
    // rather than a hidden warning. Operators can refresh the list to
    // see the row and use the admin-recovery surface (1B-7) to drive
    // cleanup to completion.
    const customerPool = await getCustomerPool(customerId);
    let drainCounts: typeof firstBatchCounts | null = null;
    let drainError: unknown = null;
    if (pending.length > 0) {
      try {
        drainCounts = await drainRemainingRetroactiveDeletes(async (fn) => {
          const drainClient = await customerPool.connect();
          try {
            await drainClient.query("BEGIN");
            const result = await fn(drainClient);
            await drainClient.query("COMMIT");
            return result;
          } catch (err) {
            await drainClient.query("ROLLBACK").catch(() => {});
            throw err;
          } finally {
            drainClient.release();
          }
        }, pending);
      } catch (err) {
        drainError = err;
      }
    }
    const counts = mergeCounts(firstBatchCounts, drainCounts);

    // Enqueue (or refresh) a sentinel row in the auth_db fanout queue
    // so admin recovery (#461 / 1B-7) has a `failed` row to reset in
    // place. Audit-only signalling is not enough: without this sentinel
    // the recovery surface would need a parallel detection path.
    // Failing to enqueue must not mask the original drain error — log
    // the secondary failure and continue to the 500 response below.
    if (drainError !== null) {
      const drainMessage =
        drainError instanceof Error ? drainError.message : String(drainError);
      try {
        await withTransaction((c) =>
          insertCustomerDrainFailureSentinel(
            c,
            row.id,
            customerId,
            drainMessage,
          ),
        );
      } catch (sentinelErr) {
        // Do not throw — the 500 response already surfaces the drain
        // failure, and re-throwing here would mask it with a queue
        // error the operator cannot disambiguate from the audit row.
        console.error(
          "[triage_exclusion] failed to enqueue drain-failure sentinel",
          sentinelErr,
        );
      }
    }

    await auditLog.record({
      actor: session.accountId,
      action: "triage_exclusion.customer_add",
      target: "triage_exclusion",
      targetId: row.id,
      ip: extractClientIp(request),
      sid: session.sessionId,
      customerId,
      details: {
        id: row.id,
        kind: row.kind,
        value: row.value,
        deletedCorpusRows: counts,
        ...(drainError !== null
          ? {
              drainStatus: "failed",
              drainError:
                drainError instanceof Error
                  ? drainError.message
                  : String(drainError),
            }
          : {}),
      },
    });

    if (drainError !== null) {
      // Hard failure: the INSERT and first batch are durable (the row
      // is visible on the next list refresh) but retroactive cleanup
      // is incomplete. Returning 500 makes the dialog show the error
      // instead of silently closing — the operator must inspect state
      // and run admin recovery (1B-7) before forward enforcement can
      // be assumed to match the documented retroactive semantics.
      const message =
        drainError instanceof Error ? drainError.message : "drain phase failed";
      return NextResponse.json(
        {
          error: `Exclusion was created but retroactive cleanup failed: ${message}. The row is visible on refresh; please contact an administrator to complete past-corpus cleanup.`,
          data: row,
          partialCleanup: counts,
        },
        { status: 500 },
      );
    }
    return NextResponse.json({ data: row }, { status: 201 });
  },
  { requiredPermissions: ["triage:exclusion:write"] },
);

function mergeCounts(
  first: {
    baselineTriagedEvent: number;
    observedEventMeta: number;
    policyTriagedEvent: number | null;
  },
  drain: {
    baselineTriagedEvent: number;
    observedEventMeta: number;
    policyTriagedEvent: number | null;
  } | null,
): {
  baselineTriagedEvent: number;
  observedEventMeta: number;
  policyTriagedEvent: number | null;
} {
  if (drain === null) return first;
  return {
    baselineTriagedEvent:
      first.baselineTriagedEvent + drain.baselineTriagedEvent,
    observedEventMeta: first.observedEventMeta + drain.observedEventMeta,
    policyTriagedEvent:
      first.policyTriagedEvent === null
        ? null
        : first.policyTriagedEvent + (drain.policyTriagedEvent ?? 0),
  };
}

// ── Helpers ─────────────────────────────────────────────────────

function parseCustomerId(request: NextRequest): number | null {
  const raw = request.nextUrl.searchParams.get("customer_id");
  if (raw === null) return null;
  const id = Number(raw);
  if (!Number.isFinite(id) || !Number.isInteger(id) || id <= 0) return null;
  return id;
}

async function callerCanAccessCustomer(
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
