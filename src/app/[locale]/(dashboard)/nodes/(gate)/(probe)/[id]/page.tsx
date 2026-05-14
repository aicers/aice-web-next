import { notFound, redirect } from "next/navigation";

import { CustomerScopeCallout } from "@/components/layout/customer-scope-callout";
import { ManagerUnavailablePanel } from "@/components/node/manager-unavailable-panel";
import { NodeDetailDashboard } from "@/components/node/node-detail-dashboard";
import { NodeDetailServiceGrid } from "@/components/node/node-detail-service-grid";
import { getEffectiveCustomerScope } from "@/lib/auth/customer-scope";
import { hasPermission } from "@/lib/auth/permissions";
import { getCurrentSession } from "@/lib/auth/session";
import { query } from "@/lib/db/client";
import { confirmApplyAttempt, retryDispatch } from "@/lib/node/apply-actions";
import { createApplyAttempt } from "@/lib/node/apply-attempts";
import { getLastAppliedAt } from "@/lib/node/apply-history";
import {
  ManagerUnavailableError,
  NodeNotFoundError,
  NodePermissionError,
} from "@/lib/node/errors";
import {
  buildExternalConfigSnapshot,
  externalKindsOnNode,
} from "@/lib/node/external-config-snapshot";
import type { ExternalConfigSnapshot } from "@/lib/node/pending-state";
import { getNode } from "@/lib/node/server-actions";
import { getNodeStatusList } from "@/lib/node/status";
import type { Node as ManagerNode, NodeStatus } from "@/lib/node/types";
import {
  ReviewForbiddenError,
  ReviewInvalidArgumentError,
} from "@/lib/review/errors";

import NodesForbidden from "../../../forbidden";

interface CustomerOption {
  id: string;
  name: string;
}

async function loadCustomerOptions(
  accountId: string,
  accessAll: boolean,
): Promise<CustomerOption[]> {
  const sql = accessAll
    ? "SELECT id, name FROM customers ORDER BY name"
    : `SELECT c.id, c.name FROM customers c
       JOIN account_customer ac ON ac.customer_id = c.id
       WHERE ac.account_id = $1
       ORDER BY c.name`;
  try {
    const { rows } = accessAll
      ? await query<{ id: number; name: string }>(sql)
      : await query<{ id: number; name: string }>(sql, [accountId]);
    return rows.map((row) => ({ id: String(row.id), name: row.name }));
  } catch {
    return [];
  }
}

/**
 * Phase Node-5a (#376) detail page core.
 *
 * Replaces the Phase Node-6 placeholder in-place. The combined
 * `nodes:read + services:read` gate runs in the parent
 * `(gate)/layout.tsx` so missing either permission still surfaces a
 * real HTTP 403; the manager-unavailable fallback panel rendered here
 * is for the post-gate "manager dropped before this read" path.
 *
 * Server-side responsibilities:
 *  - Fetch the canonical node payload (`getNode`) for tenant-scope
 *    enforcement and applied/draft service config.
 *  - Fetch external (Giganto/Tivan) applied configs for any external
 *    service the node hosts; transient unavailability falls through to
 *    the per-card "unreachable" copy on Applied/Diff tabs.
 *  - SSR-seed the polling buffer via `getNodeStatusList` so the
 *    sparkline carries at least one point on the first paint.
 */
export default async function NodeDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getCurrentSession();
  if (!session) {
    redirect("/sign-in");
  }

  const { id } = await params;

  const [
    canReadServices,
    canWriteNodes,
    canWriteServices,
    canDeleteNodes,
    accessAll,
    scope,
  ] = await Promise.all([
    hasPermission(session.roles, "services:read"),
    hasPermission(session.roles, "nodes:write"),
    hasPermission(session.roles, "services:write"),
    hasPermission(session.roles, "nodes:delete"),
    hasPermission(session.roles, "customers:access-all"),
    getEffectiveCustomerScope(session),
  ]);

  // Canonical node payload. The combined gate at the layout level
  // ensures `getNode` is always callable here for the read scopes; the
  // canonical-not-found / out-of-scope branches map to 404 (NotFound),
  // and a manager outage maps to the offline panel.
  //
  // #405 I: review's typed denials surface as the explicit forbidden
  // panel rather than the manager-offline copy or a 500 page. A
  // silent empty state would conflate "denied" with "no data" — see
  // the issue's security guardrails.
  let node: ManagerNode | null = null;
  let managerOffline = false;
  let reviewForbidden = false;
  try {
    node = await getNode(session, id);
  } catch (err) {
    if (err instanceof NodeNotFoundError) {
      notFound();
    }
    if (err instanceof NodePermissionError) {
      notFound();
    }
    if (err instanceof ManagerUnavailableError) {
      managerOffline = true;
    } else if (
      err instanceof ReviewForbiddenError ||
      err instanceof ReviewInvalidArgumentError
    ) {
      reviewForbidden = true;
    } else {
      throw err;
    }
  }

  if (reviewForbidden) {
    return (
      <>
        <CustomerScopeCallout scope={scope} className="mb-4" />
        <NodesForbidden />
      </>
    );
  }

  if (managerOffline || !node) {
    return (
      <>
        <CustomerScopeCallout scope={scope} className="mb-4" />
        <ManagerUnavailablePanel />
      </>
    );
  }

  const customers = await loadCustomerOptions(session.accountId, accessAll);

  // Page-load endpoint snapshot for the node's externals — drives
  // comparison-based pending detection in the dashboard / service grid
  // and feeds the Applied / Diff tabs (#551). Transient unavailability
  // of Giganto / Tivan is recorded as `"unavailable"` in the snapshot;
  // the client surfaces it as the unknown / offline state.
  //
  // This snapshot is a UI artifact: `createApplyAttempt` performs its
  // own request-time endpoint read at the moment of Apply and is not
  // bound by what we capture here.
  const externalConfigSnapshot: ExternalConfigSnapshot =
    await buildExternalConfigSnapshot(session, externalKindsOnNode(node));

  // SSR-seed the polling buffer for cold loads of `/nodes/[id]`.
  // The polling driver intentionally defers its first client tick until
  // the first `pollIntervalMs` boundary, and the detail page can be
  // entered directly (bookmark, deep link) without first visiting the
  // Status tab. A `ManagerUnavailableError` on the seed path is
  // non-fatal — `getNode()` has already succeeded, so the dashboard
  // still renders the metadata + service grid; only the live-status
  // widgets fall back to their empty state and recover on the next
  // poll tick (or when the polling driver flips
  // `isManagerUnreachable` mid-session).
  let initialEdges: NodeStatus[] = [];
  let initialCapturedAt: string | null = null;
  if (canReadServices) {
    try {
      const result = await getNodeStatusList(session);
      initialCapturedAt = result.capturedAt;
      initialEdges = result.edges;
    } catch (err) {
      // The seed is non-fatal for *transient* failures only — a
      // manager outage degrades gracefully because the polling driver
      // recovers on the first tick and the dashboard still renders
      // the metadata + service grid.
      //
      // Reviewer Round 2 P2: typed review denials are NOT transient.
      // The canonical `getNode` above shares the same role / scope /
      // JWT contract; if review denies the status seed it is either
      // a per-resource denial or contract drift, and silently
      // continuing with `initialEdges = []` would conflate "denied"
      // with "no live status" — the same security guardrail
      // forbidden in #405 I. Surface the explicit forbidden panel
      // (mirroring the canonical-fetch path above) so operators see
      // a real denied state instead of a page that silently lost its
      // live-status widget.
      if (
        err instanceof ReviewForbiddenError ||
        err instanceof ReviewInvalidArgumentError
      ) {
        reviewForbidden = true;
      } else if (!(err instanceof ManagerUnavailableError)) {
        throw err;
      }
    }
  }
  if (reviewForbidden) {
    return (
      <>
        <CustomerScopeCallout scope={scope} className="mb-4" />
        <NodesForbidden />
      </>
    );
  }
  const initialNodeStatus = initialEdges.find((edge) => edge.id === id) ?? null;

  // Last successful apply finalisation timestamp, derived from the
  // local `apply_attempts` audit metadata. Independent of manager
  // reachability so the metadata card is populated even during a
  // manager outage.
  let lastAppliedAt: string | null = null;
  try {
    const value = await getLastAppliedAt(id);
    lastAppliedAt = value !== null ? value.toISOString() : null;
  } catch {
    lastAppliedAt = null;
  }

  const canEdit = canWriteNodes && canWriteServices;
  const canApply = canWriteNodes && canWriteServices;

  return (
    <div className="space-y-6" data-testid="node-detail-page" data-node-id={id}>
      <CustomerScopeCallout scope={scope} />
      <NodeDetailDashboard
        node={node}
        customers={customers}
        canEdit={canEdit}
        canDelete={canDeleteNodes}
        canControl={canWriteNodes}
        canApply={canApply}
        initialNodeStatus={initialNodeStatus}
        initialCapturedAt={initialCapturedAt}
        initialEdges={initialEdges}
        lastAppliedAt={lastAppliedAt}
        externalConfigSnapshot={externalConfigSnapshot}
        applyActions={{
          createApplyAttempt,
          confirmApplyAttempt,
          retryDispatch,
        }}
      />
      {canReadServices && (
        <NodeDetailServiceGrid
          node={node}
          canReadServices={canReadServices}
          canEditServices={canEdit}
          initialNodeStatus={initialNodeStatus}
          initialCapturedAt={initialCapturedAt}
          initialEdges={initialEdges}
          externalConfigSnapshot={externalConfigSnapshot}
        />
      )}
    </div>
  );
}
