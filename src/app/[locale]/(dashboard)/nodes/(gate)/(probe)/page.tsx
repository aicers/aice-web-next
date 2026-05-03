import { redirect } from "next/navigation";

import { CustomerScopeCallout } from "@/components/layout/customer-scope-callout";
import { ManagerUnavailablePanel } from "@/components/node/manager-unavailable-panel";
import {
  type NodeStatusRowSnapshot,
  nodeStatusToRow,
} from "@/components/node/node-status-row";
import { NodeStatusTable } from "@/components/node/node-status-table";
import { getEffectiveCustomerScope } from "@/lib/auth/customer-scope";
import { hasPermission } from "@/lib/auth/permissions";
import { getCurrentSession } from "@/lib/auth/session";
import { ManagerUnavailableError } from "@/lib/node/errors";
import { getNodeStatusList } from "@/lib/node/status";
import type { NodeStatus } from "@/lib/node/types";
import {
  ReviewForbiddenError,
  ReviewInvalidArgumentError,
} from "@/lib/review/errors";
import NodesForbidden from "../../forbidden";

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
  const scope = await getEffectiveCustomerScope(session);

  let initialRows: NodeStatusRowSnapshot[] = [];
  let initialEdges: NodeStatus[] = [];
  let initialCapturedAt = new Date().toISOString();
  let managerOffline = false;
  let reviewForbidden = false;
  try {
    const result = await getNodeStatusList(session);
    initialCapturedAt = result.capturedAt;
    initialEdges = result.edges;
    initialRows = result.edges.map(nodeStatusToRow);
  } catch (err) {
    // The fallback panel is reserved for transport failures
    // (`ManagerUnavailableError` from `withManagerErrorMapping`).
    // Review-side denials (`ReviewForbiddenError`, #405 I) and
    // argument-validation errors are surfaced with explicit panels
    // — silently swallowing Forbidden as "no data" is forbidden by
    // the security guardrails. Other GraphQL errors propagate so
    // the standard error boundary surfaces them unmasked.
    if (err instanceof ManagerUnavailableError) {
      managerOffline = true;
    } else if (err instanceof ReviewForbiddenError) {
      reviewForbidden = true;
    } else if (err instanceof ReviewInvalidArgumentError) {
      // Defense-in-depth: the BFF caps page sizes (#405 J) so this
      // path is unreachable in steady state, but if either side
      // drifts, render the same forbidden panel rather than 500-ing.
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

  return (
    <>
      <CustomerScopeCallout scope={scope} className="mb-4" />
      <NodeStatusTable
        initialRows={initialRows}
        initialEdges={initialEdges}
        initialCapturedAt={initialCapturedAt}
        canControl={canWriteNodes}
        canReadServices={canReadServices}
      />
    </>
  );
}
