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
  /**
   * Template used when `projectedCount` is null but the hook surfaced
   * a first-page lower bound on `approximateMinimum`. Same `{count}` /
   * `{threshold}` placeholders; copy is expected to label the count as
   * approximate (e.g. "≥ {count}") per #453.
   */
  descriptionApproximateTemplate: string;
  descriptionUnknown: string;
  confirm: string;
  cancel: string;
}

interface Tier2PrefetchModalProps {
  open: boolean;
  /** REview's `totalCount` from the projection, or null when unknown. */
  projectedCount: string | null;
  /**
   * Lower-bound count from the first-page cursor walk when
   * `projectedCount` is null. Drives the approximate "≥ N" copy; null
   * means no estimate is available.
   */
  approximateMinimum: string | null;
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
  approximateMinimum,
  threshold,
  onConfirm,
  onCancel,
  labels,
}: Tier2PrefetchModalProps) {
  const formatStringNumber = (value: string): string => {
    try {
      return BigInt(value).toLocaleString();
    } catch {
      return value;
    }
  };
  const description = ((): string => {
    if (projectedCount !== null) {
      return labels.descriptionTemplate
        .replace("{count}", formatStringNumber(projectedCount))
        .replace("{threshold}", COUNT_FORMAT.format(threshold));
    }
    if (approximateMinimum !== null) {
      return labels.descriptionApproximateTemplate
        .replace("{count}", formatStringNumber(approximateMinimum))
        .replace("{threshold}", COUNT_FORMAT.format(threshold));
    }
    return labels.descriptionUnknown;
  })();

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
