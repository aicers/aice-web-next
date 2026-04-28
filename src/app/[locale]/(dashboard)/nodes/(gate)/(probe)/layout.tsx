import { ExternalServiceProbeDriver } from "@/components/node/external-service-probe-driver";

// Probe-scoped sub-layout: mounts the Giganto / Tivan external probe
// driver only for the routes that actually render service-status UI
// (`/nodes` Status tab and `/nodes/[id]` detail page). The sibling
// `/nodes/settings` page sits directly under `(gate)/layout.tsx` and
// has no service-status consumer, so hoisting the probe driver to the
// gate layout would have it firing both external `status` queries on
// Settings as well — defeating the per-service stagger #313 added to
// avoid hammering Giganto / Tivan.
//
// Both pages here share this layout, so navigating Status ↔ Detail
// preserves the driver mount (no `probeDriverCount` bounce → 0 →
// stale-Off flash). Navigating to or away from `/nodes/settings`
// crosses this boundary by design and resets the probe snapshot, which
// matches the round-3 "leaving the Nodes service-status surface should
// drop stale probe outcomes" expectation.
export default function NodesProbeLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <>
      <ExternalServiceProbeDriver />
      {children}
    </>
  );
}
