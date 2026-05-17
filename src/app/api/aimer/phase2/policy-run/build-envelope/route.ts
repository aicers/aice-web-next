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
 * Cursor-chain enforcement: the server — not the browser — is the
 * authority on which slice each batch covers. A Send always starts at
 * the beginning of the run (first batch must use `after_event_key:
 * null`); each subsequent batch must use the previous batch's
 * `last_event_key`. A buggy or tampered client cannot skip events by
 * supplying an arbitrary cursor and then declaring the Send finalized.
 *
 * Per-call check order (after loading prior inflight rows):
 *
 *   1. Actor / run cross-check — the inflight rows of this Send action
 *      must all belong to the calling session and the supplied `run_id`,
 *      else `403 actor_mismatch`.
 *   2. Sequential-retry detection — if the incoming `after_event_key`
 *      matches any prior row's `after_event_key` for this
 *      `send_action_id` (including the null/null first-batch retry
 *      case), the batch has already been minted. Return
 *      `409 duplicate_batch_for_send_action` so the client can
 *      distinguish "this batch was already minted" from a real
 *      cursor-chain violation. Runs *before* the terminal and chain
 *      checks so a duplicate retry of the terminal batch surfaces as
 *      a duplicate rather than `send_already_terminal`.
 *   3. Build-after-terminal — once a row with `is_terminal = true`
 *      exists and the cursor does not match an existing batch, no
 *      further batches are accepted: `409 send_already_terminal`.
 *      Finalize is the next step.
 *   4. Cursor-chain check:
 *      - First batch (priors empty): `after_event_key` must be null,
 *        else `409 cursor_chain_mismatch`.
 *      - Subsequent batch: `after_event_key` must equal the
 *        max-`batch_index` prior row's `last_event_key`, else
 *        `409 cursor_chain_mismatch`.
 *
 * Duplicate calls are still caught at two DB-layer indexes as a
 * belt-and-braces backstop for two race windows the chain + duplicate
 * checks above cannot cover on their own:
 *
 *   - `UNIQUE (send_action_id, batch_index)` — two concurrent callers
 *     both pass the chain check at the same prior state and race the
 *     INSERT.
 *   - Partial unique indexes on `(send_action_id, after_event_key)` —
 *     two concurrent callers retrying the same request body that
 *     race the read-then-insert window of the duplicate check.
 *
 * Both raise SQLSTATE 23505, which this route translates to
 * `409 duplicate_batch_for_send_action`.
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

      // ── Chain enforcement: load prior batches for this Send ──
      //
      // Fetched before the slice build so a chain-violation reject
      // doesn't waste a SQL scan on `policy_triaged_event`.
      const { rows: priorRows } = await client.query<{
        batch_index: number;
        is_terminal: boolean;
        last_event_key: string | null;
        after_event_key: string | null;
        actor_account_id: string;
        run_id: string;
      }>(
        `SELECT batch_index,
                is_terminal,
                last_event_key::text   AS last_event_key,
                after_event_key::text  AS after_event_key,
                actor_account_id::text AS actor_account_id,
                run_id::text           AS run_id
           FROM aimer_policy_run_send_inflight
          WHERE send_action_id = $1::uuid
          ORDER BY batch_index ASC`,
        [sendActionId],
      );

      if (priorRows.length === 0) {
        // First batch of this Send: cursor must be null. The Send
        // always starts at the beginning of the run; a non-null
        // cursor on the first batch would skip earlier events.
        if (afterEventKey !== null) {
          return jsonError("cursor_chain_mismatch", 409);
        }
        batchIndex = 0;
      } else {
        // Actor + run cross-check: an existing send_action_id is
        // owned by one (actor, run) pair. A second caller cannot
        // mint additional batches for it even if they guess the
        // send_action_id — finalize also re-checks the actor, but
        // we fail fast here so a tampered build is rejected before
        // a slice is minted and signed.
        const owner = priorRows[0];
        if (
          owner.actor_account_id !== session.accountId ||
          owner.run_id !== runId
        ) {
          return jsonError("actor_mismatch", 403);
        }
        // Sequential-retry detection: if the incoming cursor matches
        // an already-minted batch's `after_event_key`, the client is
        // replaying a request whose response was lost. Surface as
        // `duplicate_batch_for_send_action` so the client can
        // distinguish a duplicate retry from a real chain violation
        // (issue #572 contract). Runs before terminal and chain
        // checks so a duplicate retry of the terminal batch surfaces
        // as a duplicate rather than `send_already_terminal`.
        if (priorRows.some((r) => r.after_event_key === afterEventKey)) {
          return jsonError("duplicate_batch_for_send_action", 409);
        }
        // Build-after-terminal: once the terminal batch has been
        // minted, the next step is finalize, not another build.
        if (priorRows.some((r) => r.is_terminal)) {
          return jsonError("send_already_terminal", 409);
        }
        // Cursor chain: this batch's `after_event_key` must equal
        // the previous batch's `last_event_key`. NUMERIC text from
        // pg compares exactly, so a string equality check is safe.
        const prior = priorRows[priorRows.length - 1];
        if (afterEventKey !== prior.last_event_key) {
          return jsonError("cursor_chain_mismatch", 409);
        }
        batchIndex = prior.batch_index + 1;
      }

      // ── Build the slice ─────────────────────────────────────
      slice = await buildPolicyRunSlice(client, runBody, afterEventKey);
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
        afterEventKey,
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
