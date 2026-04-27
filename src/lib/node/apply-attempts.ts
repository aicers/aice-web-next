"use server";

/**
 * Public server-action surface for the ApplyAttempt subsystem.
 *
 * IMPORTANT — production-safety boundary (#359):
 * THIS MODULE EXPORTS EXACTLY ONE SERVER ACTION: `createApplyAttempt`.
 * Adding a new exported `"use server"` action from this file changes
 * the public network surface of the BFF and MUST be a deliberate
 * decision — the static-analysis acceptance test in
 * `src/__tests__/lib/node/apply-attempts-public-surface.test.ts`
 * fails CI if a new export slips in.
 *
 * `confirmApplyAttempt` and `retryDispatch` deliberately live in
 * `apply-attempt-lifecycle.ts` (which does NOT carry `"use server"`)
 * and are exported only under `_internal_*` names. #361 (Phase
 * Node-9c) will add real `confirmApplyAttempt` / `retryDispatch`
 * server actions wrapping the internal entry points and binding the
 * production GraphQL dispatcher.
 *
 * `createApplyAttempt` is a pure read + DB persist. It runs
 * `buildDispatchContext(session)`, requires both `nodes:write` and
 * `services:write`, reads the manager-DB pending drafts via the
 * production manager GraphQL read layer (#308), and persists a row.
 * It DOES NOT call any manager or external mutation, so wiring it to
 * the production GraphQL read path from day one is safe.
 */

import { randomUUID } from "node:crypto";
import type { AuthSession } from "@/lib/auth/jwt";
import { hasPermission } from "@/lib/auth/permissions";
import { query } from "@/lib/db/client";
import { graphqlRequest } from "@/lib/graphql/client";

import {
  computeDraftFingerprint,
  type NodeDraftSnapshot,
} from "./apply-attempt-lifecycle";
import {
  type CreateApplyAttemptResult,
  getAttemptTtlMs,
  type PlannedDispatch,
} from "./apply-attempt-types";
import {
  assertNodeInScope,
  buildDispatchContext,
  type DispatchContext,
  SYSTEM_ADMINISTRATOR,
} from "./dispatch-context";
import {
  withManagerErrorMapping,
  withNodeNotFoundMapping,
} from "./error-mapping";
import { NodeNotFoundError, NodePermissionError } from "./errors";
import { NODE_DETAIL_QUERY } from "./queries";
import type { ExternalServiceKind, Node, NodeDetailResult } from "./types";

const NODES_WRITE = "nodes:write";
const SERVICES_WRITE = "services:write";

/**
 * Build and persist a new apply plan for the given node.
 *
 * Steps:
 *   1. Permission check — `nodes:write` AND `services:write`. Both
 *      gates are required because an apply plan touches both node-
 *      metadata and per-service drafts (umbrella combined-gate rule).
 *   2. Build dispatch context — materialises tenant scope. Fails for
 *      callers with no resolvable customer scope.
 *   3. Read the canonical Node from review-web via the production
 *      manager GraphQL transport (#308). The read path is the same
 *      `graphqlRequest` call site as `getNode`, so the test harness
 *      seam (`vi.mock("@/lib/graphql/client")`) catches it without
 *      a swapped-in reader.
 *   4. Defense-in-depth: assert the node is in the caller's customer
 *      scope (`assertNodeInScope`).
 *   5. Build the plan: a single `MANAGER` dispatch (no frozen `new`,
 *      re-derived per attempt at step 5d) followed by one external
 *      dispatch per pending external-service draft (each with its
 *      frozen `new`).
 *   6. Compute `draftFingerprint` over the involved manager-DB draft
 *      state in canonical key order. Persist the row with
 *      `status = 'pending'`, `executing_lock = NULL`, `claim_started_at = NULL`,
 *      `expires_at = now() + APPLY_ATTEMPT_TTL_MS`,
 *      `created_by = session.account_id`. Return
 *      `{ attemptId, plannedDispatches, draftFingerprint, expiresAt }`.
 */
export async function createApplyAttempt(
  session: AuthSession,
  args: { nodeId: string },
  signal?: AbortSignal,
): Promise<CreateApplyAttemptResult> {
  // Step 1: combined permission gate.
  await requireBothPermissions(session);

  // Step 2: build dispatch context.
  const ctx = await buildDispatchContext(session);

  // Step 3: read canonical node from manager (production GraphQL read).
  const node = await readCanonicalNode(ctx, args.nodeId, signal);

  // Step 4: defense-in-depth scope check.
  enforceNodeScope(ctx, node);

  // Step 5: build plan.
  const plannedDispatches = buildPlannedDispatches(node);

  // Step 6: fingerprint + persist.
  const snapshot = projectNodeSnapshot(node);
  const fingerprint = computeDraftFingerprint(snapshot);
  const ttlMs = getAttemptTtlMs();

  const attemptId = randomUUID();
  const insert = await query<{ created_at: Date; expires_at: Date }>(
    `
    INSERT INTO apply_attempts (
      attempt_id,
      node_id,
      draft_fingerprint,
      planned_dispatches,
      created_by,
      expires_at,
      status
    )
    VALUES (
      $1,
      $2,
      $3,
      $4::jsonb,
      $5,
      NOW() + ($6 || ' milliseconds')::interval,
      'pending'
    )
    RETURNING created_at, expires_at
    `,
    [
      attemptId,
      args.nodeId,
      fingerprint.bytes,
      JSON.stringify(plannedDispatches),
      session.accountId,
      String(ttlMs),
    ],
  );
  const expiresAt = insert.rows[0].expires_at.toISOString();

  return {
    attemptId,
    plannedDispatches,
    draftFingerprint: fingerprint.hex,
    expiresAt,
  };
}

// ── Implementation helpers ───────────────────────────────────────

async function requireBothPermissions(session: AuthSession): Promise<void> {
  for (const permission of [NODES_WRITE, SERVICES_WRITE]) {
    if (!(await hasPermission(session.roles, permission))) {
      throw new NodePermissionError(
        `Caller lacks the ${permission} permission.`,
      );
    }
  }
}

/**
 * Read the canonical Node payload for plan construction.
 *
 * Scope semantics on this entrypoint differ from `getNode` deliberately
 * for tenant-scoped callers. `getNode` distinguishes "not found" from
 * "out of scope" by surfacing `NodeNotFoundError` for both upstream-null
 * and upstream-throws-NotFound paths (review-web's scope filter resolves
 * a missing-or-out-of-scope node to the same shape, and the BFF cannot
 * tell them apart without privilege escalation). The umbrella's
 * createApplyAttempt acceptance is stricter — scope exclusion MUST
 * surface as `NodePermissionError`, not `NodeNotFoundError` — but only
 * for callers who actually have a tenant-scope boundary.
 *
 * For tenant-scoped callers, the BFF cannot distinguish "doesn't exist"
 * from "filtered for scope" when review-web returns null, so we collapse
 * both into `NodePermissionError`: the node either truly doesn't exist
 * (in which case the caller has no apply business with it) or it exists
 * but is out of the caller's customer scope. Either way it is a
 * permission boundary on the create-attempt surface.
 *
 * For System Administrator callers, no scope boundary applies — they
 * are the privileged caller in the first place — so we preserve the
 * real not-found semantics by letting `NodeNotFoundError` and the
 * `data.node === null` shape flow through unchanged. Collapsing them
 * into `NodePermissionError` for system admins would weaken the
 * outcome of a deleted/typoed node ID into a 403-shaped error even
 * though no scope boundary was crossed, and would diverge from
 * `getNode`'s behaviour for the same caller.
 *
 * The post-read `enforceNodeScope` defense-in-depth check still catches
 * the older review-web case where the upstream returns an out-of-scope
 * payload (no scope filtering at the upstream, BFF rejects post-read).
 * That path has always surfaced `NodePermissionError` and is unchanged.
 */
async function readCanonicalNode(
  ctx: DispatchContext,
  id: string,
  signal: AbortSignal | undefined,
): Promise<Node> {
  const isSystemAdmin = ctx.role === SYSTEM_ADMINISTRATOR;
  let data: NodeDetailResult;
  try {
    data = await withManagerErrorMapping(
      withNodeNotFoundMapping(
        graphqlRequest<NodeDetailResult, { id: string }>(
          NODE_DETAIL_QUERY,
          { id },
          { role: ctx.role, customerIds: ctx.customerIds },
          signal,
        ),
        id,
      ),
    );
  } catch (err) {
    if (err instanceof NodeNotFoundError) {
      if (isSystemAdmin) {
        throw err;
      }
      throw new NodePermissionError(
        `Node ${id} is not in the caller's customer scope.`,
      );
    }
    throw err;
  }
  if (!data.node) {
    if (isSystemAdmin) {
      throw new NodeNotFoundError(`Node ${id} was not found.`);
    }
    throw new NodePermissionError(
      `Node ${id} is not in the caller's customer scope.`,
    );
  }
  return data.node;
}

function enforceNodeScope(ctx: DispatchContext, node: Node): void {
  const customerId = node.profile?.customerId ?? node.profileDraft?.customerId;
  if (customerId === undefined) {
    if (ctx.role === SYSTEM_ADMINISTRATOR) return;
    throw new NodePermissionError(
      "Node carries no customer scope; only System Administrators can create apply attempts for it.",
    );
  }
  assertNodeInScope(ctx, Number(customerId));
}

/**
 * Build the planned dispatches from the canonical Node payload.
 *
 * Plan shape (umbrella JSON contract):
 *   - One `MANAGER` dispatch: no frozen `new` (re-derived per attempt
 *     at step 5d from the manager-DB draft state).
 *   - One external dispatch per `externalServices[]` entry whose
 *     `draft` is non-null (i.e. has a pending change). Each external
 *     dispatch carries the frozen `new` (the draft string at plan-
 *     build time).
 *
 * Manager dispatch is always emitted even if no node-level draft is
 * pending — `applyNode` is the umbrella's promotion step that clears
 * agent / external drafts in review-web's DB. External dispatches
 * follow up with the per-service mutation only when the service has
 * a pending draft; an external service with no draft is skipped.
 */
function buildPlannedDispatches(node: Node): PlannedDispatch[] {
  const dispatches: PlannedDispatch[] = [];
  dispatches.push({
    dispatchId: randomUUID(),
    kind: "MANAGER",
    state: "queued",
    attemptCount: 0,
    lastError: null,
  });
  for (const service of node.externalServices) {
    if (service.draft === null) continue;
    dispatches.push({
      dispatchId: randomUUID(),
      kind: service.kind as ExternalServiceKind,
      state: "queued",
      attemptCount: 0,
      lastError: null,
      // Frozen `new` per the durability contract — captured at plan-
      // build time and used verbatim on every external retry.
      new: service.draft,
    });
  }
  return dispatches;
}

/**
 * Project the canonical Node payload to the `NodeDraftSnapshot` shape
 * used by `computeDraftFingerprint`. The fingerprint is structural:
 * adding fields here would change every existing fingerprint, so the
 * shape is pinned to the umbrella's "involved manager-DB draft state".
 */
function projectNodeSnapshot(node: Node): NodeDraftSnapshot {
  return {
    id: node.id,
    name: node.name,
    nameDraft: node.nameDraft,
    profile: node.profile
      ? {
          customerId: node.profile.customerId,
          description: node.profile.description,
          hostname: node.profile.hostname,
        }
      : null,
    profileDraft: node.profileDraft
      ? {
          customerId: node.profileDraft.customerId,
          description: node.profileDraft.description,
          hostname: node.profileDraft.hostname,
        }
      : null,
    agents: node.agents.map((a) => ({
      kind: a.kind,
      key: a.key,
      status: a.status,
      config: a.config,
      draft: a.draft,
    })),
    externalServices: node.externalServices.map((s) => ({
      kind: s.kind,
      key: s.key,
      status: s.status,
      draft: s.draft,
    })),
  };
}
