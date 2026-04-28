import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { NodeDetailServiceCards } from "@/components/node/node-detail-service-cards";
import { hasPermission } from "@/lib/auth/permissions";
import { getCurrentSession } from "@/lib/auth/session";
import { ManagerUnavailableError } from "@/lib/node/errors";
import { getNodeStatusList } from "@/lib/node/status";
import type { NodeStatus } from "@/lib/node/types";

// Phase Node-6 (this PR) makes the Status row navigational: clicking
// a row pushes `/nodes/[id]`. The full per-node detail dashboard and
// the "Apply All Pending" affordance are owned by Phase Node-5, so
// this placeholder is intentionally minimal — it exists to give the
// row navigation a real destination (instead of the framework 404)
// and a stable testid hook (`node-detail-placeholder`) that Phase
// Node-5 can replace in-place when it lands the real dashboard.
//
// The combined `nodes:read + services:read` gate is enforced in the
// parent `(gate)/layout.tsx`, so missing permissions still surface a
// real HTTP 403 with the localised forbidden panel. The placeholder
// deliberately does NOT fetch the node from the manager: tenant-scope
// enforcement on the detail surface is part of the Phase Node-5 data
// contract, and pulling in a NodeDetail GraphQL fixture for a
// throwaway placeholder would cement a fixture shape that Phase
// Node-5 has not yet ratified.
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
  const t = await getTranslations("nodes.detail");
  // Layout already enforces the combined `nodes:read + services:read`
  // gate, so this read is effectively always `true`. Threading it
  // explicitly so the per-card `useServiceStatus` defence-in-depth
  // check carries the same permission tuple as the page-level gate.
  const canReadServices = await hasPermission(session.roles, "services:read");

  // SSR-seed the polling buffer for cold loads of `/nodes/[id]`.
  // The polling driver intentionally defers its first client tick
  // until the first `pollIntervalMs` boundary, and the detail page
  // can be entered directly (bookmark, deep link) without first
  // visiting the Status tab. Without this seed every service card
  // would render the `absent` placeholder for up to a full polling
  // interval after the first paint, even though `nodeStatusList`
  // already carries the agents / external services for this node.
  // A `ManagerUnavailableError` on the seed path is non-fatal — the
  // cards fall back to the absent placeholder and the next polling
  // tick recovers — so we swallow it here rather than collapsing
  // the whole detail page to the manager-offline panel that lives
  // on the Status tab.
  // `initialCapturedAt` stays undefined until we successfully observe
  // a real `nodeStatusList` payload. Fabricating `new Date().toISOString()`
  // on the `ManagerUnavailableError` path (or any other early-return
  // branch) leaks down to the per-card "Last checked Xs ago" footer
  // and makes the cold-load detail page claim a successful service
  // read happened when it did not.
  let initialEdges: NodeStatus[] = [];
  let initialCapturedAt: string | undefined;
  if (canReadServices) {
    try {
      const result = await getNodeStatusList(session);
      initialCapturedAt = result.capturedAt;
      initialEdges = result.edges;
    } catch (err) {
      if (!(err instanceof ManagerUnavailableError)) {
        throw err;
      }
    }
  }

  return (
    <div className="space-y-4">
      <section
        className="space-y-4 rounded-lg border bg-card p-6"
        data-testid="node-detail-placeholder"
        data-node-id={id}
      >
        <header className="space-y-1">
          <h1 className="text-xl font-semibold">{t("title")}</h1>
          <p className="text-muted-foreground text-sm font-mono">{id}</p>
        </header>
        <p className="text-muted-foreground text-sm">{t("placeholder")}</p>
      </section>
      <NodeDetailServiceCards
        nodeId={id}
        canReadServices={canReadServices}
        initialEdges={initialEdges}
        initialCapturedAt={initialCapturedAt}
      />
    </div>
  );
}
