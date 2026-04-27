"use client";

import { useNodeStatusPolling } from "@/hooks/use-node-status-polling";

// Segment-scoped driver for the Node status polling loop.
//
// Lives inside `nodes/(gate)/layout.tsx` so its mount lifetime is bound
// to the `/nodes` segment as a whole — not to any single page. That
// means the rolling buffer survives every intra-segment navigation
// (Status ↔ Settings ↔ Detail) and only the LAST segment unmount
// (e.g. navigating to `/`) tears the buffer down. Without this, React's
// page-level cleanup ran before the next page's mount and bounced
// `driverCount` through 0, wiping the 60-sample history mid-navigation.
//
// Page-scoped consumers (`NodeStatusTable`, `NodeListTable`) read from
// the same `useSyncExternalStore`-backed module via
// `useNodeStatusPolling({ enabled: false })`, so only this single
// component drives the polling loop.
export function NodeStatusPollingDriver() {
  useNodeStatusPolling();
  return null;
}
