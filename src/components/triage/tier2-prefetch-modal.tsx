"use client";

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

export interface Tier2PrefetchModalLabels {
  title: string;
  /** Template uses `{count}` and `{threshold}` placeholders. */
  descriptionTemplate: string;
  descriptionUnknown: string;
  confirm: string;
  cancel: string;
}

interface Tier2PrefetchModalProps {
  open: boolean;
  /** REview's `totalCount` from the projection, or null when unknown. */
  projectedCount: string | null;
  /** Modal threshold (#453 — 20,000). */
  threshold: number;
  onConfirm: () => void;
  onCancel: () => void;
  labels: Tier2PrefetchModalLabels;
}

const COUNT_FORMAT = new Intl.NumberFormat();

/**
 * Pre-fetch confirmation dialog (#453). Renders when the projected
 * Tier 2 fetch is above {@link Tier2PrefetchModalProps.threshold}; the
 * fetch is blocked until the operator clicks Confirm.
 */
export function Tier2PrefetchModal({
  open,
  projectedCount,
  threshold,
  onConfirm,
  onCancel,
  labels,
}: Tier2PrefetchModalProps) {
  const description =
    projectedCount === null
      ? labels.descriptionUnknown
      : labels.descriptionTemplate
          .replace(
            "{count}",
            (() => {
              try {
                return BigInt(projectedCount).toLocaleString();
              } catch {
                return projectedCount;
              }
            })(),
          )
          .replace("{threshold}", COUNT_FORMAT.format(threshold));

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{labels.title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>
            {labels.cancel}
          </AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>
            {labels.confirm}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
