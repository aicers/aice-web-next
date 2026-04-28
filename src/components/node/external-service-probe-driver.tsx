"use client";

import { useExternalServiceProbes } from "@/hooks/use-service-status";

// Driver for the external Giganto / Tivan probe loop, scoped to the
// routes that actually render service-status UI.
//
// Mounted in `nodes/(gate)/(probe)/layout.tsx` so the driver covers
// the Status tab (`/nodes`) and the detail page (`/nodes/[id]`), but
// NOT `/nodes/settings` — settings has no service-status consumer and
// hoisting the driver any higher would have it firing both external
// `status` queries on Settings as well, defeating the per-service
// stagger #313 added to avoid hammering Giganto / Tivan.
//
// Both Status and Detail share the `(probe)` layout, so an
// intra-segment navigation (Status row → detail page) preserves the
// driver mount and the shared snapshot survives. Without this scoped
// layout the page-level `useExternalServiceProbes(...)` call inside
// `NodeStatusTable` / `NodeDetailServiceCards` ran during page
// cleanup; React tears the old page down before the new one mounts,
// so `probeDriverCount` bounced through 0 and the last-unmount reset
// wiped the snapshot back to `unknown` / `null`. Because
// `mapExternalStatus("unknown")` renders `off`, the detail page
// first-painted Giganto / Tivan as `Off` even when the Status row
// had just shown them `On`.
//
// The parent `(gate)` layout already enforces `services:read`, so the
// driver can run unconditionally inside this sub-layout. Page-level
// callers (`NodeStatusTable`, `NodeDetailServiceCards`) pass
// `enabled: false` to `useExternalServiceProbes` / `useServiceStatus`
// so they consume the shared store rather than spinning up parallel
// loops.
export function ExternalServiceProbeDriver() {
  useExternalServiceProbes();
  return null;
}
