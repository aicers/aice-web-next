"use client";

import {
  Check,
  ChevronsUpDown,
  CirclePlus,
  CircleSlash,
  Clock,
  MoreVertical,
  Pencil,
  Trash2,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";

import { ManagerUnavailablePanel } from "@/components/node/manager-unavailable-panel";
import { NodeEditDialog } from "@/components/node/node-edit-dialog";
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
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useNodeStatusPolling } from "@/hooks/use-node-status-polling";
import { Link, useRouter } from "@/i18n/navigation";
import type { SensorNodeOption } from "@/lib/node/sensor-list";
import type { Node as ManagerNode } from "@/lib/node/types";
import { cn } from "@/lib/utils";

import {
  type NodeRow,
  SERVICE_COLUMN_ORDER,
  type ServiceCell,
} from "./node-list-types";

interface CustomerOption {
  id: string;
  name: string;
}

interface NodeListTableProps {
  initialRows: NodeRow[];
  customers: CustomerOption[];
  canCreate: boolean;
  canEdit: boolean;
  canDelete: boolean;
  showTenantFilter: boolean;
  /**
   * Canonical node payload to seed the edit dialog with on mount. The
   * settings page resolves this server-side from the `?dialog=edit&id=…`
   * URL so the dialog opens pre-populated without a second round-trip;
   * a stale or out-of-scope id arrives here as `null` and the table
   * just renders normally.
   */
  initialEditNode?: ManagerNode | null;
  /**
   * Registry kind (e.g. `data-store`, `semi-supervised`) the edit
   * dialog should expand and focus on mount. Wired from the settings
   * page when the URL carries `?service=<kind>` so the detail-page
   * "Edit this service" link lands directly on the matching
   * accordion. `null` keeps the dialog's default collapsed layout.
   */
  initialFocusService?: string | null;
  /**
   * Sensor-bearing nodes the dialog forwards to the Hog
   * (Semi-supervised Engine) form so it can render its
   * `active_sensors` checklist. Empty when no node carries a sensor
   * agent — the form renders its empty-state copy in that case.
   */
  sensorOptions?: readonly SensorNodeOption[];
  /**
   * Applied external-service configs (Giganto / Tivan) projected to
   * TOML, keyed by registry kind, for the edit dialog to seed
   * external sections that have `draft: null` on the node. Resolved
   * server-side by the Settings page; only relevant in edit mode.
   */
  appliedExternalDrafts?: Readonly<Record<string, string>>;
}

type SortKey = "newest" | "name" | "hostname";

type StatusFacet = "pending" | "alive" | "dead";

export function NodeListTable({
  initialRows,
  customers,
  canCreate,
  canEdit,
  canDelete,
  showTenantFilter,
  initialEditNode = null,
  initialFocusService = null,
  sensorOptions,
  appliedExternalDrafts,
}: NodeListTableProps) {
  const t = useTranslations("nodes.list");
  const router = useRouter();

  const [rows, setRows] = useState<NodeRow[]>(initialRows);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortKey>("newest");
  const [tenantFilter, setTenantFilter] = useState<string>("");
  const [statusFacets, setStatusFacets] = useState<Set<StatusFacet>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [singleDelete, setSingleDelete] = useState<NodeRow | null>(null);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Inline create + edit. The settings page resolves the edit target
  // server-side from `?dialog=edit&id=…` so the canonical node arrives
  // as `initialEditNode`; the dialog opens automatically when that
  // resolves to a node.
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editNode, setEditNode] = useState<ManagerNode | null>(initialEditNode);

  // When the URL changes to a different edit target, swap to the new
  // canonical payload. Resetting to `null` (Cancel / Save → URL cleaned
  // up) falls through to the dialog's own close path below.
  useEffect(() => {
    setEditNode(initialEditNode);
  }, [initialEditNode]);

  // Live polling samples: the segment-scoped driver in
  // `nodes/(gate)/layout.tsx` keeps the per-node buffer fresh; this
  // component is a read-only consumer so it does not double-drive the
  // loop. Once any sample has landed (`capturedAt !== null`) the
  // polling snapshot is authoritative — rows that the manager no
  // longer reports project to "no current status" (`hasStatus: false`,
  // `ping: null`, `manager: null`) instead of reusing the SSR-seeded
  // values. Without this an initially-alive node would stay in the
  // Alive facet forever even after the manager pruned it from the
  // status list, which violates the Phase Node-6 contract that the
  // facets switch from the seeded snapshot to live polling data.
  const polling = useNodeStatusPolling({ enabled: false });
  const liveRows = useMemo<NodeRow[]>(() => {
    if (polling.capturedAt === null) return rows;
    return rows.map((row) => {
      const live = polling.byNodeId.get(row.id)?.latest;
      if (!live) {
        return {
          ...row,
          manager: null,
          ping: null,
          hasStatus: false,
        };
      }
      return {
        ...row,
        manager: live.manager,
        ping: live.ping,
        hasStatus: true,
      };
    });
  }, [rows, polling.capturedAt, polling.byNodeId]);

  const customerNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const customer of customers) map.set(customer.id, customer.name);
    return map;
  }, [customers]);

  // The alive/dead chips track whether either the initial
  // `nodeStatusList` snapshot or a live polling sample arrived for any
  // row, NOT whether any row currently has a ping value. An all-dead
  // snapshot is still data — leaving the chips disabled in that case
  // would hide the dead facet from the user.
  const hasStatusSnapshot = useMemo(
    () => liveRows.some((row) => row.hasStatus),
    [liveRows],
  );

  const filteredRows = useMemo(() => {
    let next = [...liveRows];

    const term = search.trim().toLowerCase();
    if (term) {
      next = next.filter((row) => {
        const haystack = [
          row.appliedName,
          row.draftName ?? "",
          row.appliedHostname,
          row.draftHostname ?? "",
          row.appliedCustomerId
            ? (customerNameById.get(row.appliedCustomerId) ?? "")
            : "",
          row.draftCustomerId
            ? (customerNameById.get(row.draftCustomerId) ?? "")
            : "",
        ]
          .join(" ")
          .toLowerCase();
        return haystack.includes(term);
      });
    }

    if (tenantFilter) {
      next = next.filter(
        (row) =>
          row.appliedCustomerId === tenantFilter ||
          row.draftCustomerId === tenantFilter,
      );
    }

    if (statusFacets.size > 0) {
      next = next.filter((row) => {
        if (statusFacets.has("pending") && row.hasPending) return true;
        if (statusFacets.has("alive") && row.ping !== null) return true;
        // "dead" requires status data for the row (so an absent
        // `nodeStatusList` row reads as "unknown" rather than dead).
        // Falling back to `hasAnyPing` would have hidden every node
        // when the entire snapshot returned `ping: null`.
        if (statusFacets.has("dead") && row.hasStatus && row.ping === null) {
          return true;
        }
        return false;
      });
    }

    switch (sort) {
      case "name":
        next.sort((a, b) => a.appliedName.localeCompare(b.appliedName));
        break;
      case "hostname":
        next.sort((a, b) =>
          (a.appliedHostname ?? "").localeCompare(b.appliedHostname ?? ""),
        );
        break;
      default:
        next.sort((a, b) => b.id.localeCompare(a.id));
    }

    return next;
  }, [liveRows, search, tenantFilter, statusFacets, customerNameById, sort]);

  const pendingCount = useMemo(
    () => liveRows.filter((row) => row.hasPending).length,
    [liveRows],
  );

  const allSelected =
    filteredRows.length > 0 &&
    filteredRows.every((row) => selected.has(row.id));

  const toggleAll = useCallback(() => {
    setSelected((prev) => {
      if (filteredRows.every((row) => prev.has(row.id))) {
        const next = new Set(prev);
        for (const row of filteredRows) next.delete(row.id);
        return next;
      }
      const next = new Set(prev);
      for (const row of filteredRows) next.add(row.id);
      return next;
    });
  }, [filteredRows]);

  const toggleOne = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const togglePendingFilter = useCallback(() => {
    setStatusFacets((prev) => {
      const next = new Set(prev);
      if (next.has("pending")) next.delete("pending");
      else next.add("pending");
      return next;
    });
  }, []);

  const toggleStatusFacet = useCallback((facet: StatusFacet) => {
    setStatusFacets((prev) => {
      const next = new Set(prev);
      if (next.has(facet)) next.delete(facet);
      else next.add(facet);
      return next;
    });
  }, []);

  const performDelete = useCallback(
    async (ids: string[]): Promise<string[]> => {
      const csrfToken = readCsrfToken();
      const headers: Record<string, string> = {};
      if (csrfToken) headers["X-CSRF-Token"] = csrfToken;
      const succeeded: string[] = [];
      for (const id of ids) {
        const res = await fetch(`/api/nodes/${encodeURIComponent(id)}`, {
          method: "DELETE",
          headers,
        });
        if (res.ok) {
          succeeded.push(id);
        }
      }
      return succeeded;
    },
    [],
  );

  const handleConfirmSingleDelete = useCallback(async () => {
    if (!singleDelete) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const succeeded = await performDelete([singleDelete.id]);
      if (succeeded.length === 0) {
        setDeleteError(t("deleteError"));
        return;
      }
      setRows((prev) => prev.filter((row) => row.id !== singleDelete.id));
      setSelected((prev) => {
        const next = new Set(prev);
        next.delete(singleDelete.id);
        return next;
      });
      setSingleDelete(null);
    } finally {
      setDeleting(false);
    }
  }, [performDelete, singleDelete, t]);

  const handleConfirmBulkDelete = useCallback(async () => {
    setDeleting(true);
    setDeleteError(null);
    try {
      const ids = Array.from(selected);
      const succeeded = await performDelete(ids);
      if (succeeded.length === 0) {
        setDeleteError(t("deleteError"));
        return;
      }
      const successSet = new Set(succeeded);
      setRows((prev) => prev.filter((row) => !successSet.has(row.id)));
      setSelected((prev) => {
        const next = new Set(prev);
        for (const id of succeeded) next.delete(id);
        return next;
      });
      if (succeeded.length < ids.length) {
        setDeleteError(t("deleteError"));
      } else {
        setBulkDeleteOpen(false);
      }
    } finally {
      setDeleting(false);
    }
  }, [performDelete, selected, t]);

  const onAddClick = useCallback(() => {
    setCreateDialogOpen(true);
  }, []);

  const existingNames = useMemo(() => {
    const out: string[] = [];
    for (const row of rows) {
      if (row.draftName) out.push(row.draftName);
      out.push(row.appliedName);
    }
    return out;
  }, [rows]);

  const existingHostnames = useMemo(() => {
    const out: string[] = [];
    for (const row of rows) {
      if (row.draftHostname) out.push(row.draftHostname);
      if (row.appliedHostname) out.push(row.appliedHostname);
    }
    return out;
  }, [rows]);

  // Mid-session manager outage: the SSR path renders the offline panel
  // when the initial `nodeStatusList` walk fails, but a manager that
  // drops AFTER hydration only flips the polling store's
  // `isManagerUnreachable` flag. Swap to the same fallback panel here
  // so the Settings list does not freeze on a stale snapshot. The check
  // sits below all hook calls so the early return does not violate the
  // Rules of Hooks. The next successful poll clears the flag and the
  // panel disappears without a reload.
  if (polling.isManagerUnreachable) {
    return <ManagerUnavailablePanel />;
  }

  return (
    <TooltipProvider>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("search")}
            className="w-72"
            data-testid="nodes-search"
          />
          <Select value={sort} onValueChange={(v) => setSort(v as SortKey)}>
            <SelectTrigger className="w-44" aria-label={t("sortLabel")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="newest">{t("sortNewest")}</SelectItem>
              <SelectItem value="name">{t("sortName")}</SelectItem>
              <SelectItem value="hostname">{t("sortHostname")}</SelectItem>
            </SelectContent>
          </Select>
          {showTenantFilter && (
            <Select
              value={tenantFilter || "all"}
              onValueChange={(v) => setTenantFilter(v === "all" ? "" : v)}
            >
              <SelectTrigger
                className="w-48"
                aria-label={t("tenantFilterLabel")}
              >
                <SelectValue placeholder={t("allCustomers")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("allCustomers")}</SelectItem>
                {customers.map((customer) => (
                  <SelectItem key={customer.id} value={customer.id}>
                    {customer.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <fieldset
            className="flex flex-wrap items-center gap-2 border-0 p-0 m-0"
            aria-label={t("statusFiltersLabel")}
          >
            <StatusChip
              label={t("pendingFilterChip")}
              active={statusFacets.has("pending")}
              onClick={() => toggleStatusFacet("pending")}
            />
            <StatusChipDisabledIfNoStatus
              label={t("aliveFilterChip")}
              tooltip={t("statusFilterAliveDisabled")}
              active={statusFacets.has("alive")}
              hasStatus={hasStatusSnapshot}
              onClick={() => toggleStatusFacet("alive")}
            />
            <StatusChipDisabledIfNoStatus
              label={t("deadFilterChip")}
              tooltip={t("statusFilterDeadDisabled")}
              active={statusFacets.has("dead")}
              hasStatus={hasStatusSnapshot}
              onClick={() => toggleStatusFacet("dead")}
            />
          </fieldset>
          <div className="ml-auto flex items-center gap-2">
            {canCreate && (
              <Button
                onClick={onAddClick}
                className="rounded-full"
                data-testid="nodes-add-button"
              >
                <CirclePlus className="mr-2 h-4 w-4" />
                {t("addNode")}
              </Button>
            )}
          </div>
        </div>

        <button
          type="button"
          onClick={togglePendingFilter}
          className={cn(
            "inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium transition-colors",
            statusFacets.has("pending")
              ? "border-primary bg-primary/10 text-primary"
              : "border-border text-muted-foreground hover:text-foreground",
          )}
          data-testid="nodes-pending-summary"
        >
          <Clock className="h-3.5 w-3.5" />
          {t("pendingSummary", { count: pendingCount })}
        </button>

        <div className="overflow-hidden rounded-lg bg-card">
          <Table data-testid="nodes-table">
            <TableHeader>
              <TableRow>
                {canDelete && (
                  <TableHead className="w-[44px] pl-4">
                    <Checkbox
                      checked={allSelected}
                      onCheckedChange={toggleAll}
                      aria-label={t("selectAll")}
                      data-testid="nodes-select-all"
                    />
                  </TableHead>
                )}
                <SortableHeader label={t("columns.name")} />
                <TableHead>{t("columns.customer")}</TableHead>
                <TableHead>{t("columns.description")}</TableHead>
                <SortableHeader label={t("columns.hostname")} />
                <TableHead className="text-center">
                  {t("columns.sensor")}
                </TableHead>
                <TableHead className="text-center">
                  {t("columns.dataStore")}
                </TableHead>
                <TableHead className="text-center">
                  {t("columns.tiContainer")}
                </TableHead>
                <TableHead className="text-center">
                  {t("columns.unsupervised")}
                </TableHead>
                <TableHead className="text-center">
                  {t("columns.semiSupervised")}
                </TableHead>
                <TableHead className="text-center">
                  {t("columns.timeSeries")}
                </TableHead>
                <TableHead className="text-center">
                  {t("columns.manager")}
                </TableHead>
                <TableHead className="w-[44px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredRows.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={canDelete ? 13 : 12}
                    className="text-muted-foreground py-8 text-center text-sm"
                  >
                    {rows.length === 0 ? t("empty") : t("noResults")}
                  </TableCell>
                </TableRow>
              )}
              {filteredRows.map((row) => (
                <NodeListRow
                  key={row.id}
                  row={row}
                  customerName={
                    row.appliedCustomerId
                      ? (customerNameById.get(row.appliedCustomerId) ??
                        row.appliedCustomerId)
                      : ""
                  }
                  draftCustomerName={
                    row.draftCustomerId
                      ? (customerNameById.get(row.draftCustomerId) ??
                        row.draftCustomerId)
                      : null
                  }
                  selected={selected.has(row.id)}
                  onSelect={canDelete ? () => toggleOne(row.id) : null}
                  onEdit={
                    canEdit
                      ? () =>
                          router.push(
                            `/nodes/settings?dialog=edit&id=${row.id}`,
                          )
                      : null
                  }
                  onDelete={canDelete ? () => setSingleDelete(row) : null}
                />
              ))}
            </TableBody>
          </Table>
        </div>

        {selected.size > 0 && canDelete && (
          <section
            className="bg-card fixed top-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-lg border px-4 py-3 shadow-lg"
            data-testid="nodes-bulk-bar"
            aria-label="Bulk actions"
          >
            <span className="text-sm font-medium">
              {t("selectedSummary", { count: selected.size })}
            </span>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setBulkDeleteOpen(true)}
              data-testid="nodes-bulk-delete"
            >
              <Trash2 className="mr-2 h-4 w-4" />
              {t("bulkDelete")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSelected(new Set())}
            >
              {t("deleteCancel")}
            </Button>
          </section>
        )}

        {canCreate && (
          <NodeEditDialog
            open={createDialogOpen}
            onOpenChange={setCreateDialogOpen}
            mode="create"
            customers={customers}
            existingNames={existingNames}
            existingHostnames={existingHostnames}
            sensorOptions={sensorOptions}
            onSuccess={() => router.refresh()}
          />
        )}

        {canEdit && editNode && (
          <NodeEditDialog
            // Re-keying on the node id AND the focus-service param
            // forces a fresh dialog instance both when the user
            // navigates between two different edit targets and when
            // they land on the same node from a different service
            // link (so the new accordion auto-expands on mount).
            // RHF's `defaultValues` only seeds on first mount, and
            // the focus effect only runs on mount — without the
            // service in the key, navigating from one service link
            // to another on the same node would leave the previous
            // accordion expanded and not focus the new one.
            key={`${editNode.id}:${initialFocusService ?? ""}`}
            open={true}
            onOpenChange={(open) => {
              if (!open) {
                setEditNode(null);
                router.replace("/nodes/settings");
              }
            }}
            mode="edit"
            node={editNode}
            customers={customers}
            existingNames={existingNames}
            existingHostnames={existingHostnames}
            sensorOptions={sensorOptions}
            appliedExternalDrafts={appliedExternalDrafts}
            initialFocusService={initialFocusService}
            onSuccess={() => {
              setEditNode(null);
              router.replace("/nodes/settings");
              router.refresh();
            }}
          />
        )}

        <AlertDialog
          open={singleDelete !== null}
          onOpenChange={(open) => {
            if (!open) {
              setSingleDelete(null);
              setDeleteError(null);
            }
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("deleteConfirmTitle")}</AlertDialogTitle>
              <AlertDialogDescription>
                {t("deleteConfirmDescription", {
                  hostname:
                    singleDelete?.appliedHostname ||
                    singleDelete?.appliedName ||
                    "",
                })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            {deleteError && (
              <p className="text-destructive text-sm">{deleteError}</p>
            )}
            <AlertDialogFooter>
              <AlertDialogCancel>{t("deleteCancel")}</AlertDialogCancel>
              <AlertDialogAction
                onClick={(e) => {
                  e.preventDefault();
                  handleConfirmSingleDelete();
                }}
                disabled={deleting}
              >
                {t("deleteConfirm")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <AlertDialog
          open={bulkDeleteOpen}
          onOpenChange={(open) => {
            if (!open) {
              setBulkDeleteOpen(false);
              setDeleteError(null);
            }
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t("deleteBulkConfirmTitle", { count: selected.size })}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {t("deleteBulkConfirmDescription")}
              </AlertDialogDescription>
            </AlertDialogHeader>
            {deleteError && (
              <p className="text-destructive text-sm">{deleteError}</p>
            )}
            <AlertDialogFooter>
              <AlertDialogCancel>{t("deleteCancel")}</AlertDialogCancel>
              <AlertDialogAction
                onClick={(e) => {
                  e.preventDefault();
                  handleConfirmBulkDelete();
                }}
                disabled={deleting}
              >
                {t("deleteConfirm")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </TooltipProvider>
  );
}

function SortableHeader({ label }: { label: string }) {
  return (
    <TableHead>
      <span className="inline-flex items-center gap-1">
        {label}
        <ChevronsUpDown className="h-3.5 w-3.5" />
      </span>
    </TableHead>
  );
}

interface NodeListRowProps {
  row: NodeRow;
  customerName: string;
  draftCustomerName: string | null;
  selected: boolean;
  // `null` when the caller lacks `nodes:delete`. The checkbox cell is
  // omitted entirely in that case so a read-only viewer never sees the
  // first step of the bulk-delete affordance.
  onSelect: (() => void) | null;
  onEdit: (() => void) | null;
  onDelete: (() => void) | null;
}

function NodeListRow({
  row,
  customerName,
  draftCustomerName,
  selected,
  onSelect,
  onEdit,
  onDelete,
}: NodeListRowProps) {
  const t = useTranslations("nodes.list");
  const router = useRouter();

  // Issue #309 calls out "clicking the row navigates to /nodes/[id]".
  // The Name cell's <Link> still owns href / keyboard navigation; this
  // mouse-only handler extends the click target to the rest of the row.
  // Interactive descendants (checkbox, kebab trigger / menu items, the
  // existing link) call `stopPropagation` so the row navigation does
  // not pre-empt them.
  const onRowClick = useCallback(() => {
    router.push(`/nodes/${row.id}`);
  }, [router, row.id]);

  const stopRowNav = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
  }, []);

  // Radix's `DropdownMenuContent` portals its items to the document
  // root, so they are no longer DOM descendants of the row — but React
  // synthetic events still bubble through the React owner tree and
  // would reach `onRowClick` after the menu item runs. Wrap each item
  // handler so the row-level navigation cannot pre-empt the per-row
  // Edit / Delete intent (e.g. delete modal disappearing because the
  // route swapped underneath).
  const wrapMenuHandler = useCallback(
    (handler: (() => void) | null) =>
      handler
        ? (event: React.MouseEvent) => {
            event.stopPropagation();
            handler();
          }
        : undefined,
    [],
  );
  const onEditMenu = wrapMenuHandler(onEdit);
  const onDeleteMenu = wrapMenuHandler(onDelete);

  return (
    <TableRow
      className={cn(
        "relative cursor-pointer",
        row.hasPending && "border-l-2 border-amber-500",
      )}
      data-testid="nodes-row"
      data-row-id={row.id}
      data-pending={row.hasPending ? "true" : "false"}
      onClick={onRowClick}
    >
      {onSelect && (
        <TableCell className="pl-4">
          <Checkbox
            checked={selected}
            onCheckedChange={onSelect}
            onClick={stopRowNav}
            aria-label={t("selectRow")}
            data-testid="nodes-row-checkbox"
          />
        </TableCell>
      )}
      <TableCell className="font-medium">
        <div className="flex items-center gap-2">
          <RowLink id={row.id} onClick={stopRowNav}>
            <ValueWithDraft applied={row.appliedName} draft={row.draftName} />
          </RowLink>
          {row.hasPending && <RowPendingBadge />}
        </div>
      </TableCell>
      <TableCell>
        <ValueWithDraft applied={customerName} draft={draftCustomerName} />
      </TableCell>
      <TableCell className="text-muted-foreground max-w-xs truncate">
        <ValueWithDraft
          applied={row.appliedDescription}
          draft={row.draftDescription}
        />
      </TableCell>
      <TableCell>
        <ValueWithDraft
          applied={row.appliedHostname || t("noHostname")}
          draft={row.draftHostname}
        />
      </TableCell>
      {SERVICE_COLUMN_ORDER.map((column) => (
        <TableCell key={column} className="text-center">
          <ServiceCellRenderer cell={row.serviceCells[column]} />
        </TableCell>
      ))}
      <TableCell className="text-center">
        <ManagerStatusBadge manager={row.manager} />
      </TableCell>
      <TableCell>
        {(onEdit || onDelete) && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={t("rowMenuLabel")}
                data-testid="nodes-row-menu"
                onClick={stopRowNav}
              >
                <MoreVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" onClick={stopRowNav}>
              {onEditMenu && (
                <DropdownMenuItem onClick={onEditMenu}>
                  <Pencil className="mr-2 h-4 w-4" />
                  {t("edit")}
                </DropdownMenuItem>
              )}
              {onDeleteMenu && (
                <DropdownMenuItem
                  onClick={onDeleteMenu}
                  className="text-destructive focus:text-destructive"
                  data-testid="nodes-row-delete"
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  {t("delete")}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </TableCell>
    </TableRow>
  );
}

function RowLink({
  id,
  children,
  onClick,
}: {
  id: string;
  children: React.ReactNode;
  onClick?: (event: React.MouseEvent) => void;
}) {
  return (
    <Link
      href={`/nodes/${id}`}
      className="hover:text-primary outline-none focus-visible:underline"
      data-testid="nodes-row-link"
      onClick={onClick}
    >
      {children}
    </Link>
  );
}

function ValueWithDraft({
  applied,
  draft,
}: {
  applied: string;
  draft: string | null;
}) {
  const t = useTranslations("nodes.list");

  if (draft === null || draft === applied) {
    return <span>{applied}</span>;
  }

  return (
    <div className="flex flex-col leading-tight">
      <span
        className="text-muted-foreground line-through"
        title={t("appliedLabel")}
      >
        {applied}
      </span>
      <span className="text-foreground">{draft}</span>
    </div>
  );
}

function RowPendingBadge() {
  const t = useTranslations("nodes.list");
  return (
    <Badge
      variant="outline"
      className="border-amber-500 px-1.5 py-0 text-[10px] uppercase tracking-wide text-amber-700"
      data-testid="nodes-row-pending-badge"
    >
      {t("pendingBadge")}
    </Badge>
  );
}

function ServiceCellRenderer({ cell }: { cell: ServiceCell }) {
  const t = useTranslations("nodes.list");

  if (cell.state === "absent") {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="text-muted-foreground inline-flex items-center justify-center">
            <CircleSlash className="h-4 w-4" aria-hidden="true" />
            <span className="sr-only">{t("notConfigured")}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent>{t("notConfigured")}</TooltipContent>
      </Tooltip>
    );
  }

  if (cell.state === "manual") {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="text-muted-foreground inline-flex items-center gap-1 text-xs uppercase tracking-wide">
            {t("manualLabel")}
          </span>
        </TooltipTrigger>
        <TooltipContent>{t("configuredManually")}</TooltipContent>
      </Tooltip>
    );
  }

  const isPending = cell.state === "configured-here-pending";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex items-center justify-center gap-1">
          <Check className="h-4 w-4 text-emerald-600" aria-hidden="true" />
          <span className="sr-only">{t("configuredHere")}</span>
          {isPending && (
            <span
              className="h-2 w-2 rounded-full bg-amber-500"
              data-testid="nodes-service-pending-dot"
              role="img"
              aria-label={t("pendingBadge")}
            />
          )}
        </span>
      </TooltipTrigger>
      <TooltipContent>
        {isPending
          ? `${t("configuredHere")} · ${t("pendingBadge")}`
          : t("configuredHere")}
      </TooltipContent>
    </Tooltip>
  );
}

function ManagerStatusBadge({ manager }: { manager: boolean | null }) {
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
        data-testid="nodes-manager-running"
      >
        {t("managerRunning")}
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className="border-muted-foreground text-muted-foreground text-xs"
      data-testid="nodes-manager-not-running"
    >
      {t("managerNotRunning")}
    </Badge>
  );
}

function StatusChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
        active
          ? "border-primary bg-primary/10 text-primary"
          : "border-border text-muted-foreground hover:text-foreground",
      )}
      aria-pressed={active}
    >
      {label}
    </button>
  );
}

function StatusChipDisabledIfNoStatus({
  label,
  tooltip,
  active,
  hasStatus,
  onClick,
}: {
  label: string;
  tooltip: string;
  active: boolean;
  hasStatus: boolean;
  onClick: () => void;
}) {
  if (hasStatus) {
    return <StatusChip label={label} active={active} onClick={onClick} />;
  }

  // Outer wrapper is a `<button type="button">` so hover and focus
  // handlers fire normally (the tooltip surfaces on focus). It carries
  // `aria-disabled="true"` rather than the native `disabled` attribute,
  // because native `disabled` suppresses focus/tooltip events. The
  // inner `<span>` is `pointer-events: none` and `tabIndex={-1}` so
  // clicks are inert and child elements never steal focus.
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-disabled="true"
          aria-pressed={active}
          className={cn(
            "inline-flex cursor-not-allowed select-none items-center rounded-full border px-3 py-1 text-xs font-medium",
            "border-border text-muted-foreground opacity-60",
          )}
          data-testid={`nodes-status-chip-${label.toLowerCase()}`}
        >
          <span tabIndex={-1} className="pointer-events-none">
            {label}
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}
