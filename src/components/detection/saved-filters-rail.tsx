"use client";

import { Bookmark, MoreVertical } from "lucide-react";
import { useState } from "react";

import { SaveFilterDialog } from "@/components/detection/save-filter-dialog";
import type {
  SavedFilterErrorCode,
  UseSavedFiltersResult,
} from "@/components/detection/use-saved-filters";
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
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { SavedFilter } from "@/lib/detection/saved-filters";

import type { SaveFilterDialogLabels } from "./save-filter-dialog";

export interface SavedFiltersRailLabels {
  /** Section heading. */
  title: string;
  /** Sub-line shown below the heading when the list is empty. */
  emptyHint: string;
  /** Shown while the initial fetch is in flight. */
  loadingHint: string;
  /** Shown when the initial fetch fails. */
  loadErrorHint: string;
  /** A11y label for the per-row context menu trigger. */
  menuLabel: (name: string) => string;
  /** Activation label (default click action). */
  loadInNewTab: string;
  /** Secondary load action. */
  loadInCurrentTab: string;
  /** Rename action. */
  rename: string;
  /** Delete action. */
  delete: string;
  /** Confirm dialog labels. */
  deleteConfirm: {
    title: string;
    descriptionTemplate: string;
    cancel: string;
    confirm: string;
    error: string;
  };
  /** Dialog labels for the rename flow (re-uses the save dialog UI). */
  renameDialog: SaveFilterDialogLabels;
}

export interface SavedFiltersRailProps {
  state: UseSavedFiltersResult;
  labels: SavedFiltersRailLabels;
  onLoadInCurrentTab: (filter: SavedFilter) => void;
  onLoadInNewTab: (filter: SavedFilter) => void;
}

export function SavedFiltersRail({
  state,
  labels,
  onLoadInCurrentTab,
  onLoadInNewTab,
}: SavedFiltersRailProps) {
  const [renameTarget, setRenameTarget] = useState<SavedFilter | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SavedFilter | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deletePending, setDeletePending] = useState(false);

  async function handleConfirmDelete() {
    if (!deleteTarget) return;
    setDeletePending(true);
    setDeleteError(null);
    const result = await state.remove(deleteTarget.id);
    setDeletePending(false);
    if (result.ok) {
      setDeleteTarget(null);
      return;
    }
    setDeleteError(labels.deleteConfirm.error);
  }

  return (
    <section
      aria-label={labels.title}
      className="flex flex-col gap-2"
      data-slot="saved-filters-rail"
    >
      <div className="text-muted-foreground flex items-center justify-center desktop:justify-start desktop:gap-2">
        <span aria-hidden="true">
          <Bookmark className="size-4" />
        </span>
        <span className="sr-only text-xs font-medium uppercase tracking-wider desktop:not-sr-only desktop:inline">
          {labels.title}
        </span>
      </div>

      {renderBody()}

      {renameTarget ? (
        <SaveFilterDialog
          open={renameTarget !== null}
          onOpenChange={(open) => {
            if (!open) setRenameTarget(null);
          }}
          defaultName={renameTarget.name}
          labels={labels.renameDialog}
          onSubmit={(name) => handleRenameSubmit(renameTarget, name)}
        />
      ) : null}

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteTarget(null);
            setDeleteError(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{labels.deleteConfirm.title}</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget
                ? labels.deleteConfirm.descriptionTemplate.replace(
                    "{name}",
                    deleteTarget.name,
                  )
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError ? (
            <p role="alert" className="text-destructive text-xs">
              {deleteError}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletePending}>
              {labels.deleteConfirm.cancel}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                void handleConfirmDelete();
              }}
              disabled={deletePending}
            >
              {labels.deleteConfirm.confirm}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );

  function renderBody() {
    if (state.loading) {
      return (
        <p className="text-muted-foreground sr-only text-xs desktop:not-sr-only desktop:block">
          {labels.loadingHint}
        </p>
      );
    }
    if (state.loadError) {
      return (
        <p
          role="alert"
          className="text-destructive sr-only text-xs desktop:not-sr-only desktop:block"
        >
          {labels.loadErrorHint}
        </p>
      );
    }
    if (state.filters.length === 0) {
      return (
        <p className="text-muted-foreground sr-only text-xs desktop:not-sr-only desktop:block">
          {labels.emptyHint}
        </p>
      );
    }
    return (
      <ul className="flex flex-col gap-1">
        {state.filters.map((filter) => (
          <li key={filter.id} className="flex items-center gap-1">
            <button
              type="button"
              className="text-foreground hover:bg-muted focus-visible:ring-ring flex-1 truncate rounded-md px-2 py-1.5 text-left text-xs focus-visible:ring-2 focus-visible:outline-none sr-only desktop:not-sr-only desktop:inline-block"
              onClick={() => onLoadInNewTab(filter)}
              title={filter.name}
            >
              {filter.name}
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={labels.menuLabel(filter.name)}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <MoreVertical className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => onLoadInNewTab(filter)}>
                  {labels.loadInNewTab}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onLoadInCurrentTab(filter)}>
                  {labels.loadInCurrentTab}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => setRenameTarget(filter)}>
                  {labels.rename}
                </DropdownMenuItem>
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => setDeleteTarget(filter)}
                >
                  {labels.delete}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </li>
        ))}
      </ul>
    );
  }

  async function handleRenameSubmit(
    target: SavedFilter,
    name: string,
  ): Promise<{ ok: true } | { ok: false; code: SavedFilterErrorCode }> {
    const result = await state.rename(target.id, name);
    if (result.ok) {
      setRenameTarget(null);
      return { ok: true };
    }
    return { ok: false, code: result.code };
  }
}
