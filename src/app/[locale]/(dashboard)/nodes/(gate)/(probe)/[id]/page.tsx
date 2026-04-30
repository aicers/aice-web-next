import { notFound, redirect } from "next/navigation";

import { CustomerScopeCallout } from "@/components/layout/customer-scope-callout";
import { ManagerUnavailablePanel } from "@/components/node/manager-unavailable-panel";
import { NodeDetailDashboard } from "@/components/node/node-detail-dashboard";
import { NodeDetailServiceGrid } from "@/components/node/node-detail-service-grid";
import { getEffectiveCustomerScope } from "@/lib/auth/customer-scope";
import { hasPermission } from "@/lib/auth/permissions";
import { getCurrentSession } from "@/lib/auth/session";
import { query } from "@/lib/db/client";
import {
  gigantoConfigToToml,
  tivanConfigToToml,
} from "@/lib/node/applied-config-toml";
import { confirmApplyAttempt, retryDispatch } from "@/lib/node/apply-actions";
import { createApplyAttempt } from "@/lib/node/apply-attempts";
import { getLastAppliedAt } from "@/lib/node/apply-history";
import {
  ExternalServiceUnavailableError,
  ManagerUnavailableError,
  NodeNotFoundError,
  NodePermissionError,
} from "@/lib/node/errors";
import {
  getGigantoConfig,
  getNode,
  getTivanConfig,
} from "@/lib/node/server-actions";
import { getNodeStatusList } from "@/lib/node/status";
import type {
  ExternalServiceKind,
  Node as ManagerNode,
  NodeStatus,
} from "@/lib/node/types";

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
  let node: ManagerNode | null = null;
  let managerOffline = false;
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
    } else {
      throw err;
    }
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

  // Applied external configs for any external service the node hosts.
  // Transient unavailability of Giganto / Tivan falls through to the
  // unreachable copy on Applied / Diff tabs; the Draft tab keeps
  // rendering normally regardless.
  const appliedExternalConfigs: Record<ExternalServiceKind, string | null> = {
    DATA_STORE: null,
    TI_CONTAINER: null,
  };
  const unreachableExternals = new Set<ExternalServiceKind>();
  const externalFetches: Promise<void>[] = [];
  for (const ext of node.externalServices) {
    if (ext.kind === "DATA_STORE") {
      externalFetches.push(
        getGigantoConfig(session)
          .then((config) => {
            appliedExternalConfigs.DATA_STORE = gigantoConfigToToml(config);
          })
          .catch((err) => {
            if (err instanceof ExternalServiceUnavailableError) {
              unreachableExternals.add("DATA_STORE");
              return;
            }
            throw err;
          }),
      );
    } else if (ext.kind === "TI_CONTAINER") {
      externalFetches.push(
        getTivanConfig(session)
          .then((config) => {
            appliedExternalConfigs.TI_CONTAINER = tivanConfigToToml(config);
          })
          .catch((err) => {
            if (err instanceof ExternalServiceUnavailableError) {
              unreachableExternals.add("TI_CONTAINER");
              return;
            }
            throw err;
          }),
      );
    }
  }
  if (externalFetches.length > 0) await Promise.all(externalFetches);

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
      if (!(err instanceof ManagerUnavailableError)) throw err;
    }
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
          appliedExternalConfigs={appliedExternalConfigs}
          unreachableExternals={unreachableExternals}
        />
      )}
    </div>
  );
}
