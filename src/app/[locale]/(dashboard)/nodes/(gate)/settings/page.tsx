import { forbidden, redirect } from "next/navigation";

import { CustomerScopeCallout } from "@/components/layout/customer-scope-callout";
import { ManagerUnavailablePanel } from "@/components/node/manager-unavailable-panel";
import { NodeListTable } from "@/components/node/node-list-table";
import { buildNodeRows, type NodeRow } from "@/components/node/node-list-types";
import { getEffectiveCustomerScope } from "@/lib/auth/customer-scope";
import { hasPermission } from "@/lib/auth/permissions";
import { getCurrentSession } from "@/lib/auth/session";
import { query } from "@/lib/db/client";
import {
  gigantoConfigToToml,
  tivanConfigToToml,
} from "@/lib/node/applied-config-toml";
import {
  ExternalServiceUnavailableError,
  ManagerUnavailableError,
  NodeNotFoundError,
  NodePermissionError,
} from "@/lib/node/errors";
import {
  collectSensorNodes,
  type SensorNodeOption,
} from "@/lib/node/sensor-list";
import {
  getGigantoConfig,
  getNode,
  getTivanConfig,
  listAllNodeStatuses,
  listAllNodes,
} from "@/lib/node/server-actions";
import type { Node as ManagerNode } from "@/lib/node/types";
import {
  ReviewForbiddenError,
  ReviewInvalidArgumentError,
} from "@/lib/review/errors";

import NodesForbidden from "../../forbidden";

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

interface NodesSettingsPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

// The combined `nodes:read + services:read` gate runs in the parent
// `(gate)/layout.tsx` so `forbidden()` lands above any Suspense and
// surfaces a real HTTP 403. This page only computes the write/delete
// flags it needs to drive the toolbar and row affordances.
export default async function NodesSettingsPage({
  searchParams,
}: NodesSettingsPageProps) {
  const session = await getCurrentSession();
  if (!session) {
    redirect("/sign-in");
  }
  const params = await searchParams;

  const [canWriteNodes, canWriteServices, canDelete, accessAll] =
    await Promise.all([
      hasPermission(session.roles, "nodes:write"),
      hasPermission(session.roles, "services:write"),
      hasPermission(session.roles, "nodes:delete"),
      hasPermission(session.roles, "customers:access-all"),
    ]);

  const customers = await loadCustomerOptions(session.accountId, accessAll);
  const scope = await getEffectiveCustomerScope(session);

  let rows: NodeRow[] | null = null;
  let sensorOptions: SensorNodeOption[] = [];
  let managerOffline = false;
  let reviewForbidden = false;
  try {
    // The list page must render every node the caller can see (Phase
    // Node-3 acceptance). Paginate both `nodeList` and `nodeStatusList`
    // through their `pageInfo.hasNextPage` so search / filter / delete
    // operate on the full set, not a truncated 200-node window. The
    // status fetch needs the same treatment so the alive/dead facet and
    // Manager column are joined for every rendered row.
    const [nodeConn, statusConn] = await Promise.all([
      listAllNodes(session),
      listAllNodeStatuses(session),
    ]);
    rows = buildNodeRows(nodeConn, statusConn);
    // Hog (Semi-supervised Engine) requires the current sensor pool to
    // render its `active_sensors` checklist correctly. Derive the pool
    // from the same `nodeList` walk we already did above instead of
    // re-issuing `listSensorNodes()` — they share the same upstream
    // query, and the dialog's deserialise/serialise rules need set
    // equality against this pool to keep the all-checked → None
    // wire encoding stable across save/reopen.
    sensorOptions = collectSensorNodes(nodeConn.edges.map((e) => e.node));
  } catch (err) {
    // Only the explicit `ManagerUnavailableError` (raised by
    // `withManagerErrorMapping` when the underlying transport / DNS /
    // mTLS fails) maps to the offline panel. GraphQL validation,
    // schema-drift, or upstream business errors surface as
    // `graphql-request` `ClientError`s and must propagate so Next.js
    // can render its standard error boundary — silently masking those
    // as "manager offline" would hide real bugs from operators.
    //
    // #405 I: review's typed denials surface as their own panel
    // (`NodesForbidden`) rather than the manager-offline copy or a
    // 500 page. `ReviewInvalidArgumentError` is defense-in-depth
    // (the BFF caps `first` at `REVIEW_MAX_PAGE_SIZE`); if either
    // side drifts we still avoid a crash.
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

  if (managerOffline) {
    return (
      <>
        <CustomerScopeCallout scope={scope} className="mb-4" />
        <ManagerUnavailablePanel />
      </>
    );
  }

  // Edit-from-list: the kebab menu pushes `?dialog=edit&id=…`. Resolve
  // the canonical node server-side so the dialog mounts pre-populated
  // without a second round-trip.
  //
  // Mixed-permission write contract: the dialog is unreachable for
  // callers missing either `nodes:write` or `services:write`. The
  // canonical 403 is enforced by `nodes/(gate)/layout.tsx` reading the
  // forwarded request URL above the `loading.tsx` Suspense boundary
  // (so headers commit at 403 instead of 200). This page-level
  // `forbidden()` stays in place as a defense-in-depth back-stop for
  // any RSC re-render that doesn't pass through the proxy middleware,
  // and to keep the Add button hidden via `canCreate`/`canEdit` below.
  // Silently rendering the list under the same URL would leak that the
  // route exists and conflict with the issue's "Edit route guard
  // rejects with 403" requirement.
  const dialogParam = params.dialog;
  const idParam = params.id;
  const editId =
    dialogParam === "edit" && typeof idParam === "string" ? idParam : null;
  if (editId && (!canWriteNodes || !canWriteServices)) {
    forbidden();
  }
  // Detail page's "Edit this service" link forwards `service=<kind>`
  // (kebab-case registry kind). Forward it through to the dialog so
  // it can auto-expand and scroll the matching accordion. Unknown
  // values are dropped silently (the dialog falls back to its default
  // collapsed behaviour) rather than surfaced as an error — a stale
  // bookmark or mistyped param should still let the user reach the
  // dialog.
  const serviceParam = params.service;
  const initialFocusService =
    editId && typeof serviceParam === "string" && serviceParam.length > 0
      ? serviceParam
      : null;
  let editNode: ManagerNode | null = null;
  if (editId) {
    try {
      editNode = await getNode(session, editId);
    } catch (err) {
      // A stale URL (node deleted) or out-of-scope id should not crash
      // the page — drop the edit intent silently and render the list.
      // A manager outage drops it the same way; the list above either
      // already rendered cached data or surfaced the offline panel.
      //
      // Reviewer Round 2 P2: typed review denials are NOT transient.
      // `listAllNodes` above succeeded with the same role / scope, so
      // a Forbidden on this single-node fetch is either a per-resource
      // denial or contract drift — silently dropping the dialog
      // conflates "denied" with "stale link" and undermines the same
      // #405 I security guardrail. Surface the explicit forbidden
      // panel (mirroring the list-fetch path above) instead of
      // pretending the edit intent was never made.
      if (
        err instanceof ReviewForbiddenError ||
        err instanceof ReviewInvalidArgumentError
      ) {
        reviewForbidden = true;
      } else if (
        !(err instanceof NodeNotFoundError) &&
        !(err instanceof NodePermissionError) &&
        !(err instanceof ManagerUnavailableError)
      ) {
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

  // Externals (Data Store / TI Container) carry only `draft` on the
  // node payload — applied config lives on Giganto / Tivan and has to
  // be fetched separately. Without this baseline the dialog falls
  // back to blank-IP defaults and `dialogSchema.superRefine` blocks
  // any save, including a metadata-only edit on a node that hosts an
  // applied external. Each fetch is gated on the node actually
  // hosting the corresponding external with `draft: null`; transient
  // unavailability of Giganto/Tivan falls through to defaults so the
  // dialog still opens (the user can re-enter values explicitly).
  const appliedExternalDrafts: Record<string, string> = {};
  if (editNode) {
    const externalFetches: Promise<void>[] = [];
    for (const ext of editNode.externalServices) {
      if (ext.draft !== null) continue;
      if (ext.kind === "DATA_STORE") {
        externalFetches.push(
          getGigantoConfig(session)
            .then((config) => {
              appliedExternalDrafts["data-store"] = gigantoConfigToToml(config);
            })
            .catch((err) => {
              if (!(err instanceof ExternalServiceUnavailableError)) throw err;
            }),
        );
      } else if (ext.kind === "TI_CONTAINER") {
        externalFetches.push(
          getTivanConfig(session)
            .then((config) => {
              appliedExternalDrafts["ti-container"] = tivanConfigToToml(config);
            })
            .catch((err) => {
              if (!(err instanceof ExternalServiceUnavailableError)) throw err;
            }),
        );
      }
    }
    if (externalFetches.length > 0) await Promise.all(externalFetches);
  }

  return (
    <>
      <CustomerScopeCallout scope={scope} className="mb-4" />
      <NodeListTable
        initialRows={rows ?? []}
        customers={customers}
        canCreate={canWriteNodes && canWriteServices}
        canEdit={canWriteNodes && canWriteServices}
        canDelete={canDelete}
        showTenantFilter={accessAll}
        initialEditNode={editNode}
        initialFocusService={initialFocusService}
        sensorOptions={sensorOptions}
        appliedExternalDrafts={appliedExternalDrafts}
      />
    </>
  );
}
