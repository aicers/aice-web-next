"use client";

import { Wifi, WifiOff } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";

import { ManagerUnavailablePanel } from "@/components/node/manager-unavailable-panel";
import { ResourceSparkline } from "@/components/node/resource-sparkline";
import { readCsrfToken } from "@/components/session/session-extension-dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  type NodeStatusBuffer,
  seedNodeStatusFromSnapshot,
  useNodeStatusPolling,
} from "@/hooks/use-node-status-polling";
import { useRouter } from "@/i18n/navigation";
import type { Node as ManagerNode, NodeStatus } from "@/lib/node/types";
import {
  type ApplyPreviewActions,
  ApplyPreviewModal,
} from "./apply-preview-modal";

interface CustomerOption {
  id: string;
  name: string;
}

interface NodeDetailDashboardProps {
  node: ManagerNode;
  customers: readonly CustomerOption[];
  canEdit: boolean;
  canDelete: boolean;
  canControl: boolean;
  canApply: boolean;
  /** Initial NodeStatus snapshot for this node from SSR. */
  initialNodeStatus: NodeStatus | null;
  initialCapturedAt: string | null;
  /** Full SSR `nodeStatusList` payload for the polling buffer seed. */
  initialEdges: NodeStatus[];
  /** True when the SSR seed call hit ManagerUnavailableError. */
  initialManagerUnreachable: boolean;
  /**
   * Server actions powering the Apply preview modal. Threaded as a
   * prop so the page (a server component) can wire production
   * `"use server"` actions, while tests can pass mocks without
   * importing the production server-action modules into the test
   * environment.
   */
  applyActions: ApplyPreviewActions;
}

function hasPendingChanges(node: ManagerNode): boolean {
  if (node.nameDraft !== null) return true;
  if (node.profileDraft !== null) return true;
  if (node.agents.some((a) => a.draft !== null)) return true;
  if (node.externalServices.some((s) => s.draft !== null)) return true;
  return false;
}

export function NodeDetailDashboard({
  node,
  customers,
  canEdit,
  canDelete,
  canControl,
  canApply,
  initialNodeStatus,
  initialCapturedAt,
  initialEdges,
  initialManagerUnreachable,
  applyActions,
}: NodeDetailDashboardProps) {
  const tMeta = useTranslations("nodes.detail.metadata");
  const tControls = useTranslations("nodes.detail.controls");
  const router = useRouter();

  // Read-only consumer of the shared polling store. The driver lives in
  // the (gate) layout so navigation between pages keeps the buffer.
  const polling = useNodeStatusPolling({ enabled: false });

  // Seed the polling buffer from the SSR payload on first mount —
  // mirrors the table seeding so the sparkline has at least one point
  // before the first client poll lands.
  useEffect(() => {
    if (!initialCapturedAt) return;
    if (initialEdges.length === 0) return;
    seedNodeStatusFromSnapshot(new Date(initialCapturedAt), initialEdges);
  }, [initialCapturedAt, initialEdges]);

  const buffer: NodeStatusBuffer | null = polling.byNodeId.get(node.id) ?? null;

  // Live snapshot priority: real polled buffer > SSR initial snapshot.
  const live: NodeStatus | null = buffer?.latest ?? initialNodeStatus ?? null;
  const samples = buffer?.samples ?? [];
  const lastSampleAt = buffer?.lastSampleAt ?? null;

  const customerName = useMemo(() => {
    const id = node.profile?.customerId ?? node.profileDraft?.customerId;
    if (!id) return null;
    const match = customers.find((c) => c.id === id);
    return match?.name ?? id;
  }, [customers, node]);

  const [restartOpen, setRestartOpen] = useState(false);
  const [shutdownOpen, setShutdownOpen] = useState(false);
  const [applyOpen, setApplyOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [actionInFlight, setActionInFlight] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const performControl = useCallback(
    async (kind: "restart" | "shutdown"): Promise<boolean> => {
      const csrfToken = readCsrfToken();
      const headers: Record<string, string> = {};
      if (csrfToken) headers["X-CSRF-Token"] = csrfToken;
      try {
        const res = await fetch(
          `/api/nodes/${encodeURIComponent(node.id)}/${kind}`,
          { method: "POST", headers },
        );
        return res.ok;
      } catch {
        return false;
      }
    },
    [node.id],
  );

  const performDelete = useCallback(async (): Promise<boolean> => {
    const csrfToken = readCsrfToken();
    const headers: Record<string, string> = {};
    if (csrfToken) headers["X-CSRF-Token"] = csrfToken;
    try {
      const res = await fetch(`/api/nodes/${encodeURIComponent(node.id)}`, {
        method: "DELETE",
        headers,
      });
      return res.ok;
    } catch {
      return false;
    }
  }, [node.id]);

  const onConfirmRestart = useCallback(async () => {
    setActionInFlight(true);
    setActionError(null);
    try {
      const ok = await performControl("restart");
      if (!ok) {
        setActionError(tControls("controlError"));
        return;
      }
      setRestartOpen(false);
    } finally {
      setActionInFlight(false);
    }
  }, [performControl, tControls]);

  const onConfirmShutdown = useCallback(async () => {
    setActionInFlight(true);
    setActionError(null);
    try {
      const ok = await performControl("shutdown");
      if (!ok) {
        setActionError(tControls("controlError"));
        return;
      }
      setShutdownOpen(false);
    } finally {
      setActionInFlight(false);
    }
  }, [performControl, tControls]);

  const onConfirmDelete = useCallback(async () => {
    setActionInFlight(true);
    setActionError(null);
    try {
      const ok = await performDelete();
      if (!ok) {
        setActionError(tControls("deleteError"));
        return;
      }
      setDeleteOpen(false);
      router.push("/nodes");
    } finally {
      setActionInFlight(false);
    }
  }, [performDelete, tControls, router]);

  const onApplyConfirmed = useCallback(() => {
    setApplyOpen(false);
    setApplyPreviewOpen(true);
  }, []);

  const [applyPreviewOpen, setApplyPreviewOpen] = useState(false);

  // Mid-session manager outage: the SSR path may have rendered the
  // dashboard against a stale snapshot when manager dropped after the
  // initial fetch. Swap to the same fallback panel here.
  if (initialManagerUnreachable || polling.isManagerUnreachable) {
    return <ManagerUnavailablePanel />;
  }

  const pending = hasPendingChanges(node);
  const ping = live?.ping ?? null;
  const alive = ping !== null;

  const hostname = node.profileDraft?.hostname ?? node.profile?.hostname ?? "";
  const description =
    node.profileDraft?.description ?? node.profile?.description ?? "";
  const displayName = node.nameDraft ?? node.name;

  return (
    <section
      className="space-y-4 rounded-lg border bg-card p-6"
      data-testid="node-detail-dashboard"
      data-node-id={node.id}
    >
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-2">
          <h1 className="text-xl font-semibold" data-testid="node-detail-title">
            {displayName}
          </h1>
          <p className="text-muted-foreground text-sm font-mono">{node.id}</p>
          <div className="flex flex-wrap items-center gap-2">
            <PingBadge alive={alive} pingValue={ping} />
            {pending ? (
              <Badge
                variant="outline"
                className="border-amber-300 bg-amber-50 text-amber-800"
                data-testid="node-detail-pending-badge"
              >
                {tMeta("pendingChanges")}
              </Badge>
            ) : (
              <span
                className="text-muted-foreground text-xs"
                data-testid="node-detail-no-pending"
              >
                {tMeta("noPendingChanges")}
              </span>
            )}
          </div>
        </div>
        <div
          className="flex flex-wrap gap-2"
          data-testid="node-detail-controls"
        >
          {canEdit && (
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                router.push(`/nodes/settings?dialog=edit&id=${node.id}`)
              }
              data-testid="node-detail-edit"
            >
              {tControls("edit")}
            </Button>
          )}
          {canControl && (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setRestartOpen(true)}
                data-testid="node-detail-restart"
              >
                {tControls("restart")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShutdownOpen(true)}
                data-testid="node-detail-shutdown"
              >
                {tControls("shutdown")}
              </Button>
            </>
          )}
          {canApply && (
            <Button
              size="sm"
              onClick={() => setApplyOpen(true)}
              data-testid="node-detail-apply-all"
            >
              {tControls("applyAll")}
            </Button>
          )}
          {canDelete && (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setDeleteOpen(true)}
              data-testid="node-detail-delete"
            >
              {tControls("delete")}
            </Button>
          )}
        </div>
      </header>

      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetadataField
          label={tMeta("name")}
          value={displayName}
          testId="node-detail-meta-name"
        />
        <MetadataField
          label={tMeta("hostname")}
          value={hostname || tMeta("noHostname")}
          testId="node-detail-meta-hostname"
        />
        <MetadataField
          label={tMeta("customer")}
          value={customerName ?? tMeta("noCustomer")}
          testId="node-detail-meta-customer"
        />
        <MetadataField
          label={tMeta("description")}
          value={description || tMeta("noDescription")}
          testId="node-detail-meta-description"
        />
      </dl>

      <div
        className="grid grid-cols-1 gap-4 md:grid-cols-3"
        data-testid="node-detail-charts"
      >
        <ResourceSparkline
          metric="cpu"
          samples={samples}
          isStale={polling.isStale}
          pollIntervalMs={polling.pollIntervalMs}
          lastSampleAt={lastSampleAt}
        />
        <ResourceSparkline
          metric="memory"
          samples={samples}
          isStale={polling.isStale}
          pollIntervalMs={polling.pollIntervalMs}
          lastSampleAt={lastSampleAt}
        />
        <ResourceSparkline
          metric="disk"
          samples={samples}
          isStale={polling.isStale}
          pollIntervalMs={polling.pollIntervalMs}
          lastSampleAt={lastSampleAt}
        />
      </div>

      <ConfirmDialog
        open={restartOpen}
        onOpenChange={(open) => {
          setRestartOpen(open);
          if (!open) setActionError(null);
        }}
        title={tControls("restartConfirmTitle")}
        description={tControls("restartConfirmDescription", { hostname })}
        confirmLabel={tControls("restart")}
        cancelLabel={tControls("cancel")}
        actionInFlight={actionInFlight}
        actionError={actionError}
        onConfirm={onConfirmRestart}
        testId="node-detail-restart-confirm"
      />
      <ConfirmDialog
        open={shutdownOpen}
        onOpenChange={(open) => {
          setShutdownOpen(open);
          if (!open) setActionError(null);
        }}
        title={tControls("shutdownConfirmTitle")}
        description={tControls("shutdownConfirmDescription", { hostname })}
        confirmLabel={tControls("shutdown")}
        cancelLabel={tControls("cancel")}
        actionInFlight={actionInFlight}
        actionError={actionError}
        onConfirm={onConfirmShutdown}
        testId="node-detail-shutdown-confirm"
      />
      <ConfirmDialog
        open={applyOpen}
        onOpenChange={(open) => {
          setApplyOpen(open);
          if (!open) setActionError(null);
        }}
        title={tControls("applyAllConfirmTitle")}
        description={tControls("applyAllConfirmDescription")}
        confirmLabel={tControls("applyAll")}
        cancelLabel={tControls("cancel")}
        actionInFlight={false}
        actionError={null}
        onConfirm={onApplyConfirmed}
        testId="node-detail-apply-all-confirm"
      />
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={(open) => {
          setDeleteOpen(open);
          if (!open) setActionError(null);
        }}
        title={tControls("deleteConfirmTitle")}
        description={tControls("deleteConfirmDescription", { hostname })}
        confirmLabel={tControls("delete")}
        cancelLabel={tControls("cancel")}
        actionInFlight={actionInFlight}
        actionError={actionError}
        onConfirm={onConfirmDelete}
        testId="node-detail-delete-confirm"
      />
      <ApplyPreviewModal
        open={applyPreviewOpen}
        onOpenChange={setApplyPreviewOpen}
        nodeId={node.id}
        actions={applyActions}
      />
    </section>
  );
}

function MetadataField({
  label,
  value,
  testId,
}: {
  label: string;
  value: string;
  testId: string;
}) {
  return (
    <div className="space-y-1">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="text-sm" data-testid={testId}>
        {value}
      </dd>
    </div>
  );
}

function PingBadge({
  alive,
  pingValue,
}: {
  alive: boolean;
  pingValue: number | null;
}) {
  const t = useTranslations("nodes.detail.ping");
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    setHydrated(true);
  }, []);
  if (alive) {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs text-emerald-800"
        data-testid="node-detail-ping"
        data-ping="alive"
      >
        <Wifi className="h-3 w-3" aria-hidden="true" />
        <span>{t("alive")}</span>
        {pingValue !== null && (
          <span className="text-muted-foreground">
            {hydrated ? ` · ${(pingValue * 1000).toFixed(0)}ms` : ""}
          </span>
        )}
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border border-rose-200 bg-rose-50 px-2 py-0.5 text-xs text-rose-800"
      data-testid="node-detail-ping"
      data-ping="dead"
    >
      <WifiOff className="h-3 w-3" aria-hidden="true" />
      {t("dead")}
    </span>
  );
}

function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel,
  actionInFlight,
  actionError,
  onConfirm,
  testId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel: string;
  actionInFlight: boolean;
  actionError: string | null;
  onConfirm: () => void;
  testId: string;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent data-testid={testId}>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {actionError && (
          <p className="text-destructive text-sm">{actionError}</p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>{cancelLabel}</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              onConfirm();
            }}
            disabled={actionInFlight}
            data-testid={`${testId}-button`}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
