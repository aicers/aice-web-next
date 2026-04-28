import { redirect } from "next/navigation";

import { ManagerUnavailablePanel } from "@/components/node/manager-unavailable-panel";
import {
  type NodeStatusRowSnapshot,
  nodeStatusToRow,
} from "@/components/node/node-status-row";
import { NodeStatusTable } from "@/components/node/node-status-table";
import { hasPermission } from "@/lib/auth/permissions";
import { getCurrentSession } from "@/lib/auth/session";
import { ManagerUnavailableError } from "@/lib/node/errors";
import { getNodeStatusList } from "@/lib/node/status";

// The combined `nodes:read + services:read` gate runs in the parent
// `(gate)/layout.tsx` so `forbidden()` lands above any Suspense and
// surfaces a real HTTP 403. This page only needs `nodes:write` to
// decide whether to render the restart/shutdown menu.
export default async function NodesStatusPage() {
  const session = await getCurrentSession();
  if (!session) {
    redirect("/sign-in");
  }

  const canWriteNodes = await hasPermission(session.roles, "nodes:write");
  // The `(gate)` layout already enforces `services:read` for every
  // route under `/nodes`, so this read is effectively always `true`
  // for any caller that reaches the table. We thread it explicitly
  // anyway so the per-row `useServiceStatus` defence-in-depth check
  // is driven by the same permission tuple as the rest of the page,
  // not by an implicit assumption about the layout gate.
  const canReadServices = await hasPermission(session.roles, "services:read");

  let initialRows: NodeStatusRowSnapshot[] = [];
  let initialCapturedAt = new Date().toISOString();
  let managerOffline = false;
  try {
    const result = await getNodeStatusList(session);
    initialCapturedAt = result.capturedAt;
    initialRows = result.edges.map(nodeStatusToRow);
  } catch (err) {
    // The fallback panel is reserved for transport failures
    // (`ManagerUnavailableError` from `withManagerErrorMapping`).
    // GraphQL `errors[]` should propagate so the standard error
    // boundary surfaces an unexpected failure instead of pretending
    // the manager is offline.
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
    <NodeStatusTable
      initialRows={initialRows}
      initialCapturedAt={initialCapturedAt}
      canControl={canWriteNodes}
      canReadServices={canReadServices}
    />
  );
}
