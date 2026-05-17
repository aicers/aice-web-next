import "server-only";

import { NextResponse } from "next/server";

import { auditLog } from "@/lib/audit/logger";
import { resolveEffectiveCustomerIds } from "@/lib/auth/customer-scope";
import { withAuth } from "@/lib/auth/guard";
import { extractClientIp } from "@/lib/auth/ip";
import { hasPermission } from "@/lib/auth/permissions";
import { getCustomerPool } from "@/lib/triage/policy/customer-db";

/**
 * `POST /api/aimer/phase2/policy-run/finalize`
 *
 * Per RFC 0002 §6 / sub-issue #572. Closes one Send action after the
 * browser has POSTed every batch to aimer-web. The browser supplies a
 * `batch_acks` array containing one entry per batch (the parsed
 * aimer-web ack body); the server validates, commits β tracking +
 * inflight cleanup in the customer DB transaction, then writes the
 * `triage.policy_run.send_to_aimer` audit row best-effort against
 * `audit_db` (see the cross-DB consistency note below).
 *
 * Validation is set-equality, checked in this order so error responses
 * are unambiguous:
 *
 *   1. `batch_acks` non-empty + well-formed shape — 400 on miss.
 *   2. No duplicate `context_jti` values in `batch_acks` — 409
 *      `duplicate_jti_in_batch_acks`. (Checked **before** set membership
 *      so a duplicate cannot accidentally satisfy "every inflight jti
 *      reported".)
 *   3. The multiset of `batch_acks.context_jti` equals the set of
 *      `aimer_policy_run_send_inflight.context_jti` rows for
 *      `(customer_id, run_id, send_action_id)` — 409
 *      `batch_acks_mismatch` on any discrepancy.
 *   4. The inflight row marked `is_terminal = true` is among the
 *      reported jtis — 409 `terminal_batch_missing`.
 *   5. The session's account id matches the inflight rows'
 *      `actor_account_id` — 403 `actor_mismatch`. (Cross-checks that a
 *      different operator cannot finalize someone else's Send even with
 *      a correct `send_action_id`.)
 *
 * Any 4xx leaves β / audit / inflight rows untouched. On success β
 * tracking (`send_count`, `last_sent_at`, `last_sent_by`) is updated
 * once per Send action (regardless of batch count) and the audit row
 * is emitted with `batchCount`, `eventCount`, `totalAccepted`,
 * `totalDuplicatesSkipped` aggregated from `batch_acks`.
 *
 * Cross-DB consistency note: β / inflight live in the customer DB,
 * audit lives in `audit_db`. PostgreSQL does not support cross-DB
 * transactions and we deliberately do not run two-phase commit for an
 * audit-quality observation. We commit the customer DB transaction
 * first so the operator's β state is durable, then best-effort write
 * the audit row outside the transaction. An audit write failure is
 * logged but does NOT 500 the caller — β already reflects the
 * successful Send, and a stale audit row is less harmful than telling
 * the operator the Send failed when it succeeded. Operators monitor
 * audit-write failures via the structured log line, not via the API
 * response.
 */

const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DECIMAL_STRING_REGEX = /^\d+$/;

// Strict-ish ISO 8601 / RFC 3339 timestamp shape. The browser ack
// reporter is untrusted; this rejects blatantly malformed strings
// before they land in audit `details.receivedAt` aggregates. Allows
// optional fractional seconds and either `Z` or `±HH:MM` offset.
const ISO_8601_REGEX =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

interface BatchAckInput {
  context_jti: string;
  received_at: string;
  accepted: number;
  duplicates_skipped: number;
}

interface RequestBody {
  customer_id?: unknown;
  run_id?: unknown;
  send_action_id?: unknown;
  batch_acks?: unknown;
}

function jsonError(error: string, status: number): NextResponse {
  return NextResponse.json({ error }, { status });
}

function parseBatchAcks(raw: unknown): BatchAckInput[] | null {
  if (!Array.isArray(raw)) return null;
  if (raw.length === 0) return null;
  const parsed: BatchAckInput[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") return null;
    const e = entry as Record<string, unknown>;
    if (typeof e.context_jti !== "string" || e.context_jti.length === 0) {
      return null;
    }
    // received_at must look like an ISO 8601 timestamp. The browser
    // produced it from the aimer-web ack body; a malformed value here
    // suggests a tampered or buggy client and shouldn't be persisted
    // verbatim into audit `details`.
    if (
      typeof e.received_at !== "string" ||
      !ISO_8601_REGEX.test(e.received_at)
    ) {
      return null;
    }
    // accepted / duplicates_skipped: non-negative integers. The client
    // is untrusted — a negative value would corrupt the audit row's
    // `eventCount` / `totalAccepted` / `totalDuplicatesSkipped` totals.
    if (
      typeof e.accepted !== "number" ||
      !Number.isInteger(e.accepted) ||
      e.accepted < 0
    ) {
      return null;
    }
    if (
      typeof e.duplicates_skipped !== "number" ||
      !Number.isInteger(e.duplicates_skipped) ||
      e.duplicates_skipped < 0
    ) {
      return null;
    }
    parsed.push({
      context_jti: e.context_jti,
      received_at: e.received_at,
      accepted: e.accepted,
      duplicates_skipped: e.duplicates_skipped,
    });
  }
  return parsed;
}

export const POST = withAuth(
  async (request, _context, session) => {
    let body: RequestBody;
    try {
      body = (await request.json()) as RequestBody;
    } catch {
      return jsonError("invalid_json", 400);
    }

    if (
      typeof body.customer_id !== "number" ||
      !Number.isInteger(body.customer_id) ||
      body.customer_id <= 0
    ) {
      return jsonError("invalid_customer_id", 400);
    }
    const customerId = body.customer_id;

    if (
      typeof body.run_id !== "string" ||
      !DECIMAL_STRING_REGEX.test(body.run_id)
    ) {
      return jsonError("invalid_run_id", 400);
    }
    const runId = body.run_id;

    if (
      typeof body.send_action_id !== "string" ||
      !UUID_V4_REGEX.test(body.send_action_id)
    ) {
      return jsonError("invalid_send_action_id", 400);
    }
    const sendActionId = body.send_action_id;

    const batchAcks = parseBatchAcks(body.batch_acks);
    if (!batchAcks) {
      return jsonError("invalid_batch_acks", 400);
    }

    // ── Step 2: reject duplicate jti in `batch_acks` BEFORE the set
    //    membership check, so a duplicate cannot satisfy "every inflight
    //    jti reported".
    const seenJtis = new Set<string>();
    for (const ack of batchAcks) {
      if (seenJtis.has(ack.context_jti)) {
        return jsonError("duplicate_jti_in_batch_acks", 409);
      }
      seenJtis.add(ack.context_jti);
    }

    // ── Customer access check ─────────────────────────────────
    const isAdmin = await hasPermission(session.roles, "customers:access-all");
    if (!isAdmin) {
      const ids = await resolveEffectiveCustomerIds(
        session.accountId,
        session.roles,
      );
      if (!ids.includes(customerId)) {
        return jsonError("not_found", 404);
      }
    }

    const pool = await getCustomerPool(customerId);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // ── Look up inflight rows for this Send action (FOR UPDATE) ──
      const { rows: inflightRows } = await client.query<{
        context_jti: string;
        run_id: string;
        actor_account_id: string;
        batch_index: number;
        is_terminal: boolean;
      }>(
        `SELECT context_jti,
                run_id::text           AS run_id,
                actor_account_id::text AS actor_account_id,
                batch_index,
                is_terminal
           FROM aimer_policy_run_send_inflight
          WHERE run_id = $1::bigint
            AND send_action_id = $2::uuid
          ORDER BY batch_index ASC
          FOR UPDATE`,
        [runId, sendActionId],
      );

      if (inflightRows.length === 0) {
        await client.query("ROLLBACK");
        return jsonError("send_action_not_found", 404);
      }

      // ── Step 5 (early): actor identity match ─────────────────
      //
      // Checked before set-equality so a probing caller who guessed a
      // `send_action_id` gets a 403 (auth failure) rather than a
      // misleading 409 about jtis they could not possibly have known.
      const inflightActor = inflightRows[0].actor_account_id;
      const sameActor = inflightRows.every(
        (r) => r.actor_account_id === inflightActor,
      );
      if (!sameActor || inflightActor !== session.accountId) {
        await client.query("ROLLBACK");
        return jsonError("actor_mismatch", 403);
      }

      // ── Step 3: set equality of jtis ─────────────────────────
      const inflightJtis = new Set(inflightRows.map((r) => r.context_jti));
      if (inflightJtis.size !== batchAcks.length) {
        await client.query("ROLLBACK");
        return jsonError("batch_acks_mismatch", 409);
      }
      for (const ack of batchAcks) {
        if (!inflightJtis.has(ack.context_jti)) {
          await client.query("ROLLBACK");
          return jsonError("batch_acks_mismatch", 409);
        }
      }
      // After cardinality + every-ack-in-inflight, the multiset equality
      // holds because the duplicate-in-acks check (step 2) guaranteed
      // the acks side is a set, not a multiset.

      // ── Step 4: terminal row reported ────────────────────────
      const terminalRow = inflightRows.find((r) => r.is_terminal);
      if (!terminalRow) {
        // Shouldn't happen if build-envelope is well-behaved (the
        // terminal flag is set on the `has_more === false` batch).
        // Defend against a corrupted inflight set anyway.
        await client.query("ROLLBACK");
        return jsonError("terminal_batch_missing", 409);
      }
      const ackedJtis = new Set(batchAcks.map((a) => a.context_jti));
      if (!ackedJtis.has(terminalRow.context_jti)) {
        await client.query("ROLLBACK");
        return jsonError("terminal_batch_missing", 409);
      }

      // ── Aggregate ack totals for β / audit ───────────────────
      let totalAccepted = 0;
      let totalDuplicatesSkipped = 0;
      for (const ack of batchAcks) {
        totalAccepted += ack.accepted;
        totalDuplicatesSkipped += ack.duplicates_skipped;
      }
      const batchCount = batchAcks.length;

      // ── Load run metadata for the audit row + verify still
      //    eligible. A run could in principle have flipped to
      //    `superseded` between Send start and finalize; we still
      //    write β / audit (the operator's analytical question was
      //    asked against a snapshot of the run that aimer-web has now
      //    seen). Reject only on `failed`/`computing` since the
      //    snapshot would be incoherent.
      const { rows: runRows } = await client.query<{
        status: "computing" | "ready" | "failed" | "superseded";
        baseline_version: string;
        policies_fingerprint: string;
        exclusions_fingerprint: string;
      }>(
        `SELECT status,
                baseline_version,
                policies_fingerprint,
                exclusions_fingerprint
           FROM policy_triage_run
          WHERE id = $1::bigint
          FOR UPDATE`,
        [runId],
      );
      const run = runRows[0];
      if (!run) {
        await client.query("ROLLBACK");
        return jsonError("not_found", 404);
      }
      if (run.status !== "ready" && run.status !== "superseded") {
        await client.query("ROLLBACK");
        return jsonError("run_not_eligible", 409);
      }

      // ── β tracking: one update per Send action ───────────────
      await client.query(
        `UPDATE policy_triage_run
            SET send_count   = send_count + 1,
                last_sent_at = NOW(),
                last_sent_by = $2::uuid
          WHERE id = $1::bigint`,
        [runId, session.accountId],
      );

      // ── Delete inflight rows for this Send ───────────────────
      await client.query(
        `DELETE FROM aimer_policy_run_send_inflight
           WHERE send_action_id = $1::uuid`,
        [sendActionId],
      );

      await client.query("COMMIT");

      // ── Audit (post-commit; β / inflight already durable) ────
      //
      // β/inflight are in the customer DB; audit is in `audit_db`.
      // Cross-DB transactions aren't supported by PostgreSQL, so we
      // commit β first (the operator's source-of-truth) and write the
      // audit row as best-effort observability. An audit-DB outage
      // would otherwise leave β unsaved with the operator seeing a
      // 500 even though the Send succeeded — that's worse than a
      // stale audit row.
      //
      // Audit failures are logged structured and the response is still
      // 200; operators monitor for the log line instead of the HTTP
      // status. The β row's `send_count` increment is the operational
      // record that the Send happened.
      const eventCount = totalAccepted + totalDuplicatesSkipped;
      try {
        await auditLog.record({
          actor: session.accountId,
          action: "triage.policy_run.send_to_aimer",
          target: "triage_policy_run",
          targetId: runId,
          ip: extractClientIp(request),
          sid: session.sessionId,
          customerId,
          details: {
            runId,
            sendActionId,
            policiesFingerprint: run.policies_fingerprint,
            exclusionsFingerprint: run.exclusions_fingerprint,
            baselineVersion: run.baseline_version,
            eventCount,
            batchCount,
            totalAccepted,
            totalDuplicatesSkipped,
            result: "ok",
          },
        });
      } catch (auditErr) {
        console.error(
          JSON.stringify({
            level: "error",
            msg: "policy_run.send_to_aimer audit write failed; β already committed",
            customerId,
            runId,
            sendActionId,
            batchCount,
            eventCount,
            error:
              auditErr instanceof Error ? auditErr.message : String(auditErr),
          }),
        );
      }

      return NextResponse.json({
        ok: true,
        run_id: runId,
        send_action_id: sendActionId,
        batch_count: batchCount,
        event_count: eventCount,
        total_accepted: totalAccepted,
        total_duplicates_skipped: totalDuplicatesSkipped,
      });
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // ignore — connection may already be aborted
      }
      throw err;
    } finally {
      client.release();
    }
  },
  {
    requiredPermissions: ["triage:read"],
  },
);
