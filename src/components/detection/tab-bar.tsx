"use client";

import { Plus, RotateCcw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { TabId } from "@/lib/detection/tabs";
import { cn } from "@/lib/utils";

export interface TabBarLabels {
  tablist: string;
  newTab: string;
  newTabAtCap: string;
  closeTab: string;
  renameTab: string;
  resetName: string;
}

export interface TabBarTab {
  id: TabId;
  label: string;
  /**
   * True when the label was derived from the filter summary (as
   * opposed to a manual rename). The `Reset name` affordance is
   * hidden for auto-named tabs — the reset is a no-op in that case.
   */
  isAuto: boolean;
  /**
   * True while this tab has an in-flight committed query. The tab
   * bar surfaces a subtle dot so switching away from a loading
   * query is discoverable.
   */
  loading: boolean;
}

export interface TabBarProps {
  tabs: readonly TabBarTab[];
  activeTabId: TabId;
  canAddTab: boolean;
  labels: TabBarLabels;
  onActivate: (id: TabId) => void;
  onAddTab: () => void;
  onCloseTab: (id: TabId) => void;
  onRename: (id: TabId, next: string) => void;
  onResetName: (id: TabId) => void;
}

export function TabBar({
  tabs,
  activeTabId,
  canAddTab,
  labels,
  onActivate,
  onAddTab,
  onCloseTab,
  onRename,
  onResetName,
}: TabBarProps) {
  const [editingId, setEditingId] = useState<TabId | null>(null);
  // Reviewer Round 1 (item 4): the close × is always rendered, even
  // when there is only one tab. The wrapper's `closeTab` helper
  // auto-creates a fresh default tab when the operator closes the
  // final one, matching the issue's accepted behaviour ("Closing the
  // last tab auto-creates a default tab"). Hiding the affordance on
  // the last tab made that path unreachable from the UI.
  const closable = true;
  return (
    <div
      role="tablist"
      aria-label={labels.tablist}
      className="flex items-center gap-1 border-b border-[var(--sidebar-border)] pb-0"
    >
      <div className="flex min-w-0 flex-1 items-end gap-1 overflow-x-auto">
        {tabs.map((tab) => (
          <TabEntry
            key={tab.id}
            tab={tab}
            active={tab.id === activeTabId}
            editing={editingId === tab.id}
            closable={closable}
            labels={labels}
            onActivate={() => onActivate(tab.id)}
            onStartEdit={() => setEditingId(tab.id)}
            onCommitEdit={(next) => {
              const trimmed = next.trim();
              if (trimmed.length > 0 && trimmed !== tab.label) {
                onRename(tab.id, trimmed);
              }
              setEditingId(null);
            }}
            onCancelEdit={() => setEditingId(null)}
            onReset={() => onResetName(tab.id)}
            onClose={() => onCloseTab(tab.id)}
          />
        ))}
      </div>
      {canAddTab ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={labels.newTab}
          onClick={onAddTab}
          className="shrink-0"
        >
          <Plus className="size-4" aria-hidden="true" />
        </Button>
      ) : (
        // Reviewer Round 4 (item 3): the cap state uses the Radix
        // Tooltip primitive, not a bare HTML `title` — `title` on a
        // disabled control is not dependably surfaced on all
        // platforms and is not keyboard-reachable. `aria-disabled`
        // (rather than `disabled`) keeps the button focusable so the
        // cap reason is surfaced to keyboard users too, and the
        // onClick guard makes the control non-actionable.
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={labels.newTabAtCap}
                aria-disabled
                onClick={(e) => {
                  e.preventDefault();
                }}
                className="shrink-0 cursor-not-allowed opacity-50"
              >
                <Plus className="size-4" aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{labels.newTabAtCap}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
    </div>
  );
}

function TabEntry({
  tab,
  active,
  editing,
  closable,
  labels,
  onActivate,
  onStartEdit,
  onCommitEdit,
  onCancelEdit,
  onReset,
  onClose,
}: {
  tab: TabBarTab;
  active: boolean;
  editing: boolean;
  closable: boolean;
  labels: TabBarLabels;
  onActivate: () => void;
  onStartEdit: () => void;
  onCommitEdit: (next: string) => void;
  onCancelEdit: () => void;
  onReset: () => void;
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);
  return (
    <div
      role="tab"
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      data-state={active ? "active" : "inactive"}
      onKeyDown={(e) => {
        // Reviewer Round 4 (item 2): when focus lands on the role=tab
        // wrapper (the canonical ARIA tab element) rather than the
        // inner button, Enter must still open rename so the
        // documented keyboard contract is reachable by keyboard users.
        // Ignore key events bubbling up from within the editing input
        // so a commit there is not mistaken for a fresh rename trigger.
        if (editing) return;
        if (e.key !== "Enter") return;
        if (e.target !== e.currentTarget) return;
        e.preventDefault();
        onStartEdit();
      }}
      className={cn(
        "group flex shrink-0 items-center gap-1 rounded-t-md border-b-2 px-3 py-1.5 text-sm",
        active
          ? "border-foreground bg-background text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground",
      )}
    >
      {editing ? (
        <input
          ref={inputRef}
          type="text"
          defaultValue={tab.label}
          aria-label={labels.renameTab}
          className="min-w-24 rounded-sm border border-input bg-background px-1 py-0.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          onBlur={(e) => onCommitEdit(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onCommitEdit(e.currentTarget.value);
            } else if (e.key === "Escape") {
              e.preventDefault();
              onCancelEdit();
            }
          }}
        />
      ) : (
        <button
          type="button"
          onClick={onActivate}
          onDoubleClick={onStartEdit}
          onKeyDown={(e) => {
            // Reviewer Round 4 (item 2): Enter on a focused tab opens
            // rename, matching the documented keyboard contract.
            // `preventDefault` short-circuits the button's native
            // Enter→click so the tab does not also re-activate; the
            // click path stays the primary way to activate and single-
            // click still routes through `onClick` above.
            if (e.key === "Enter") {
              e.preventDefault();
              onStartEdit();
            }
          }}
          title={tab.label}
          className="max-w-48 truncate text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          {tab.label}
          {tab.loading ? (
            <span
              aria-hidden="true"
              className="ml-1 inline-block size-1.5 rounded-full bg-foreground/40"
            />
          ) : null}
        </button>
      )}
      {!tab.isAuto && !editing ? (
        <button
          type="button"
          onClick={onReset}
          aria-label={labels.resetName}
          title={labels.resetName}
          className="text-muted-foreground hover:text-foreground inline-flex size-4 items-center justify-center rounded-sm opacity-60 hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <RotateCcw className="size-3" aria-hidden="true" />
        </button>
      ) : null}
      {closable && !editing ? (
        <button
          type="button"
          aria-label={labels.closeTab}
          title={labels.closeTab}
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          className="text-muted-foreground hover:text-foreground inline-flex size-4 items-center justify-center rounded-sm opacity-60 hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <X className="size-3" aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}
