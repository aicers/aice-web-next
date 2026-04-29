"use client";

import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  seedNodeStatusFromSnapshot,
  useNodeStatusPolling,
} from "@/hooks/use-node-status-polling";
import { useServiceStatus } from "@/hooks/use-service-status";
import { Link } from "@/i18n/navigation";
import { diffServiceConfig } from "@/lib/node/diff";
import {
  AGENT_KIND_TO_SERVICE,
  type ServiceKind,
} from "@/lib/node/service-status";
import type {
  Agent,
  AgentKind,
  ExternalService,
  ExternalServiceKind,
  Node as ManagerNode,
  NodeStatus,
} from "@/lib/node/types";

import { ServiceStatusBadge } from "./service-status-badge";

interface NodeDetailServiceGridProps {
  node: ManagerNode;
  canReadServices: boolean;
  canEditServices: boolean;
  /** Initial NodeStatus for this node from SSR (for first paint). */
  initialNodeStatus: NodeStatus | null;
  initialCapturedAt: string | null;
  /** Full SSR `nodeStatusList` payload to seed the polling buffer. */
  initialEdges: NodeStatus[];
  /**
   * Applied external-service TOML config keyed by external kind. Empty
   * string means the probe failed (unreachable); missing key means the
   * node does not host that external.
   */
  appliedExternalConfigs: Record<ExternalServiceKind, string | null>;
  /** External kinds whose applied-config fetch reported unreachable. */
  unreachableExternals: ReadonlySet<ExternalServiceKind>;
}

const AGENT_KIND_ORDER: AgentKind[] = [
  "SENSOR",
  "UNSUPERVISED",
  "SEMI_SUPERVISED",
  "TIME_SERIES_GENERATOR",
];

const EXTERNAL_KIND_ORDER: ExternalServiceKind[] = [
  "DATA_STORE",
  "TI_CONTAINER",
];

/**
 * Detail-page service card grid. Renders:
 *   - Manager card (status-only, special)
 *   - One agent card per agent on the node, with tabs for non-Unsupervised
 *   - One external-service card per external on the node, with tabs
 */
export function NodeDetailServiceGrid({
  node,
  canReadServices,
  canEditServices,
  initialNodeStatus,
  initialCapturedAt,
  initialEdges,
  appliedExternalConfigs,
  unreachableExternals,
}: NodeDetailServiceGridProps) {
  const t = useTranslations("nodes.detail.services");

  // Seed the polling buffer (mirrors what NodeDetailDashboard does).
  // Both components mount under the same page so seeding from either is
  // safe — `seedNodeStatusFromSnapshot` no-ops when fresher data is
  // already present.
  useEffect(() => {
    if (!initialCapturedAt) return;
    if (initialEdges.length === 0) return;
    seedNodeStatusFromSnapshot(new Date(initialCapturedAt), initialEdges);
  }, [initialCapturedAt, initialEdges]);

  const initialCapturedAtDate = useMemo<Date | null>(() => {
    if (!initialCapturedAt) return null;
    const parsed = new Date(initialCapturedAt);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }, [initialCapturedAt]);

  const result = useServiceStatus(node.id, {
    canRead: canReadServices,
    enabled: false,
    initialNodeStatus,
    initialCapturedAt: initialCapturedAtDate,
  });

  // The Manager card must reflect live manager status, not just the SSR
  // snapshot — every other badge on this page consumes the shared
  // polling buffer, and a Manager-card-only divergence would lie about
  // the running state after a visibility-resume one-shot or a normal
  // poll tick.
  const polling = useNodeStatusPolling({ enabled: false });
  const liveStatus: NodeStatus | null =
    polling.byNodeId.get(node.id)?.latest ?? initialNodeStatus ?? null;
  const managerRunning = liveStatus?.manager ?? false;

  const agentByKind = useMemo(() => {
    const map = new Map<AgentKind, Agent>();
    for (const agent of node.agents) map.set(agent.kind, agent);
    return map;
  }, [node.agents]);

  const externalByKind = useMemo(() => {
    const map = new Map<ExternalServiceKind, ExternalService>();
    for (const ext of node.externalServices) map.set(ext.kind, ext);
    return map;
  }, [node.externalServices]);

  return (
    <section className="space-y-3" data-testid="node-detail-service-grid">
      <h2 className="text-lg font-semibold">{t("heading")}</h2>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
        <ManagerCard managerRunning={managerRunning} />

        {AGENT_KIND_ORDER.map((kind) => {
          const agent = agentByKind.get(kind);
          if (!agent) return null;
          const serviceKey = AGENT_KIND_TO_SERVICE[kind];
          const entry = result.entries[serviceKey];
          if (kind === "UNSUPERVISED") {
            return (
              <UnsupervisedCard
                key={kind}
                serviceKey={serviceKey}
                statusBadge={
                  <ServiceStatusBadge
                    status={entry.status}
                    reason={entry.reason}
                    testId={`node-detail-service-${serviceKey}`}
                  />
                }
              />
            );
          }
          return (
            <AgentServiceCard
              key={kind}
              nodeId={node.id}
              agent={agent}
              serviceKey={serviceKey}
              statusBadge={
                <ServiceStatusBadge
                  status={entry.status}
                  reason={entry.reason}
                  testId={`node-detail-service-${serviceKey}`}
                />
              }
              canEdit={canEditServices}
            />
          );
        })}

        {EXTERNAL_KIND_ORDER.map((kind) => {
          const ext = externalByKind.get(kind);
          if (!ext) return null;
          const serviceKey: ServiceKind =
            kind === "DATA_STORE" ? "dataStore" : "tiContainer";
          const entry = result.entries[serviceKey];
          const applied = appliedExternalConfigs[kind] ?? null;
          const unreachable = unreachableExternals.has(kind);
          return (
            <ExternalServiceCard
              key={kind}
              nodeId={node.id}
              kind={kind}
              service={ext}
              serviceKey={serviceKey}
              applied={applied}
              unreachable={unreachable}
              statusBadge={
                <ServiceStatusBadge
                  status={entry.status}
                  reason={entry.reason}
                  testId={`node-detail-service-${serviceKey}`}
                />
              }
              canEdit={canEditServices}
            />
          );
        })}
      </div>
    </section>
  );
}

function ManagerCard({ managerRunning }: { managerRunning: boolean }) {
  const t = useTranslations("nodes.detail.services");
  return (
    <article
      className="flex flex-col gap-2 rounded-lg border bg-card p-4"
      data-testid="node-detail-manager-card"
      data-running={managerRunning ? "true" : "false"}
    >
      <header className="flex items-center justify-between">
        <h3 className="text-sm font-medium">{t("manager")}</h3>
        <Badge
          variant={managerRunning ? "default" : "secondary"}
          data-testid="node-detail-manager-badge"
        >
          {managerRunning ? t("managerRunning") : t("managerNotRunning")}
        </Badge>
      </header>
    </article>
  );
}

function UnsupervisedCard({
  serviceKey,
  statusBadge,
}: {
  serviceKey: ServiceKind;
  statusBadge: React.ReactNode;
}) {
  const t = useTranslations("nodes.detail.services");
  const tColumns = useTranslations("nodes.status.serviceColumns");
  return (
    <article
      className="flex flex-col gap-2 rounded-lg border bg-card p-4"
      data-testid={`node-detail-service-card-${serviceKey}`}
    >
      <header className="flex items-center justify-between">
        <h3 className="text-sm font-medium">{tColumns(serviceKey)}</h3>
        {statusBadge}
      </header>
      <p
        className="text-muted-foreground text-xs"
        data-testid={`node-detail-service-${serviceKey}-note`}
      >
        {t("unsupervisedNote")}
      </p>
    </article>
  );
}

interface AgentServiceCardProps {
  nodeId: string;
  agent: Agent;
  serviceKey: ServiceKind;
  statusBadge: React.ReactNode;
  canEdit: boolean;
}

function AgentServiceCard({
  nodeId,
  agent,
  serviceKey,
  statusBadge,
  canEdit,
}: AgentServiceCardProps) {
  const tColumns = useTranslations("nodes.status.serviceColumns");
  const tServices = useTranslations("nodes.detail.services");
  const pending = agent.draft !== null;
  return (
    <article
      className="flex flex-col gap-2 rounded-lg border bg-card p-4"
      data-testid={`node-detail-service-card-${serviceKey}`}
    >
      <header className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{tColumns(serviceKey)}</h3>
        <div className="flex items-center gap-1.5">
          {pending && (
            <Badge
              variant="outline"
              className="border-amber-300 bg-amber-50 text-amber-800"
              data-testid={`node-detail-service-${serviceKey}-pending`}
            >
              {tServices("pendingBadge")}
            </Badge>
          )}
          {statusBadge}
        </div>
      </header>
      <ServiceConfigTabs
        nodeId={nodeId}
        serviceKey={serviceKey}
        applied={agent.config}
        draft={agent.draft}
        canEdit={canEdit}
        unreachable={false}
      />
    </article>
  );
}

interface ExternalServiceCardProps {
  nodeId: string;
  kind: ExternalServiceKind;
  service: ExternalService;
  serviceKey: ServiceKind;
  applied: string | null;
  unreachable: boolean;
  statusBadge: React.ReactNode;
  canEdit: boolean;
}

function ExternalServiceCard({
  nodeId,
  service,
  serviceKey,
  applied,
  unreachable,
  statusBadge,
  canEdit,
}: ExternalServiceCardProps) {
  const tColumns = useTranslations("nodes.status.serviceColumns");
  const tServices = useTranslations("nodes.detail.services");
  const pending = service.draft !== null;
  return (
    <article
      className="flex flex-col gap-2 rounded-lg border bg-card p-4"
      data-testid={`node-detail-service-card-${serviceKey}`}
    >
      <header className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{tColumns(serviceKey)}</h3>
        <div className="flex items-center gap-1.5">
          {pending && (
            <Badge
              variant="outline"
              className="border-amber-300 bg-amber-50 text-amber-800"
              data-testid={`node-detail-service-${serviceKey}-pending`}
            >
              {tServices("pendingBadge")}
            </Badge>
          )}
          {statusBadge}
        </div>
      </header>
      <ServiceConfigTabs
        nodeId={nodeId}
        serviceKey={serviceKey}
        applied={applied}
        draft={service.draft}
        canEdit={canEdit}
        unreachable={unreachable}
      />
    </article>
  );
}

interface ServiceConfigTabsProps {
  nodeId: string;
  serviceKey: ServiceKind;
  applied: string | null;
  draft: string | null;
  canEdit: boolean;
  unreachable: boolean;
}

function ServiceConfigTabs({
  nodeId,
  serviceKey,
  applied,
  draft,
  canEdit,
  unreachable,
}: ServiceConfigTabsProps) {
  const t = useTranslations("nodes.detail.services");
  const [tab, setTab] = useState<"applied" | "draft" | "diff">("applied");
  return (
    <Tabs
      value={tab}
      onValueChange={(value) => setTab(value as "applied" | "draft" | "diff")}
      className="mt-1"
      data-testid={`node-detail-service-${serviceKey}-tabs`}
    >
      <TabsList variant="line">
        <TabsTrigger
          value="applied"
          data-testid={`node-detail-service-${serviceKey}-tab-applied`}
        >
          {t("tabs.applied")}
        </TabsTrigger>
        <TabsTrigger
          value="draft"
          data-testid={`node-detail-service-${serviceKey}-tab-draft`}
        >
          {t("tabs.draft")}
        </TabsTrigger>
        <TabsTrigger
          value="diff"
          data-testid={`node-detail-service-${serviceKey}-tab-diff`}
        >
          {t("tabs.diff")}
        </TabsTrigger>
      </TabsList>
      <TabsContent value="applied">
        <AppliedTab
          serviceKey={serviceKey}
          applied={applied}
          unreachable={unreachable}
        />
      </TabsContent>
      <TabsContent value="draft">
        <DraftTab
          nodeId={nodeId}
          serviceKey={serviceKey}
          draft={draft}
          canEdit={canEdit}
        />
      </TabsContent>
      <TabsContent value="diff">
        <DiffTab
          serviceKey={serviceKey}
          applied={applied}
          draft={draft}
          unreachable={unreachable}
        />
      </TabsContent>
    </Tabs>
  );
}

function AppliedTab({
  serviceKey,
  applied,
  unreachable,
}: {
  serviceKey: ServiceKind;
  applied: string | null;
  unreachable: boolean;
}) {
  const t = useTranslations("nodes.detail.services");
  if (unreachable) {
    return (
      <p
        className="text-muted-foreground text-sm"
        data-testid={`node-detail-service-${serviceKey}-applied-unreachable`}
      >
        {t("externalUnreachable.applied")}
      </p>
    );
  }
  if (!applied) {
    return (
      <p
        className="text-muted-foreground text-sm"
        data-testid={`node-detail-service-${serviceKey}-applied-empty`}
      >
        {t("appliedEmpty")}
      </p>
    );
  }
  return (
    <pre
      className="bg-muted/40 max-h-64 overflow-auto rounded-md p-3 text-xs"
      data-testid={`node-detail-service-${serviceKey}-applied`}
    >
      {applied}
    </pre>
  );
}

function DraftTab({
  nodeId,
  serviceKey,
  draft,
  canEdit,
}: {
  nodeId: string;
  serviceKey: ServiceKind;
  draft: string | null;
  canEdit: boolean;
}) {
  const t = useTranslations("nodes.detail.services");
  return (
    <div className="space-y-2">
      {draft ? (
        <pre
          className="bg-muted/40 max-h-64 overflow-auto rounded-md p-3 text-xs"
          data-testid={`node-detail-service-${serviceKey}-draft`}
        >
          {draft}
        </pre>
      ) : (
        <p
          className="text-muted-foreground text-sm"
          data-testid={`node-detail-service-${serviceKey}-draft-empty`}
        >
          {t("draftEmpty")}
        </p>
      )}
      {canEdit && (
        <Link
          href={`/nodes/settings?dialog=edit&id=${nodeId}#service-${serviceKey}`}
          className="text-primary text-xs underline-offset-2 hover:underline"
          data-testid={`node-detail-service-${serviceKey}-edit-link`}
        >
          {t("editService")}
        </Link>
      )}
    </div>
  );
}

function DiffTab({
  serviceKey,
  applied,
  draft,
  unreachable,
}: {
  serviceKey: ServiceKind;
  applied: string | null;
  draft: string | null;
  unreachable: boolean;
}) {
  const t = useTranslations("nodes.detail.services");
  if (unreachable) {
    return (
      <p
        className="text-muted-foreground text-sm"
        data-testid={`node-detail-service-${serviceKey}-diff-unreachable`}
      >
        {t("externalUnreachable.diff")}
      </p>
    );
  }
  // "No pending changes" is a draft-presence question, not a structural
  // diff question: a service with no `draft` carries no operator intent
  // to change anything, even if its applied config is non-empty. Without
  // this gate, `diffServiceConfig(applied, null)` would surface every
  // applied key as "applied → unset", which contradicts the issue's
  // empty-state contract.
  const entries = draft === null ? [] : diffServiceConfig(applied, draft);
  if (entries.length === 0) {
    return (
      <div
        className="space-y-2"
        data-testid={`node-detail-service-${serviceKey}-diff-empty`}
      >
        <p className="text-muted-foreground text-sm">{t("diffEmpty")}</p>
        <hr className="border-muted-foreground/20" />
      </div>
    );
  }
  return (
    <table
      className="w-full text-left text-xs"
      data-testid={`node-detail-service-${serviceKey}-diff`}
    >
      <thead className="text-muted-foreground">
        <tr>
          <th className="px-2 py-1">{t("diffColumns.field")}</th>
          <th className="px-2 py-1">{t("diffColumns.applied")}</th>
          <th className="px-2 py-1">{t("diffColumns.draft")}</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((entry) => (
          <tr
            key={entry.fieldPath}
            className="border-t"
            data-testid={`node-detail-service-${serviceKey}-diff-row-${entry.fieldPath}`}
          >
            <td className="px-2 py-1 font-mono">{entry.fieldPath}</td>
            <td className="px-2 py-1 font-mono">
              {entry.applied ?? t("diffUnset")}
            </td>
            <td className="px-2 py-1 font-mono">
              {entry.draft ?? t("diffUnset")}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
