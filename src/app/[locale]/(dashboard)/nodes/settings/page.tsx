import { redirect } from "next/navigation";

import { ManagerUnavailablePanel } from "@/components/node/manager-unavailable-panel";
import { NodeListTable } from "@/components/node/node-list-table";
import { buildNodeRows, type NodeRow } from "@/components/node/node-list-types";
import { hasPermission } from "@/lib/auth/permissions";
import { getCurrentSession } from "@/lib/auth/session";
import { query } from "@/lib/db/client";
import { ManagerUnavailableError } from "@/lib/node/errors";
import { listNodeStatuses, listNodes } from "@/lib/node/server-actions";

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
    const [nodeConn, statusConn] = await Promise.all([
      listNodes(session, { first: 200 }),
      listNodeStatuses(session, { first: 200 }),
    ]);
    rows = buildNodeRows(nodeConn, statusConn);
  } catch (err) {
    if (err instanceof ManagerUnavailableError) {
      managerOffline = true;
    } else if (
      err instanceof Error &&
      (err.constructor.name === "ClientError" || "response" in err)
    ) {
      // graphql-request ClientError surfaces upstream GraphQL errors at
      // the same severity as a transport failure from the user's view —
      // the manager is reachable but cannot answer. Render the offline
      // panel rather than a 500. Diagnostics stay in the server log.
      console.error("[nodes/settings] failed to load nodes:", err);
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
