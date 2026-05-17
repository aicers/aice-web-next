import "server-only";

import { NextResponse } from "next/server";

import { buildPhase2Push } from "@/lib/aimer/phase2/orchestrate";
import {
  buildPolicyRunSlice,
  loadPolicyRunForSend,
  PolicyRunLoadError,
} from "@/lib/aimer/phase2/policy-run-payload";
import {
  insertPolicyRunSendInflight,
  PG_UNIQUE_VIOLATION,
  pruneExpiredPolicyRunSendInflight,
} from "@/lib/aimer/phase2/policy-run-send";
import { getAimerIntegrationSetup } from "@/lib/aimer/setup-status";
import { resolveEffectiveCustomerIds } from "@/lib/auth/customer-scope";
import { withAuth } from "@/lib/auth/guard";
import { hasPermission } from "@/lib/auth/permissions";
import { getCustomerPool } from "@/lib/triage/policy/customer-db";

/**
 * `POST /api/aimer/phase2/policy-run/build-envelope`
 *
 * Per RFC 0002 §6 / sub-issue #572. Manual-only Send-to-aimer for a
 * `policy_triage_run` row. Each call mints one batch of the multi-batch
 * Send identified by `send_action_id`; the browser loops until
 * `has_more === false` and then calls
 * `/api/aimer/phase2/policy-run/finalize`.
 *
 * Per-call contract:
 *
 *   1. Validate tenant scope on `customer_id` (caller-supplied).
 *   2. Opportunistically prune expired
 *      `aimer_policy_run_send_inflight` rows.
 *   3. Load the run (`ready` or `superseded` only) and the next slice
 *      of `policy_triaged_event` rows past `after_event_key`.
 *   4. Sign the multipart components via {@link buildPhase2Push}.
 *   5. Insert an inflight row keyed on the freshly minted `context_jti`,
 *      tagged with `(send_action_id, batch_index, is_terminal,
 *      last_event_key, actor_account_id)`.
 *   6. Return the multipart components + full aimer endpoint URL.
 *
 * Duplicate calls with the same `(send_action_id, batch_index)` (e.g.,
 * a browser retry between mint and POST) hit the
 * `UNIQUE (send_action_id, batch_index)` constraint and return
 * `409 duplicate_batch_for_send_action`. The browser is expected to
 * resume from the prior response's `last_event_key_in_batch`.
 */

const POLICY_RUN_SCHEMA_VERSION = "phase2.policy_run.v1" as const;
const POLICY_RUN_AIMER_PATH = "/api/phase2/policy-run" as const;

const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DECIMAL_STRING_REGEX = /^\d+$/;

interface RequestBody {
  customer_id?: unknown;
  run_id?: unknown;
  send_action_id?: unknown;
  after_event_key?: unknown;
}

export interface BuildEnvelopeResponseBody {
  context_token: string;
  events_envelope: string;
  events_data: string;
  context_jti: string;
  aimer_endpoint_path: string;
  aimer_endpoint_url: string;
  batch_jti: string;
  schema_version: typeof POLICY_RUN_SCHEMA_VERSION;
  /**
   * The `event_key` the next batch should pass as `after_event_key`.
   * Null only when the slice is empty (terminal batch of a zero-event
   * run). Typed `string | null` (never `undefined`) so an empty
   * terminal slice round-trips without ambiguity.
   */
  last_event_key_in_batch: string | null;
  has_more: boolean;
  batch_index: number;
  event_count: number;
}

function jsonError(error: string, status: number): NextResponse {
  return NextResponse.json({ error }, { status });
}

function composeAimerEndpointUrl(bridgeUrl: string, path: string): string {
  const trimmed = bridgeUrl.replace(/\/+$/, "");
  return `${trimmed}${path}`;
}

function isPgUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === PG_UNIQUE_VIOLATION
  );
}

export const POST = withAuth(
  async (request, _context, session) => {
    // ── Parse body ────────────────────────────────────────────
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

    let afterEventKey: string | null = null;
    if (body.after_event_key !== undefined && body.after_event_key !== null) {
      if (
        typeof body.after_event_key !== "string" ||
        !DECIMAL_STRING_REGEX.test(body.after_event_key)
      ) {
        return jsonError("invalid_after_event_key", 400);
      }
      afterEventKey = body.after_event_key;
    }

    // ── Customer access check ────────────────────────────────
    const isAdmin = await hasPermission(session.roles, "customers:access-all");
    if (!isAdmin) {
      const ids = await resolveEffectiveCustomerIds(
        session.accountId,
        session.roles,
      );
      if (!ids.includes(customerId)) {
        // Use 404 (not 403) so a tenant-out-of-scope caller cannot probe
        // for run existence — mirrors the policy-event drain pattern.
        return jsonError("not_found", 404);
      }
    }

    // ── Pool + opportunistic prune ───────────────────────────
    const pool = await getCustomerPool(customerId);
    await pruneExpiredPolicyRunSendInflight(customerId);

    // ── Load run (rejects 'computing' / 'failed' / missing) ──
    const client = await pool.connect();
    let runBody: Awaited<ReturnType<typeof loadPolicyRunForSend>>;
    let slice: Awaited<ReturnType<typeof buildPolicyRunSlice>>;
    let batchIndex: number;
    try {
      try {
        runBody = await loadPolicyRunForSend(client, runId);
      } catch (err) {
        if (err instanceof PolicyRunLoadError) {
          if (err.code === "run_not_found") {
            return jsonError("not_found", 404);
          }
          return jsonError(err.code, 409);
        }
        throw err;
      }

      // ── Build the slice ─────────────────────────────────────
      slice = await buildPolicyRunSlice(client, runBody, afterEventKey);

      // Derive batch_index from the count of already-minted batches for
      // this send_action_id. Read-then-write is racy across concurrent
      // duplicate calls, but the UNIQUE (send_action_id, batch_index)
      // constraint serializes them at INSERT time below.
      const { rows: priorRows } = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM aimer_policy_run_send_inflight
          WHERE send_action_id = $1::uuid`,
        [sendActionId],
      );
      batchIndex = Number(priorRows[0]?.count ?? "0");
    } finally {
      client.release();
    }

    // ── Verify aimer integration setup ───────────────────────
    const setup = await getAimerIntegrationSetup();
    if (!setup.aiceId || !setup.bridgeUrl || !setup.hasActiveSigningKey) {
      return jsonError("aimer_integration_not_configured", 503);
    }

    // ── Sign multipart components ────────────────────────────
    let tokens: Awaited<ReturnType<typeof buildPhase2Push>>;
    try {
      tokens = await buildPhase2Push({
        schemaVersion: POLICY_RUN_SCHEMA_VERSION,
        customerId,
        accountId: session.accountId,
        payload: slice.payload,
      });
    } catch (err) {
      // Surface configuration / customer-resolution failures distinctly
      // so the browser can show a meaningful error rather than retrying
      // a doomed call.
      const code = (err as { code?: unknown })?.code;
      if (typeof code === "string") {
        return jsonError(code, 503);
      }
      throw err;
    }

    // ── Record inflight (with 409 on duplicate-batch collision) ──
    try {
      await insertPolicyRunSendInflight(customerId, {
        contextJti: tokens.context_jti,
        sendActionId,
        runId,
        actorAccountId: session.accountId,
        batchIndex,
        isTerminal: !slice.hasMore,
        lastEventKey: slice.lastEventKey,
      });
    } catch (err) {
      if (isPgUniqueViolation(err)) {
        return jsonError("duplicate_batch_for_send_action", 409);
      }
      throw err;
    }

    const responseBody: BuildEnvelopeResponseBody = {
      context_token: tokens.context_token,
      events_envelope: tokens.events_envelope,
      events_data: tokens.events_data,
      context_jti: tokens.context_jti,
      aimer_endpoint_path: POLICY_RUN_AIMER_PATH,
      aimer_endpoint_url: composeAimerEndpointUrl(
        setup.bridgeUrl,
        POLICY_RUN_AIMER_PATH,
      ),
      batch_jti: tokens.context_jti,
      schema_version: POLICY_RUN_SCHEMA_VERSION,
      last_event_key_in_batch: slice.lastEventKey,
      has_more: slice.hasMore,
      batch_index: batchIndex,
      event_count: slice.eventCount,
    };
    return NextResponse.json(responseBody);
  },
  {
    requiredPermissions: ["triage:read"],
  },
);
