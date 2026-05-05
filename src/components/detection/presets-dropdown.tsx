"use client";

import { ChevronDown, ExternalLink } from "lucide-react";
import { type MouseEvent as ReactMouseEvent, useState } from "react";

import {
  SaveFilterDialog,
  type SaveFilterDialogLabels,
} from "@/components/detection/save-filter-dialog";
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
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { RecommendedPreset } from "@/lib/detection/recommended-filters";
import type { SavedFilter } from "@/lib/detection/saved-filters";

export interface PresetsDropdownLabels {
  /** Trigger button label, e.g. "Presets". */
  trigger: string;
  /** Section heading shown above the recommended preset list. */
  recommendedHeading: string;
  /** Sub-line shown when the recommended preset list is empty. */
  recommendedEmpty: string;
  /** Per-row localized name resolver for recommended presets. */
  recommendedPresetName: (preset: RecommendedPreset) => string;
  /** Section heading shown above the saved filter list. */
  savedHeading: string;
  /** Shown while the initial saved-filter fetch is in flight. */
  savedLoading: string;
  /** Shown when the initial saved-filter fetch fails. */
  savedLoadError: string;
  /** Shown when the saved-filter list is empty. */
  savedEmpty: string;
  /** A11y label for a saved row's per-row context menu trigger. */
  savedRowMenuLabel: (name: string) => string;
  /**
   * Issue #429: a11y label for the explicit "Open in new tab" icon
   * rendered on every preset row. Rendered as the icon button's
   * `aria-label` so screen readers can read the affordance even though
   * the icon itself is decorative.
   */
  openInNewTab: (name: string) => string;
  loadInNewTab: string;
  loadInCurrentTab: string;
  rename: string;
  delete: string;
  deleteConfirm: {
    title: string;
    /** ICU template carrying `{name}` for the body copy. */
    descriptionTemplate: string;
    cancel: string;
    confirm: string;
    error: string;
  };
  /** Dialog labels for the rename flow (re-uses the save dialog UI). */
  renameDialog: SaveFilterDialogLabels;
  /** Trailing "Save current filter…" action label. */
  saveCurrentFilter: string;
}

export interface PresetsDropdownProps {
  recommendedPresets: readonly RecommendedPreset[];
  /**
   * Personal saved-filters state. When undefined the saved section is
   * omitted and the "Save current filter…" action is hidden — used by
   * the standalone shell paths that do not own a saved-filter cache.
   */
  savedFilters?: UseSavedFiltersResult;
  labels: PresetsDropdownLabels;
  /**
   * Recommended preset activation. Issue #429: routes through the
   * wrapper's create-or-focus decider by default; the dropdown passes
   * `options.forceNewTab: true` from the explicit "Open in new tab"
   * icon and Cmd-Ctrl-click paths so they always create a fresh tab
   * regardless of matching.
   */
  onActivateRecommended: (
    preset: RecommendedPreset,
    options?: { forceNewTab?: boolean },
  ) => void;
  /**
   * Saved-filter activation. Same matching contract as
   * {@link onActivateRecommended}: the default row click routes
   * through create-or-focus; the icon and Cmd-Ctrl-click paths force
   * a new tab.
   */
  onActivateSaved: (
    filter: SavedFilter,
    options?: { forceNewTab?: boolean },
  ) => void;
  /**
   * Secondary saved-filter activation: replace the active tab's
   * filter rather than creating a new one. Routed from the per-row
   * sub-menu and unaffected by the tab cap.
   */
  onLoadSavedInCurrentTab: (filter: SavedFilter) => void;
  /**
   * Save the **currently committed** filter (what URL `?f=` encodes)
   * to the operator's saved list. Distinct from the drawer's
   * "Save this filter" path, which saves the drawer's draft after
   * routing it through {@link buildAppliedFilter}. Undefined when
   * saving is unavailable (no saved-filter cache); the action item
   * is hidden in that case.
   */
  onSaveCurrentFilter?: () => void;
}

/**
 * On-demand "Presets" dropdown rendered next to the Detection
 * Filters button (issue #428). Replaces the always-visible left rail
 * that previously showed Recommended + Saved filters; the dropdown
 * surface keeps the same activation contracts (default click loads
 * in a new tab) and exposes Saved-filter rename / delete via a
 * per-row sub-menu.
 *
 * The "Save current filter…" trailing action persists the committed
 * filter (URL `f`) — *not* the drawer draft — which is what an
 * operator triaging a populated result naturally wants to keep.
 */
export function PresetsDropdown({
  recommendedPresets,
  savedFilters,
  labels,
  onActivateRecommended,
  onActivateSaved,
  onLoadSavedInCurrentTab,
  onSaveCurrentFilter,
}: PresetsDropdownProps) {
  const [renameTarget, setRenameTarget] = useState<SavedFilter | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SavedFilter | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deletePending, setDeletePending] = useState(false);

  async function handleConfirmDelete() {
    if (!savedFilters || !deleteTarget) return;
    setDeletePending(true);
    setDeleteError(null);
    const result = await savedFilters.remove(deleteTarget.id);
    setDeletePending(false);
    if (result.ok) {
      setDeleteTarget(null);
      return;
    }
    setDeleteError(labels.deleteConfirm.error);
  }

  async function handleRenameSubmit(
    target: SavedFilter,
    name: string,
  ): Promise<{ ok: true } | { ok: false; code: SavedFilterErrorCode }> {
    if (!savedFilters) return { ok: false, code: "server-error" };
    const result = await savedFilters.rename(target.id, name);
    if (result.ok) {
      setRenameTarget(null);
      return { ok: true };
    }
    return { ok: false, code: result.code };
  }

  // When the saved-filter fetch failed, retry on the next open of the
  // dropdown. The hook's cache is held by the shell (not by this
  // component), so without this retry hook the operator would be
  // stuck on the inline error placeholder until something else in the
  // page causes a refetch — which contradicts what the manual tells
  // them ("reopen the dropdown to retry").
  function handleOpenChange(open: boolean) {
    if (open && savedFilters?.loadError) {
      void savedFilters.refresh();
    }
  }

  return (
    <>
      <DropdownMenu onOpenChange={handleOpenChange}>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="outline" size="sm">
            {labels.trigger}
            <ChevronDown className="size-4" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="min-w-[16rem] max-w-[20rem]"
          data-slot="presets-dropdown-content"
        >
          <DropdownMenuLabel>{labels.recommendedHeading}</DropdownMenuLabel>
          {recommendedPresets.length === 0 ? (
            <p className="text-muted-foreground px-2 py-1 text-xs">
              {labels.recommendedEmpty}
            </p>
          ) : (
            recommendedPresets.map((preset) => {
              const presetName = labels.recommendedPresetName(preset);
              return (
                <div key={preset.id} className="flex items-center gap-1">
                  <DropdownMenuItem
                    className="min-w-0 flex-1"
                    data-preset-id={preset.id}
                    onClick={(event) => {
                      // Issue #429: Cmd-Ctrl-click on a preset row always
                      // creates a new tab regardless of matching, matching
                      // standard web link conventions.
                      if (isForceNewTabClick(event)) {
                        event.preventDefault();
                        onActivateRecommended(preset, { forceNewTab: true });
                      }
                    }}
                    onSelect={() => onActivateRecommended(preset)}
                  >
                    <span className="truncate">{presetName}</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="shrink-0 px-1 py-1.5"
                    aria-label={labels.openInNewTab(presetName)}
                    data-slot="presets-dropdown-open-new-tab"
                    onSelect={() =>
                      onActivateRecommended(preset, { forceNewTab: true })
                    }
                  >
                    <ExternalLink className="size-3.5" aria-hidden="true" />
                    <span className="sr-only">
                      {labels.openInNewTab(presetName)}
                    </span>
                  </DropdownMenuItem>
                </div>
              );
            })
          )}

          {savedFilters ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>{labels.savedHeading}</DropdownMenuLabel>
              {renderSavedSection(savedFilters)}
            </>
          ) : null}

          {onSaveCurrentFilter ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                data-slot="presets-dropdown-save-current"
                onSelect={onSaveCurrentFilter}
              >
                {labels.saveCurrentFilter}
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

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
    </>
  );

  function renderSavedSection(state: UseSavedFiltersResult) {
    if (state.loading) {
      return (
        <p
          className="text-muted-foreground px-2 py-1 text-xs"
          data-slot="presets-dropdown-saved-loading"
        >
          {labels.savedLoading}
        </p>
      );
    }
    if (state.loadError) {
      return (
        <p
          role="alert"
          className="text-destructive px-2 py-1 text-xs"
          data-slot="presets-dropdown-saved-error"
        >
          {labels.savedLoadError}
        </p>
      );
    }
    if (state.filters.length === 0) {
      return (
        <p
          className="text-muted-foreground px-2 py-1 text-xs"
          data-slot="presets-dropdown-saved-empty"
        >
          {labels.savedEmpty}
        </p>
      );
    }
    return state.filters.map((filter) => (
      <div
        key={filter.id}
        data-saved-filter-id={filter.id}
        className="flex items-center gap-1"
      >
        <DropdownMenuItem
          className="min-w-0 flex-1"
          onClick={(event) => {
            // Issue #429: Cmd-Ctrl-click on a preset row always creates
            // a new tab regardless of matching, matching standard web
            // link conventions.
            if (isForceNewTabClick(event)) {
              event.preventDefault();
              onActivateSaved(filter, { forceNewTab: true });
            }
          }}
          onSelect={() => onActivateSaved(filter)}
        >
          <span className="truncate" title={filter.name}>
            {filter.name}
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem
          className="shrink-0 px-1 py-1.5"
          aria-label={labels.openInNewTab(filter.name)}
          data-slot="presets-dropdown-open-new-tab"
          onSelect={() => onActivateSaved(filter, { forceNewTab: true })}
        >
          <ExternalLink className="size-3.5" aria-hidden="true" />
          <span className="sr-only">{labels.openInNewTab(filter.name)}</span>
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger
            className="shrink-0 px-1 py-1.5"
            aria-label={labels.savedRowMenuLabel(filter.name)}
          >
            <span className="sr-only">
              {labels.savedRowMenuLabel(filter.name)}
            </span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuItem
              onSelect={() => onActivateSaved(filter, { forceNewTab: true })}
            >
              {labels.loadInNewTab}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onLoadSavedInCurrentTab(filter)}>
              {labels.loadInCurrentTab}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => setRenameTarget(filter)}>
              {labels.rename}
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => setDeleteTarget(filter)}
            >
              {labels.delete}
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </div>
    ));
  }
}

/**
 * Issue #429: detect a Cmd-Ctrl-click that should bypass the create-or-
 * focus decider and always create a new tab. Mirrors the platform
 * convention from anchor `target="_blank"` semantics — Mac users press
 * `meta`, Windows / Linux users press `ctrl`.
 */
function isForceNewTabClick(event: ReactMouseEvent): boolean {
  return event.metaKey || event.ctrlKey;
}
