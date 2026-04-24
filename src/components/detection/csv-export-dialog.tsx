"use client";

import { useLayoutEffect, useRef } from "react";

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

export interface CsvExportConfirmLabels {
  title: string;
  descriptionTemplate: string;
  continueLabel: string;
  cancelLabel: string;
  narrowFilterLabel: string;
}

export interface CsvExportErrorLabels {
  title: string;
  description: string;
  dismiss: string;
}

interface CsvExportConfirmDialogProps {
  open: boolean;
  totalCount: string | null;
  estimatedBytes: number | null;
  labels: CsvExportConfirmLabels;
  onContinue: () => void;
  onCancel: () => void;
  onNarrow: () => void;
}

/**
 * Large-export confirmation dialog. Surfaces when the server
 * returns `409 confirmation-required`: quotes the row count and
 * an estimated download size, and offers three paths — continue
 * deliberately, cancel, or open the filter drawer to narrow the
 * current filter before retrying.
 */
export function CsvExportConfirmDialog({
  open,
  totalCount,
  estimatedBytes,
  labels,
  onContinue,
  onCancel,
  onNarrow,
}: CsvExportConfirmDialogProps) {
  const description = labels.descriptionTemplate
    .replace("{count}", totalCount ?? "")
    .replace(
      "{size}",
      estimatedBytes !== null ? formatByteSize(estimatedBytes) : "",
    );
  // Radix closes the dialog for us when the operator clicks the
  // Continue action, the Cancel action, Escape, or the overlay. We
  // only want the `onCancel()` path to fire for the last three —
  // clicking Continue must not also clear the pending payload / flip
  // the hook back to `idle`, or the header button re-enables while
  // the confirmed export is still in flight and a second click would
  // issue a duplicate request. The close-routing logic lives in
  // `createDialogCloseHandlers` so tests can exercise the same
  // handlers the component wires up without reconstructing them.
  const handlersRef = useRef(
    createDialogCloseHandlers({ onContinue, onCancel, onNarrow }),
  );
  // Keep the handlers referencing the latest props. The suppressor
  // state lives inside the ref so arm/consume survives re-renders.
  // useLayoutEffect so the swap happens before Radix's next
  // `onOpenChange` has a chance to read the callbacks.
  useLayoutEffect(() => {
    handlersRef.current.update({ onContinue, onCancel, onNarrow });
  }, [onContinue, onCancel, onNarrow]);
  const { handleContinue, handleNarrow, handleOpenChange } =
    handlersRef.current;
  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{labels.title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button type="button" variant="ghost" onClick={handleNarrow}>
            {labels.narrowFilterLabel}
          </Button>
          <AlertDialogCancel>{labels.cancelLabel}</AlertDialogCancel>
          <AlertDialogAction onClick={handleContinue}>
            {labels.continueLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * One-shot latch used by {@link CsvExportConfirmDialog} to tell the
 * "Continue" / "Narrow" close path apart from the generic "dialog
 * was dismissed" close path that Radix drives via `onOpenChange`.
 * Exported so the wiring can be unit-tested without standing up a
 * DOM; the dialog consumes it from a `useRef` so the arm/consume
 * cycle survives React re-renders within a single user click.
 */
export interface CloseSuppressor {
  arm: () => void;
  consume: () => boolean;
}

export function createCloseSuppressor(): CloseSuppressor {
  let armed = false;
  return {
    arm() {
      armed = true;
    },
    consume() {
      if (!armed) return false;
      armed = false;
      return true;
    },
  };
}

export interface DialogCloseCallbacks {
  onContinue: () => void;
  onCancel: () => void;
  onNarrow: () => void;
}

export interface DialogCloseHandlers {
  handleContinue: () => void;
  handleNarrow: () => void;
  handleOpenChange: (next: boolean) => void;
  /**
   * Swap in a fresh callback set without losing the suppressor's
   * armed state. The component calls this on every render so the
   * handlers close over the latest props while still sharing the
   * arm/consume cycle a single user click depends on.
   */
  update: (next: DialogCloseCallbacks) => void;
}

/**
 * Shared close-routing logic for {@link CsvExportConfirmDialog} —
 * imported both by the component and by its regression tests so the
 * wiring cannot drift between the two. The helper owns the
 * suppressor latch: Continue and Narrow arm it before firing their
 * own callback, and the generic `onOpenChange(false)` path consumes
 * the latch to decide whether the close was deliberate (Continue /
 * Narrow) or a cancel (Escape / overlay / Cancel button). This is
 * the exact invariant the Round 4 bug broke when Continue was still
 * routing through `onCancel`.
 */
export function createDialogCloseHandlers(
  initial: DialogCloseCallbacks,
): DialogCloseHandlers {
  const suppressor = createCloseSuppressor();
  let current = initial;
  return {
    handleContinue() {
      suppressor.arm();
      current.onContinue();
    },
    handleNarrow() {
      suppressor.arm();
      current.onNarrow();
    },
    handleOpenChange(next: boolean) {
      if (next) return;
      if (suppressor.consume()) return;
      current.onCancel();
    },
    update(next) {
      current = next;
    },
  };
}

/**
 * Format a byte count as a compact human-readable string. Uses
 * binary multiples (KiB / MiB / GiB) to stay consistent with how
 * most OS file browsers quote download sizes.
 */
export function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  const precision = value >= 100 || idx === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(precision)} ${units[idx]}`;
}
