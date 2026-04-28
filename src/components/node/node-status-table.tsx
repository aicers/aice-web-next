"use client";

import { MoreVertical, Power, RotateCw } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";

import { ManagerUnavailablePanel } from "@/components/node/manager-unavailable-panel";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  type NodeStatusBuffer,
  seedNodeStatusFromSnapshot,
  useNodeStatusPolling,
} from "@/hooks/use-node-status-polling";
import { useServiceStatus } from "@/hooks/use-service-status";
import { Link, useRouter } from "@/i18n/navigation";
import type { NodeStatus } from "@/lib/node/types";
import { cn } from "@/lib/utils";

import { SERVICE_COLUMN_ORDER } from "./node-list-types";
import type { NodeStatusRowSnapshot } from "./node-status-row";
import { ServiceStatusBadge } from "./service-status-badge";

interface NodeStatusTableProps {
  initialRows: NodeStatusRowSnapshot[];
  /**
   * Full SSR `nodeStatusList` payload. Carries the per-node agents and
   * external services that drive the per-service `on / off / idle`
   * cells. Seeded into the polling buffer on first mount so the cells
   * render immediately from the SSR snapshot rather than waiting for
   * the first client poll to land (which can be up to one full
   * `pollIntervalMs` after the first paint).
   */
  initialEdges: NodeStatus[];
  /** Initial capture timestamp (server-rendered ISO string). */
  initialCapturedAt: string;
  /** Whether the caller can issue restart / shutdown actions. */
  canControl: boolean;
  /**
   * Whether the caller holds `services:read`. Threaded through so the
   * per-row `useServiceStatus` hook can run its defence-in-depth check
   * with the same permission tuple as the page-level gate. The
   * `(gate)/layout.tsx` enforces this layout-wide; this prop exists so
   * the table cannot accidentally render service cells for a future
   * caller that bypasses the layout.
   */
  canReadServices: boolean;
}

export function NodeStatusTable({
  initialRows,
  initialEdges,
  initialCapturedAt,
  canControl,
  canReadServices,
}: NodeStatusTableProps) {
  const t = useTranslations("nodes.status");

  // Read-only consumer of the shared store. The polling loop is driven
  // by `NodeStatusPollingDriver` mounted in `nodes/(gate)/layout.tsx`
  // so the rolling buffer survives `/nodes` ↔ `/nodes/[id]` navigation.
  const polling = useNodeStatusPolling({ enabled: false });

  // Seed the polling buffer from the SSR payload on first mount. The
  // driver intentionally defers the first client tick until the first
  // `pollIntervalMs` boundary; without this seed the per-service cells
  // would still benefit from the SSR fallback below on first paint,
  // but a subsequent re-render before the first poll lands would lose
  // the `lastSampleAt` history `segmentBoundary` calculations rely on.
  useEffect(() => {
    if (initialEdges.length === 0) return;
    seedNodeStatusFromSnapshot(new Date(initialCapturedAt), initialEdges);
  }, [initialCapturedAt, initialEdges]);

  // Per-row SSR `NodeStatus` lookup. Threaded into each row's
  // `useServiceStatus(..., { initialNodeStatus })` so the truthful
  // per-service state lands in the server-rendered HTML itself —
  // matching the cold-load fix the detail page already carries. The
  // seed effect above only runs after hydration, so without this map
  // the SSR snapshot and pre-hydration client render still paint
  // `absent` em-dashes in the configured service columns until the
  // seed lands. Mirrors the lookup `NodeDetailServiceCards` performs
  // for its single-node case.
  const initialEdgeById = useMemo(() => {
    const map = new Map<string, NodeStatus>();
    for (const edge of initialEdges) map.set(edge.id, edge);
    return map;
  }, [initialEdges]);
  const initialCapturedAtDate = useMemo(() => {
    const parsed = new Date(initialCapturedAt);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }, [initialCapturedAt]);

  // The external Giganto / Tivan probe loop is driven by
  // `ExternalServiceProbeDriver` mounted in `nodes/(gate)/layout.tsx`
  // so the snapshot survives intra-segment navigation (`/nodes` ↔
  // `/nodes/[id]`) without bouncing the driver count through zero and
  // resetting Giganto / Tivan outcomes to `unknown` between pages.
  // Per-row `useServiceStatus` consumers pass `enabled: false`, so
  // they read from the shared store without spinning up parallel
  // loops.

  // Row topology is driven by the latest polled snapshot, not frozen
  // to the server-rendered list. `getNodeStatusList` is a point-in-
  // time view of the current manager response, so the table needs to
  // pick up nodes that appear after the first render and drop nodes
  // that disappear from later polls (the polling store already prunes
  // missing ids). The server-rendered `initialRows` is only used to
  // fill the gap between mount and the first client poll lands.
  const rows = useMemo<NodeStatusRowSnapshot[]>(() => {
    if (polling.capturedAt === null) {
      return initialRows;
    }
    const fromPolling: NodeStatusRowSnapshot[] = [];
    for (const [id, buf] of polling.byNodeId) {
      const live = buf.latest;
      if (!live) continue;
      fromPolling.push({
        id,
        name: live.nameDraft ?? live.name,
        hostname: live.profile?.hostname ?? live.profileDraft?.hostname ?? "",
        manager: live.manager,
        ping: live.ping,
        cpuUsage: live.cpuUsage,
        totalMemory: live.totalMemory,
        usedMemory: live.usedMemory,
        totalDiskSpace: live.totalDiskSpace,
        usedDiskSpace: live.usedDiskSpace,
      });
    }
    return fromPolling;
  }, [initialRows, polling.byNodeId, polling.capturedAt]);

  const [restartTarget, setRestartTarget] =
    useState<NodeStatusRowSnapshot | null>(null);
  const [shutdownTarget, setShutdownTarget] =
    useState<NodeStatusRowSnapshot | null>(null);
  const [actionInFlight, setActionInFlight] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const performControl = useCallback(
    async (kind: "restart" | "shutdown", id: string): Promise<boolean> => {
      const csrfToken = readCsrfToken();
      const headers: Record<string, string> = {};
      if (csrfToken) headers["X-CSRF-Token"] = csrfToken;
      // Wrap `fetch()` so a transport-level failure (browser offline,
      // connection reset, same-origin server restart) reaches the
      // dialog's `controlError` surface like a non-OK HTTP response,
      // instead of escaping the click handler as an unhandled rejection.
      try {
        const res = await fetch(
          `/api/nodes/${encodeURIComponent(id)}/${kind}`,
          {
            method: "POST",
            headers,
          },
        );
        return res.ok;
      } catch {
        return false;
      }
    },
    [],
  );

  const onConfirmRestart = useCallback(async () => {
    if (!restartTarget) return;
    setActionInFlight(true);
    setActionError(null);
    try {
      const ok = await performControl("restart", restartTarget.id);
      if (!ok) {
        setActionError(t("controlError"));
        return;
      }
      setRestartTarget(null);
    } finally {
      setActionInFlight(false);
    }
  }, [performControl, restartTarget, t]);

  const onConfirmShutdown = useCallback(async () => {
    if (!shutdownTarget) return;
    setActionInFlight(true);
    setActionError(null);
    try {
      const ok = await performControl("shutdown", shutdownTarget.id);
      if (!ok) {
        setActionError(t("controlError"));
        return;
      }
      setShutdownTarget(null);
    } finally {
      setActionInFlight(false);
    }
  }, [performControl, shutdownTarget, t]);

  // Defer locale-sensitive timestamp formatting until after mount.
  // `toLocaleTimeString()` reads the OS locale on the server and the
  // browser locale on the client, so rendering it during SSR triggers
  // a hydration mismatch warning.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    setHydrated(true);
  }, []);
  const lastUpdatedLabel = !hydrated
    ? ""
    : polling.lastSampleAt
      ? polling.lastSampleAt.toLocaleTimeString()
      : new Date(initialCapturedAt).toLocaleTimeString();

  // If the manager goes unreachable after the first paint, swap to the
  // same fallback panel the SSR path uses. The polling fetcher tags
  // 503 responses on `/api/nodes/status`; until a subsequent fetch
  // succeeds, the table area is replaced rather than left frozen on a
  // stale snapshot. The check sits below all hook calls so the early
  // return does not violate the Rules of Hooks.
  if (polling.isManagerUnreachable) {
    return <ManagerUnavailablePanel />;
  }

  return (
    <div
      className="space-y-4"
      data-testid="node-status-page"
      data-polling={polling.isPolling ? "true" : "false"}
      data-stale={polling.isStale ? "true" : "false"}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-muted-foreground text-xs">
          {polling.isStale
            ? t("staleHint", { time: lastUpdatedLabel })
            : t("lastUpdated", { time: lastUpdatedLabel })}
        </p>
      </div>

      <div className="overflow-hidden rounded-lg bg-card">
        <Table data-testid="node-status-table">
          <TableHeader>
            <TableRow>
              <TableHead>{t("columns.name")}</TableHead>
              <TableHead>{t("columns.cpu")}</TableHead>
              <TableHead>{t("columns.memory")}</TableHead>
              <TableHead>{t("columns.disk")}</TableHead>
              <TableHead className="text-center">
                {t("columns.manager")}
              </TableHead>
              {SERVICE_COLUMN_ORDER.map((column) => (
                <TableHead key={column} className="text-center">
                  {t(`serviceColumns.${column}`)}
                </TableHead>
              ))}
              <TableHead className="w-[44px]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={5 + SERVICE_COLUMN_ORDER.length + 1}
                  className="text-muted-foreground py-8 text-center text-sm"
                >
                  {t("empty")}
                </TableCell>
              </TableRow>
            )}
            {rows.map((row) => (
              <NodeStatusRow
                key={row.id}
                row={row}
                buffer={polling.byNodeId.get(row.id) ?? null}
                canControl={canControl}
                canReadServices={canReadServices}
                initialNodeStatus={initialEdgeById.get(row.id) ?? null}
                initialCapturedAt={initialCapturedAtDate}
                onRestart={() => setRestartTarget(row)}
                onShutdown={() => setShutdownTarget(row)}
              />
            ))}
          </TableBody>
        </Table>
      </div>

      <AlertDialog
        open={restartTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRestartTarget(null);
            setActionError(null);
          }
        }}
      >
        <AlertDialogContent data-testid="node-restart-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("restartConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("restartConfirmDescription", {
                hostname: restartTarget?.hostname || restartTarget?.name || "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {actionError && (
            <p className="text-destructive text-sm">{actionError}</p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                onConfirmRestart();
              }}
              disabled={actionInFlight}
              data-testid="node-restart-confirm-button"
            >
              {t("restart")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={shutdownTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setShutdownTarget(null);
            setActionError(null);
          }
        }}
      >
        <AlertDialogContent data-testid="node-shutdown-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("shutdownConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("shutdownConfirmDescription", {
                hostname:
                  shutdownTarget?.hostname || shutdownTarget?.name || "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {actionError && (
            <p className="text-destructive text-sm">{actionError}</p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                onConfirmShutdown();
              }}
              disabled={actionInFlight}
              data-testid="node-shutdown-confirm-button"
            >
              {t("shutdown")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

interface NodeStatusRowProps {
  row: NodeStatusRowSnapshot;
  buffer: NodeStatusBuffer | null;
  canControl: boolean;
  canReadServices: boolean;
  initialNodeStatus: NodeStatus | null;
  initialCapturedAt: Date | null;
  onRestart: () => void;
  onShutdown: () => void;
}

function NodeStatusRow({
  row,
  canControl,
  canReadServices,
  initialNodeStatus,
  initialCapturedAt,
  onRestart,
  onShutdown,
}: NodeStatusRowProps) {
  const t = useTranslations("nodes.status");
  const router = useRouter();
  const memoryRatio = ratioOf(row.usedMemory, row.totalMemory);
  const diskRatio = ratioOf(row.usedDiskSpace, row.totalDiskSpace);

  // The Status row is the read-only entry point into the detail-page
  // apply flow (the issue calls this out explicitly). The Name cell
  // owns href / keyboard navigation via a real `<Link>`; this mouse
  // handler extends the click target to the rest of the row, with the
  // kebab trigger / menu items / dialogs calling `stopPropagation` so
  // they don't get pre-empted by the row navigation.
  const onRowClick = useCallback(() => {
    router.push(`/nodes/${row.id}`);
  }, [router, row.id]);
  const stopRowNav = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
  }, []);

  return (
    <TableRow
      className="cursor-pointer"
      data-testid="node-status-row"
      data-row-id={row.id}
      onClick={onRowClick}
    >
      <TableCell className="font-medium">
        <Link
          href={`/nodes/${row.id}`}
          className="hover:text-primary flex flex-col leading-tight outline-none focus-visible:underline"
          data-testid="node-status-row-link"
          onClick={stopRowNav}
        >
          <span>{row.name}</span>
          <span className="text-muted-foreground text-xs">{row.hostname}</span>
        </Link>
      </TableCell>
      <TableCell>
        <ProgressBar
          ratio={row.cpuUsage !== null ? row.cpuUsage / 100 : null}
          label={
            row.cpuUsage !== null ? `${row.cpuUsage.toFixed(1)}%` : t("noData")
          }
          testId="node-status-cpu"
        />
      </TableCell>
      <TableCell>
        <ProgressBar
          ratio={memoryRatio}
          label={
            row.totalMemory && row.usedMemory
              ? `${formatBytes(row.usedMemory)} / ${formatBytes(row.totalMemory)}`
              : t("noData")
          }
          testId="node-status-memory"
        />
      </TableCell>
      <TableCell>
        <ProgressBar
          ratio={diskRatio}
          label={
            row.totalDiskSpace && row.usedDiskSpace
              ? `${formatBytes(row.usedDiskSpace)} / ${formatBytes(row.totalDiskSpace)}`
              : t("noData")
          }
          testId="node-status-disk"
        />
      </TableCell>
      <TableCell className="text-center">
        <ManagerBadge manager={row.manager} />
      </TableCell>
      <ServiceCells
        row={row}
        canReadServices={canReadServices}
        initialNodeStatus={initialNodeStatus}
        initialCapturedAt={initialCapturedAt}
      />
      <TableCell>
        {canControl && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={t("rowMenuLabel")}
                data-testid="node-status-row-menu"
                onClick={stopRowNav}
              >
                <MoreVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" onClick={stopRowNav}>
              <DropdownMenuItem
                onClick={(event) => {
                  event.stopPropagation();
                  onRestart();
                }}
                data-testid="node-status-restart"
              >
                <RotateCw className="mr-2 h-4 w-4" />
                {t("restart")}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={(event) => {
                  event.stopPropagation();
                  onShutdown();
                }}
                className="text-destructive focus:text-destructive"
                data-testid="node-status-shutdown"
              >
                <Power className="mr-2 h-4 w-4" />
                {t("shutdown")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </TableCell>
    </TableRow>
  );
}

function ratioOf(used: string | null, total: string | null): number | null {
  if (used === null || total === null) return null;
  const u = Number(used);
  const tot = Number(total);
  if (!Number.isFinite(u) || !Number.isFinite(tot) || tot <= 0) return null;
  return u / tot;
}

function formatBytes(raw: string): string {
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw;
  if (n >= 1024 ** 4) return `${(n / 1024 ** 4).toFixed(1)} TB`;
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function ProgressBar({
  ratio,
  label,
  testId,
}: {
  ratio: number | null;
  label: string;
  testId: string;
}) {
  const pct = ratio !== null ? Math.min(100, Math.max(0, ratio * 100)) : null;
  const severity =
    pct === null
      ? "none"
      : pct >= 95
        ? "critical"
        : pct >= 80
          ? "warning"
          : "ok";
  return (
    <div
      className="flex flex-col gap-1"
      data-testid={testId}
      data-severity={severity}
    >
      <div className="bg-muted relative h-2 w-full overflow-hidden rounded">
        {pct !== null && (
          <div
            className={cn(
              "h-full rounded",
              severity === "critical" && "bg-destructive",
              severity === "warning" && "bg-amber-500",
              severity === "ok" && "bg-emerald-600",
            )}
            style={{ width: `${pct}%` }}
            role="progressbar"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
          />
        )}
      </div>
      <span className="text-muted-foreground text-xs">{label}</span>
    </div>
  );
}

function ManagerBadge({ manager }: { manager: boolean | null }) {
  const t = useTranslations("nodes.list");
  if (manager === null) {
    return (
      <Badge
        variant="outline"
        className="border-muted-foreground/30 text-muted-foreground text-xs"
      >
        —
      </Badge>
    );
  }
  if (manager) {
    return (
      <Badge
        variant="outline"
        className="border-emerald-500 bg-emerald-500/10 text-emerald-700 text-xs"
        data-testid="node-status-manager-running"
      >
        {t("managerRunning")}
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className="border-muted-foreground text-muted-foreground text-xs"
      data-testid="node-status-manager-not-running"
    >
      {t("managerNotRunning")}
    </Badge>
  );
}

interface ServiceCellsProps {
  row: NodeStatusRowSnapshot;
  canReadServices: boolean;
  initialNodeStatus: NodeStatus | null;
  initialCapturedAt: Date | null;
}

/**
 * Render the six per-service cells for one row. Each cell pulls its
 * status from `useServiceStatus(row.id)`, which composes the polling
 * buffer (agents) with the global external probes (Giganto / Tivan).
 *
 * `initialNodeStatus` / `initialCapturedAt` thread the matching SSR
 * `nodeStatusList` edge into the hook so the truthful per-service
 * state lands in the server-rendered HTML itself, instead of waiting
 * for hydration to run the seed effect that copies the SSR payload
 * into the polling buffer. Without this, a cold load of `/nodes`
 * server-renders every configured service column as the `absent`
 * em-dash placeholder and only flips to the real badge after
 * hydration — same first-paint truthfulness gap the detail page
 * already addresses.
 *
 * Defence-in-depth: the hook throws `NodePermissionError` when
 * `canReadServices` is false; the page-level gate already enforces
 * `services:read`, so in production this branch never trips.
 */
function ServiceCells({
  row,
  canReadServices,
  initialNodeStatus,
  initialCapturedAt,
}: ServiceCellsProps) {
  const t = useTranslations("nodes.status");
  const result = useServiceStatus(row.id, {
    canRead: canReadServices,
    enabled: false,
    initialNodeStatus,
    initialCapturedAt,
  });

  return (
    <>
      {SERVICE_COLUMN_ORDER.map((column) => {
        const entry = result.entries[column];
        // `absent` covers two cases: the polling buffer has no live
        // snapshot for this node yet (pre-first-poll), or the node's
        // live snapshot does not configure this service at all. Both
        // render as the em-dash placeholder — the cell only carries a
        // real on / off / idle badge when the node actually exposes a
        // matching agent or external service.
        if (entry.reason.kind === "absent") {
          return (
            <TableCell key={column} className="text-center">
              <span
                className="text-muted-foreground text-xs"
                data-testid={`node-status-service-${column}`}
                title={t("servicePlaceholder")}
              >
                —
              </span>
            </TableCell>
          );
        }
        return (
          <TableCell key={column} className="text-center">
            <ServiceStatusBadge
              status={entry.status}
              reason={entry.reason}
              testId={`node-status-service-${column}`}
            />
          </TableCell>
        );
      })}
    </>
  );
}

export type { NodeStatusRowSnapshot };
