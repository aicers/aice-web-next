import { redirect } from "next/navigation";

import { ManagerUnavailablePanel } from "@/components/node/manager-unavailable-panel";
import { NodeListTable } from "@/components/node/node-list-table";
import { buildNodeRows, type NodeRow } from "@/components/node/node-list-types";
import { hasPermission } from "@/lib/auth/permissions";
import { getCurrentSession } from "@/lib/auth/session";
import { query } from "@/lib/db/client";
import { ManagerUnavailableError } from "@/lib/node/errors";
import { listAllNodeStatuses, listAllNodes } from "@/lib/node/server-actions";

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

export default async function NodesSettingsPage() {
  const session = await getCurrentSession();
  if (!session) {
    redirect("/sign-in");
  }

  const [
    canReadNodes,
    canReadServices,
    canWriteNodes,
    canWriteServices,
    canDelete,
    accessAll,
  ] = await Promise.all([
    hasPermission(session.roles, "nodes:read"),
    hasPermission(session.roles, "services:read"),
    hasPermission(session.roles, "nodes:write"),
    hasPermission(session.roles, "services:write"),
    hasPermission(session.roles, "nodes:delete"),
    hasPermission(session.roles, "customers:access-all"),
  ]);

  if (!canReadNodes || !canReadServices) {
    redirect("/");
  }

  const customers = await loadCustomerOptions(session.accountId, accessAll);

  let rows: NodeRow[] | null = null;
  let managerOffline = false;
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
  } catch (err) {
    // Only the explicit `ManagerUnavailableError` (raised by
    // `withManagerErrorMapping` when the underlying transport / DNS /
    // mTLS fails) maps to the offline panel. GraphQL validation,
    // schema-drift, or upstream business errors surface as
    // `graphql-request` `ClientError`s and must propagate so Next.js
    // can render its standard error boundary — silently masking those
    // as "manager offline" would hide real bugs from operators.
    if (err instanceof ManagerUnavailableError) {
      managerOffline = true;
    } else {
      throw err;
    }
  }

  if (managerOffline) {
    return <ManagerUnavailablePanel />;
  }

  return (
    <NodeListTable
      initialRows={rows ?? []}
      customers={customers}
      canCreate={canWriteNodes && canWriteServices}
      canEdit={canWriteNodes && canWriteServices}
      canDelete={canDelete}
      showTenantFilter={accessAll}
    />
  );
}
