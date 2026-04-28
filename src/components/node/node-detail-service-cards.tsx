"use client";

import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";

import { seedNodeStatusFromSnapshot } from "@/hooks/use-node-status-polling";
import { useServiceStatus } from "@/hooks/use-service-status";
import { ALL_SERVICE_KINDS } from "@/lib/node/service-status";
import type { NodeStatus } from "@/lib/node/types";

import { ServiceStatusBadge } from "./service-status-badge";

interface NodeDetailServiceCardsProps {
  nodeId: string;
  canReadServices: boolean;
  /**
   * SSR-rendered `nodeStatusList` snapshot from `getNodeStatusList()`.
   * Seeded into the shared polling buffer on first mount so a cold
   * load of `/nodes/[id]` (no Status tab visit first) does not render
   * every card as `absent` for up to a full poll interval. Empty when
   * the caller lacks `services:read` or the manager is unreachable.
   */
  initialEdges?: NodeStatus[];
  /** Initial capture timestamp (server-rendered ISO string). */
  initialCapturedAt?: string;
}

/**
 * Detail-page service cards for one node. One card per service kind,
 * each carrying:
 *   - the localised service name as the header,
 *   - the on / off / idle badge with diagnostic tooltip,
 *   - a "Last checked Xs ago" footer that updates with each poll.
 *
 * Drives the external-probe loop (the detail page may be opened
 * directly without first visiting the Status tab) and reads the per-
 * node status via `useServiceStatus`. Phase Node-5 will replace the
 * surrounding placeholder layout with the full dashboard; until then,
 * these cards are mounted on the placeholder route so the Phase Node-7
 * acceptance can be exercised end-to-end without waiting for Node-5.
 */
export function NodeDetailServiceCards({
  nodeId,
  canReadServices,
  initialEdges,
  initialCapturedAt,
}: NodeDetailServiceCardsProps) {
  const t = useTranslations("nodes");
  const tStatus = useTranslations("nodes.status.serviceStatus");
  // The external Giganto / Tivan probe loop is driven by
  // `ExternalServiceProbeDriver` mounted in
  // `nodes/(gate)/(probe)/layout.tsx`, so the snapshot survives
  // intra-segment navigation (e.g. Status row → detail page) without
  // bouncing the driver count through zero and resetting both outcomes
  // to `unknown` (which would first-paint Off until the next probe
  // lands). The card consumes the shared store via
  // `useServiceStatus(..., { enabled: false })` below.

  // Seed the shared polling buffer from the SSR snapshot. Mirrors
  // what `NodeStatusTable` does on the Status tab — populates the
  // rolling buffer so subsequent polls can compute `segmentBoundary`
  // honestly and so the Status tab benefits from this navigation
  // when the user pivots back. The first-paint correctness no longer
  // depends on this effect: `useServiceStatus` reads from the
  // `initialNodeStatus` fallback below for the same render.
  useEffect(() => {
    if (!initialEdges || initialEdges.length === 0 || !initialCapturedAt) {
      return;
    }
    seedNodeStatusFromSnapshot(new Date(initialCapturedAt), initialEdges);
  }, [initialCapturedAt, initialEdges]);

  // The matching SSR snapshot for *this* node. Threaded into
  // `useServiceStatus` so the first render — both server-side and
  // pre-hydration on the client — paints the truthful per-service
  // state instead of the empty-store `Off / absent` flash.
  const initialNodeStatus = useMemo<NodeStatus | null>(() => {
    if (!initialEdges) return null;
    return initialEdges.find((edge) => edge.id === nodeId) ?? null;
  }, [initialEdges, nodeId]);
  const initialCapturedAtDate = useMemo<Date | null>(() => {
    if (!initialCapturedAt) return null;
    const parsed = new Date(initialCapturedAt);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }, [initialCapturedAt]);

  const result = useServiceStatus(nodeId, {
    canRead: canReadServices,
    enabled: false,
    initialNodeStatus,
    initialCapturedAt: initialCapturedAtDate,
  });

  return (
    <div
      className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
      data-testid="node-detail-service-cards"
    >
      {ALL_SERVICE_KINDS.map((kind) => {
        const entry = result.entries[kind];
        return (
          <div
            key={kind}
            className="flex flex-col gap-2 rounded-lg border bg-card p-4"
            data-testid={`node-detail-service-card-${kind}`}
          >
            <header className="flex items-center justify-between">
              <h3 className="text-sm font-medium">
                {t(`status.serviceColumns.${kind}`)}
              </h3>
              <ServiceStatusBadge
                status={entry.status}
                reason={entry.reason}
                testId={`node-detail-service-${kind}`}
              />
            </header>
            <LastCheckedFooter
              lastCheckedAt={result.lastCheckedByService[kind]}
              never={tStatus("lastCheckedNever")}
              templateKey="lastChecked"
            />
          </div>
        );
      })}
    </div>
  );
}

interface LastCheckedFooterProps {
  lastCheckedAt: Date | null;
  never: string;
  templateKey: "lastChecked";
}

function LastCheckedFooter({
  lastCheckedAt,
  never,
  templateKey,
}: LastCheckedFooterProps) {
  const t = useTranslations("nodes.status.serviceStatus");
  // Defer reading `Date.now()` to a post-mount effect so the first
  // render is deterministic across SSR and client hydration. Reading
  // it inline (even via `useState(() => Date.now())`) produces a
  // server/client skew of up to a second and trips React's hydration
  // mismatch warning on cold loads of `/nodes/[id]`.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);

  if (lastCheckedAt === null) {
    return (
      <p
        className="text-muted-foreground text-xs"
        data-testid="node-detail-service-last-checked"
      >
        {never}
      </p>
    );
  }
  // Pre-hydration: anchor `now` to `lastCheckedAt` so the string
  // renders as "0s ago" on both sides of the SSR/client boundary.
  const referenceNow = now ?? lastCheckedAt.getTime();
  const seconds = Math.max(
    0,
    Math.round((referenceNow - lastCheckedAt.getTime()) / 1000),
  );
  return (
    <p
      className="text-muted-foreground text-xs"
      data-testid="node-detail-service-last-checked"
    >
      {t(templateKey, { seconds })}
    </p>
  );
}
