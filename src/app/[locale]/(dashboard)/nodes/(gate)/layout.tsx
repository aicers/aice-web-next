import { forbidden, redirect } from "next/navigation";

import { NodeStatusPollingDriver } from "@/components/node/node-status-polling-driver";
import { hasPermission } from "@/lib/auth/permissions";
import { getCurrentSession } from "@/lib/auth/session";

// Centralised `nodes:read + services:read` gate for both Node tabs.
//
// Two constraints conspire here:
//  1. Phase Node-6 acceptance says missing either scope must produce a
//     real HTTP 403 (not a silent redirect).
//  2. The status response is set when Next.js flushes the SSR shell.
//     `nodes/settings/loading.tsx` puts a Suspense boundary around the
//     settings page; if `forbidden()` is called from inside that
//     boundary, the loading fallback streams first and the headers
//     lock at 200 before the throw lands.
//
// Putting the check in `nodes/layout.tsx` would set the status before
// any streaming, but Next.js scopes `forbidden.tsx` to its segment's
// children — a sibling layout's throw escapes past the boundary and
// surfaces the framework's default 403 panel instead of the localised
// `nodes/forbidden.tsx`.
//
// This `(gate)` route group is the seam: it is a CHILD of `/nodes`
// (so `/nodes/forbidden.tsx` catches its throws and renders the
// localised panel) and it sits ABOVE every loading.tsx in the tree
// (so `forbidden()` lands before any Suspense fallback streams). The
// route group's parentheses keep URLs unchanged — `/nodes` and
// `/nodes/settings` still resolve here.
export default async function NodesGateLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const session = await getCurrentSession();
  if (!session) {
    redirect("/sign-in");
  }

  const [canReadNodes, canReadServices] = await Promise.all([
    hasPermission(session.roles, "nodes:read"),
    hasPermission(session.roles, "services:read"),
  ]);

  if (!canReadNodes || !canReadServices) {
    forbidden();
  }

  // Single segment-scoped polling driver for the per-node status
  // signal. Page-level callers within the gate (Status table, Settings
  // list, detail page) consume the shared store via
  // `useNodeStatusPolling({ enabled: false })`, so navigation between
  // them does not bounce `driverCount` through zero — which would
  // otherwise wipe the 60-sample node history. The Settings list reads
  // the same store for its alive/dead facet and Manager column, so the
  // node-status driver is correctly scoped to the whole gate segment.
  //
  // The external Giganto / Tivan probe driver is intentionally NOT
  // mounted here. It lives in the narrower `(probe)/layout.tsx`
  // sub-route group below so probes only fire on the routes that
  // actually render service-status UI (`/nodes` Status tab, `/nodes/[id]`
  // detail page) and not on `/nodes/settings`, which has no
  // service-status consumer.
  return (
    <>
      <NodeStatusPollingDriver />
      {children}
    </>
  );
}
