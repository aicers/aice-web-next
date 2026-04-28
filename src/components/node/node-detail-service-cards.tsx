"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import {
  useExternalServiceProbes,
  useServiceStatus,
} from "@/hooks/use-service-status";
import { ALL_SERVICE_KINDS } from "@/lib/node/service-status";

import { ServiceStatusBadge } from "./service-status-badge";

interface NodeDetailServiceCardsProps {
  nodeId: string;
  canReadServices: boolean;
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
}: NodeDetailServiceCardsProps) {
  const t = useTranslations("nodes");
  const tStatus = useTranslations("nodes.status.serviceStatus");
  // Detail page may be entered cold (no Status tab visit first), so
  // drive the probe loop here too. The driver is ref-counted, so when
  // both surfaces mount, only one loop runs.
  useExternalServiceProbes({ enabled: canReadServices });
  const result = useServiceStatus(nodeId, {
    canRead: canReadServices,
    enabled: false,
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
              lastCheckedAt={result.lastCheckedAt}
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
  const [now, setNow] = useState(() => Date.now());
  // Tick the relative clock once a second so the "Last checked Xs ago"
  // string stays honest between polls. The interval is independent of
  // the polling cadence — operators expect the timer to tick visibly.
  useEffect(() => {
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
  const seconds = Math.max(
    0,
    Math.round((now - lastCheckedAt.getTime()) / 1000),
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
