"use client";

import { useExternalServiceProbes } from "@/hooks/use-service-status";

// Segment-scoped driver for the external Giganto / Tivan probe loop.
//
// Mounted in `nodes/(gate)/layout.tsx` so its lifetime spans the whole
// `/nodes` segment, not any single page. Without a segment-scoped
// driver, `/nodes` and `/nodes/[id]` each ran their own
// `useExternalServiceProbes(...)` call inside the page component;
// React's page cleanup runs before the next page mounts, so an
// intra-segment navigation (Status row → detail page) bounced
// `probeDriverCount` through 0 and the last-unmount reset wiped the
// shared snapshot back to `unknown` / `null`. Since
// `mapExternalStatus("unknown")` renders `off`, the detail page
// first-painted Giganto / Tivan as `Off` until the next probe landed —
// even when the Status row had just shown them `On`.
//
// The gate layout already enforces `services:read`, so the driver can
// run unconditionally inside the gate. Page-level callers
// (`NodeStatusTable`, `NodeDetailServiceCards`) pass `enabled: false`
// to `useExternalServiceProbes` / `useServiceStatus` so they consume
// the shared store rather than spinning up parallel loops.
export function ExternalServiceProbeDriver() {
  useExternalServiceProbes();
  return null;
}
