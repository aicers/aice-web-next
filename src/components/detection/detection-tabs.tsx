"use client";

import { Plus, RotateCcw, X } from "lucide-react";
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { TabSnapshot } from "@/lib/detection/tabs";
import { cn } from "@/lib/utils";

/**
 * Deterministic DOM id used for both the tab trigger and the matching
 * tabpanel so the shell can render a single `role="tabpanel"` wrapper
 * (keyed on the active tab) whose `aria-labelledby` points back at the
 * selected tab. The snapshot id is already stable for the life of the
 * tab — reusing it keeps the pairing resilient across reorders and
 * rehydrates without threading a separate ID registry through props.
 */
export function detectionTabDomId(snapshotId: string): string {
  return `detection-tab-${snapshotId}`;
}

export function detectionTabPanelDomId(snapshotId: string): string {
  return `detection-panel-${snapshotId}`;
}

export interface DetectionTabLabels {
  /** Accessible label for the tab bar (role="tablist"). */
  tabBarLabel: string;
  /** Accessible label for the + affordance. */
  addTab: string;
  /** Disabled-state tooltip when the tab cap is hit. */
  addTabCapTooltip: (cap: number) => string;
  /** Close button aria-label (per tab). */
  closeTab: (name: string) => string;
  /** Accessible label for the "reset name to auto" button. */
  resetName: string;
  /** Placeholder shown while a tab is being renamed and the input is empty. */
  renamePlaceholder: string;
  /** Screen-reader hint shown next to a tab title that is auto-generated. */
  autoNameHint: string;
  /** Screen-reader hint shown next to a tab title that was manually renamed. */
  manualNameHint: string;
  /** Inline hint inviting the operator to double-click (or F2) to rename. */
  doubleClickToRename: string;
}

export interface DetectionTabData {
  snapshot: TabSnapshot;
  /** Auto-generated title (from filter summary). */
  autoTitle: string;
}

interface DetectionTabsProps {
  tabs: readonly DetectionTabData[];
  activeIndex: number;
  cap: number;
  labels: DetectionTabLabels;
  onSelect: (index: number) => void;
  onClose: (index: number) => void;
  onAdd: () => void;
  onRename: (index: number, nextName: string | null) => void;
}

/**
 * Horizontal tab bar rendered above the result area.
 *
 * Interactions (Phase Detection-10 acceptance):
 *   - Single click on a tab trigger selects that tab.
 *   - Double-click on a tab title turns it into an editable input.
 *     Pressing `Enter` commits the rename; `Escape` reverts.
 *   - A dedicated `↺` affordance next to a renamed tab resets the
 *     name back to the auto-generated summary.
 *   - The `+` affordance appends a blank-filter tab and switches to
 *     it. When the tab cap is reached, it renders disabled with a
 *     tooltip explaining the cap.
 *   - The `×` affordance on each tab closes it; the shell is
 *     responsible for auto-creating a new default tab when the last
 *     one is closed.
 */
export function DetectionTabs({
  tabs,
  activeIndex,
  cap,
  labels,
  onSelect,
  onClose,
  onAdd,
  onRename,
}: DetectionTabsProps) {
  const atCap = tabs.length >= cap;
  const tabRefs = useRef<Array<HTMLDivElement | null>>([]);
  // Tracks the index that should receive focus after the next render.
  // Only populated by keyboard nav (arrow / Home / End) so pointer
  // activations don't steal focus from the user.
  const focusIndexRef = useRef<number | null>(null);

  useEffect(() => {
    const target = focusIndexRef.current;
    if (target === null) return;
    focusIndexRef.current = null;
    tabRefs.current[target]?.focus();
  });

  const moveFocus = useCallback(
    (nextIndex: number) => {
      if (nextIndex < 0 || nextIndex >= tabs.length) return;
      focusIndexRef.current = nextIndex;
      if (nextIndex !== activeIndex) onSelect(nextIndex);
      else tabRefs.current[nextIndex]?.focus();
    },
    [activeIndex, onSelect, tabs.length],
  );

  // Keyboard close (Delete on a focused tab) unmounts the focused
  // `role="tab"` wrapper, which would drop keyboard-only users out of
  // the tablist. Predict the surviving tab's index, stash it in
  // `focusIndexRef`, then hand control off to the shell's close
  // handler; the post-render focus effect above then moves focus to
  // the newly active neighbour. Keep the index math in sync with
  // `handleTabClose` in `detection-shell.tsx`.
  const handleKeyboardClose = useCallback(
    (index: number) => {
      const priorLength = tabs.length;
      const priorActive = activeIndex;
      let nextActive = priorActive;
      if (priorLength <= 1) {
        nextActive = 0;
      } else if (index < priorActive) {
        nextActive = priorActive - 1;
      } else if (index === priorActive) {
        nextActive = Math.min(priorActive, priorLength - 2);
      }
      focusIndexRef.current = nextActive;
      onClose(index);
    },
    [activeIndex, onClose, tabs.length],
  );

  const onTablistKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      // Only hijack arrow / Home / End when focus isn't inside a text
      // input — the rename input needs ArrowLeft / ArrowRight for cursor
      // movement and Home / End for start/end-of-line navigation. Every
      // other focusable element inside the tablist is a tab trigger or a
      // nested reset / close button with `tabIndex={-1}`; arrow keys
      // there should move tab selection regardless of which element
      // received focus via pointer.
      const target = event.target as HTMLElement | null;
      if (target && target.tagName === "INPUT") return;
      // Navigate relative to the currently focused tab, not the active
      // one. In the normal flow these coincide (arrow nav always
      // activates the tab it lands on), but flows like rename commit
      // restore focus to the wrapper via an effect — which may have
      // ended up on a tab that isn't the active one. The roving-
      // tabindex convention is to treat the focused tab as the user's
      // current position, so arrows should move relative to focus.
      const focused =
        typeof document !== "undefined" ? document.activeElement : null;
      const focusedIndex =
        focused instanceof HTMLDivElement
          ? tabRefs.current.indexOf(focused)
          : -1;
      const currentIndex = focusedIndex >= 0 ? focusedIndex : activeIndex;
      switch (event.key) {
        case "ArrowRight":
          event.preventDefault();
          moveFocus((currentIndex + 1) % tabs.length);
          break;
        case "ArrowLeft":
          event.preventDefault();
          moveFocus((currentIndex - 1 + tabs.length) % tabs.length);
          break;
        case "Home":
          event.preventDefault();
          moveFocus(0);
          break;
        case "End":
          event.preventDefault();
          moveFocus(tabs.length - 1);
          break;
        default:
          break;
      }
    },
    [activeIndex, moveFocus, tabs.length],
  );

  return (
    <TooltipProvider>
      <div
        role="tablist"
        aria-label={labels.tabBarLabel}
        aria-orientation="horizontal"
        onKeyDown={onTablistKeyDown}
        className="border-b border-[var(--sidebar-border)] flex items-stretch gap-1 overflow-x-auto"
      >
        {tabs.map((tab, index) => (
          <DetectionTabItem
            key={tab.snapshot.id}
            index={index}
            tab={tab}
            active={index === activeIndex}
            labels={labels}
            onSelect={() => onSelect(index)}
            onClose={() => onClose(index)}
            onKeyboardClose={() => handleKeyboardClose(index)}
            onRename={(name) => onRename(index, name)}
            registerRef={(el) => {
              tabRefs.current[index] = el;
            }}
          />
        ))}
        {atCap ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex items-center">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled
                  aria-label={labels.addTab}
                  className="h-8 px-2"
                >
                  <Plus className="size-4" aria-hidden="true" />
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent>{labels.addTabCapTooltip(cap)}</TooltipContent>
          </Tooltip>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={labels.addTab}
            onClick={onAdd}
            className="h-8 px-2"
          >
            <Plus className="size-4" aria-hidden="true" />
          </Button>
        )}
      </div>
    </TooltipProvider>
  );
}

interface DetectionTabItemProps {
  index: number;
  tab: DetectionTabData;
  active: boolean;
  labels: DetectionTabLabels;
  onSelect: () => void;
  onClose: () => void;
  onKeyboardClose: () => void;
  onRename: (nextName: string | null) => void;
  registerRef: (el: HTMLDivElement | null) => void;
}

function DetectionTabItem({
  index,
  tab,
  active,
  labels,
  onSelect,
  onClose,
  onKeyboardClose,
  onRename,
  registerRef,
}: DetectionTabItemProps) {
  const { snapshot, autoTitle } = tab;
  const manualName = snapshot.name;
  const effectiveTitle = manualName ?? autoTitle;
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(effectiveTitle);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  // Set by commit/cancel rename so the post-render effect knows to
  // move focus back to the `role="tab"` wrapper after the rename input
  // unmounts — otherwise keyboard-only operators drop out of the
  // tablist when rename ends.
  const restoreWrapperFocusRef = useRef(false);
  const tabId = detectionTabDomId(snapshot.id);
  const panelId = detectionTabPanelDomId(snapshot.id);
  const hintId = useId();

  // When the tab bar re-renders (filter change / activate), reset
  // the draft so the next rename session starts from the current
  // effective title rather than stale input.
  useEffect(() => {
    if (!renaming) setDraftName(effectiveTitle);
  }, [effectiveTitle, renaming]);

  useEffect(() => {
    if (renaming && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    } else if (!renaming && restoreWrapperFocusRef.current) {
      restoreWrapperFocusRef.current = false;
      wrapperRef.current?.focus();
    }
  }, [renaming]);

  const commitRename = useCallback(() => {
    const trimmed = draftName.trim();
    if (!trimmed || trimmed === autoTitle) {
      // Empty rename or matching the auto title: fall back to
      // auto-generated so the rename doesn't silently pin a dead
      // name.
      onRename(null);
    } else {
      onRename(trimmed);
    }
    restoreWrapperFocusRef.current = true;
    setRenaming(false);
  }, [autoTitle, draftName, onRename]);

  const cancelRename = useCallback(() => {
    setDraftName(effectiveTitle);
    restoreWrapperFocusRef.current = true;
    setRenaming(false);
  }, [effectiveTitle]);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        event.preventDefault();
        commitRename();
      } else if (event.key === "Escape") {
        event.preventDefault();
        cancelRename();
      }
    },
    [cancelRename, commitRename],
  );

  return (
    <div
      ref={(el) => {
        wrapperRef.current = el;
        registerRef(el);
      }}
      role="tab"
      id={tabId}
      aria-selected={active}
      aria-controls={panelId}
      tabIndex={active ? 0 : -1}
      aria-describedby={hintId}
      onClick={() => {
        if (!renaming) onSelect();
      }}
      onDoubleClick={(event) => {
        // Double-click on the tab (on the title or anywhere in the
        // wrapper) turns the title into a rename input. Hosted on the
        // `role="tab"` wrapper rather than a nested element so the
        // title can stay a non-focusable span and keyboard Tab only
        // lands on the `role="tab"` element itself.
        if (renaming) return;
        event.stopPropagation();
        setDraftName(effectiveTitle);
        setRenaming(true);
      }}
      onKeyDown={(event) => {
        if (renaming) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        } else if (event.key === "F2") {
          // Keyboard equivalent of the double-click-to-rename gesture.
          // The nested reset / close affordances sit at `tabIndex={-1}`
          // (so keyboard Tab cycles one entry per tab, not three), which
          // means rename / reset / close need dedicated keyboard
          // shortcuts on the `role="tab"` wrapper. F2 matches the
          // Windows / Excel / file-manager rename convention, and the
          // commit-on-empty branch of {@link commitRename} lets the
          // operator revert to the auto-generated summary by clearing
          // the input and pressing Enter — the keyboard equivalent of
          // the ↺ affordance.
          event.preventDefault();
          setDraftName(effectiveTitle);
          setRenaming(true);
        } else if (event.key === "Delete") {
          // Keyboard-accessible close path. Without this the nested ×
          // button — which is out of the tab order — has no keyboard
          // equivalent. Route through `onKeyboardClose` so the parent
          // can queue focus onto the surviving neighbour tab before
          // the close re-renders; without that, keyboard-only operators
          // fall back to `<body>` and have to Tab back into the
          // tablist before Arrow navigation works again.
          event.preventDefault();
          onKeyboardClose();
        }
      }}
      className={cn(
        "flex items-center gap-1 rounded-t-md border-b-2 px-3 py-1.5 text-sm select-none cursor-pointer",
        active
          ? "border-primary bg-background text-foreground font-medium"
          : "border-transparent text-muted-foreground hover:text-foreground",
      )}
    >
      {renaming ? (
        <input
          ref={inputRef}
          type="text"
          value={draftName}
          placeholder={labels.renamePlaceholder}
          onChange={(e) => setDraftName(e.target.value)}
          onBlur={commitRename}
          onKeyDown={onKeyDown}
          onClick={(e) => e.stopPropagation()}
          className="bg-transparent outline-none border-b border-foreground/40 text-sm min-w-0 max-w-40"
        />
      ) : (
        <span
          className="truncate max-w-40 text-left"
          title={`${effectiveTitle} · ${labels.doubleClickToRename}`}
        >
          {effectiveTitle}
        </span>
      )}
      <span id={hintId} className="sr-only">
        {manualName ? labels.manualNameHint : labels.autoNameHint}
      </span>
      {manualName !== null && !renaming ? (
        <button
          type="button"
          aria-label={labels.resetName}
          // `tabIndex={-1}` keeps the reset affordance clickable with a
          // pointer but out of the keyboard Tab order, so Tab cycles
          // one entry per tab (the `role="tab"` wrapper) instead of
          // three nested buttons. Without this, keyboard users can land
          // focus on a reset/close control inside an inactive tab and
          // the tablist arrow-key handler stops firing.
          tabIndex={-1}
          onClick={(event) => {
            event.stopPropagation();
            onRename(null);
          }}
          className="text-muted-foreground hover:text-foreground inline-flex size-4 items-center justify-center rounded-sm"
        >
          <RotateCcw className="size-3" aria-hidden="true" />
        </button>
      ) : null}
      <button
        type="button"
        aria-label={labels.closeTab(effectiveTitle)}
        tabIndex={-1}
        onClick={(event) => {
          event.stopPropagation();
          onClose();
        }}
        className="text-muted-foreground hover:text-foreground inline-flex size-4 items-center justify-center rounded-sm"
      >
        <X className="size-3" aria-hidden="true" />
      </button>
      {/* Positional index for test lookup — does not render visibly. */}
      <span className="sr-only">Tab {index + 1}</span>
    </div>
  );
}
