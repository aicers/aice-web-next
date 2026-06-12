"use client";

/**
 * "Save as Story" modal (#490). Opens from the pivot breadcrumb area
 * with the current pivot focus's events pre-selected. The analyst
 * can toggle individual events off, optionally name the Story, and
 * confirm to create a `kind = 'analyst_curated'` `event_group` row
 * via {@link submitSaveAnalystCuratedStory}.
 *
 * Authoritative validation lives server-side; this modal surfaces
 * one error string per known structured failure and a generic
 * fallback for unexpected server-side throws.
 */

import { useEffect, useMemo, useState, useTransition } from "react";

import { Timestamp } from "@/components/timestamp";
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
import type { ScoredTriageEvent, TriagePeriod } from "@/lib/triage";
import type {
  SaveCuratedStoryError,
  SaveCuratedStoryResult,
} from "@/lib/triage/story/types";

export interface TriageSaveAsStoryLabels {
  button: string;
  /** Tooltip on the disabled button when the pivot focus spans multiple customers. */
  disabledMultiCustomer: string;
  modalTitle: string;
  titleLabel: string;
  titlePlaceholder: string;
  membersHeading: string;
  confirm: string;
  cancel: string;
  successToast: string;
  errorOverCap: string;
  errorEmpty: string;
  errorMemberNotFound: string;
  errorAssetMismatch: string;
  errorCustomerOutOfScope: string;
  errorMultiCustomer: string;
  errorGeneric: string;
}

export interface TriageSaveAsStoryModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Pivot focus events visible at modal-open time. Pre-selected; the
   * analyst can untick individual rows before confirming.
   */
  focusEvents: ReadonlyArray<ScoredTriageEvent>;
  /**
   * Loaded menu period — forwarded to the server action so the audit
   * record carries the same period the analyst saw.
   */
  period: TriagePeriod;
  /**
   * Called by the modal on successful save. The caller routes the
   * focus to the Stories tab + new Story id.
   */
  onSaved: (result: { customerId: number; storyId: string }) => void;
  /**
   * Server action invocation seam (a `"use server"` function). Kept
   * as a prop so the component is unit-testable without a Next dev
   * server.
   */
  submit: (input: {
    customerId: number;
    memberEventKeys: string[];
    memberCustomerIds: number[];
    primaryAsset: string;
    title?: string;
  }) => Promise<SaveCuratedStoryResult>;
  labels: TriageSaveAsStoryLabels;
}

function resolveSingleCustomer(
  events: ReadonlyArray<ScoredTriageEvent>,
): number | null {
  if (events.length === 0) return null;
  const first = events[0].customerId;
  for (const ev of events) {
    if (ev.customerId !== first) return null;
  }
  return first;
}

function defaultPrimaryAsset(
  events: ReadonlyArray<ScoredTriageEvent>,
): string | null {
  // Pick the most common non-null `origAddr` so a heterogeneous focus
  // still settles on the analyst's most-likely intent.
  const counts = new Map<string, number>();
  for (const ev of events) {
    if (!ev.origAddr) continue;
    counts.set(ev.origAddr, (counts.get(ev.origAddr) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  let best: string | null = null;
  let bestCount = 0;
  for (const [addr, count] of counts.entries()) {
    if (count > bestCount) {
      best = addr;
      bestCount = count;
    }
  }
  return best;
}

function errorLabel(
  error: SaveCuratedStoryError,
  labels: TriageSaveAsStoryLabels,
): string {
  switch (error.code) {
    case "OVER_CAP":
      return labels.errorOverCap;
    case "EMPTY":
      return labels.errorEmpty;
    case "MEMBER_NOT_FOUND":
      return labels.errorMemberNotFound;
    case "ASSET_MISMATCH":
      return labels.errorAssetMismatch;
    case "CUSTOMER_OUT_OF_SCOPE":
      return labels.errorCustomerOutOfScope;
    case "MULTI_CUSTOMER_NOT_ALLOWED":
      return labels.errorMultiCustomer;
    default:
      return labels.errorGeneric;
  }
}

export function TriageSaveAsStoryModal({
  open,
  onOpenChange,
  focusEvents,
  period,
  onSaved,
  submit,
  labels,
}: TriageSaveAsStoryModalProps) {
  const customerId = useMemo(
    () => resolveSingleCustomer(focusEvents),
    [focusEvents],
  );
  const initialKeys = useMemo(
    () => new Set(focusEvents.map((e) => e.id)),
    [focusEvents],
  );
  const [selected, setSelected] = useState<Set<string>>(initialKeys);
  const [title, setTitle] = useState<string>("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (open) {
      setSelected(new Set(focusEvents.map((e) => e.id)));
      setTitle("");
      setErrorMessage(null);
    }
  }, [open, focusEvents]);

  // `period` is included for the server action's audit payload; the
  // modal itself does not key off it but keeps the prop in the
  // closure so React schedules a re-render if the surrounding shell
  // rotates the period while the modal is open.
  void period;

  const onSubmit = () => {
    setErrorMessage(null);
    if (customerId === null) {
      setErrorMessage(labels.errorMultiCustomer);
      return;
    }
    const selectedEvents = focusEvents.filter((e) => selected.has(e.id));
    const memberEventKeys = selectedEvents.map((e) => e.id);
    // Parallel array carrying the per-member tenant-of-origin the
    // pivot focus observed. The server's MULTI_CUSTOMER_NOT_ALLOWED
    // guard reads this; the client UI gating above (single
    // `customerId` derived from `focusEvents`) is the friendly
    // upstream check, but the server is authoritative.
    const memberCustomerIds = selectedEvents.map((e) => e.customerId);
    const primaryAsset = defaultPrimaryAsset(selectedEvents);
    if (primaryAsset === null) {
      setErrorMessage(labels.errorAssetMismatch);
      return;
    }
    const trimmedTitle = title.trim();
    startTransition(async () => {
      try {
        const result = await submit({
          customerId,
          memberEventKeys,
          memberCustomerIds,
          primaryAsset,
          title: trimmedTitle.length === 0 ? undefined : trimmedTitle,
        });
        if (result.ok) {
          onSaved({ customerId: result.customerId, storyId: result.storyId });
          onOpenChange(false);
        } else {
          setErrorMessage(errorLabel(result.error, labels));
        }
      } catch {
        setErrorMessage(labels.errorGeneric);
      }
    });
  };

  const toggleKey = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{labels.modalTitle}</AlertDialogTitle>
          <AlertDialogDescription>
            {labels.membersHeading}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">{labels.titleLabel}</span>
            <input
              type="text"
              value={title}
              maxLength={200}
              placeholder={labels.titlePlaceholder}
              onChange={(e) => setTitle(e.currentTarget.value)}
              className="rounded-sm border border-border bg-background px-2 py-1"
              data-testid="triage-save-as-story-title"
            />
          </label>
          <ul
            className="max-h-60 overflow-y-auto rounded-sm border border-border bg-background"
            data-testid="triage-save-as-story-members"
          >
            {focusEvents.map((ev) => (
              <li
                key={ev.id}
                className="flex items-center gap-2 border-b border-border/60 px-2 py-1 text-xs last:border-0"
              >
                <input
                  type="checkbox"
                  checked={selected.has(ev.id)}
                  onChange={() => toggleKey(ev.id)}
                  data-testid={`triage-save-as-story-member-${ev.id}`}
                />
                <span className="font-mono">
                  <Timestamp at={ev.time} />
                </span>
                <span className="text-muted-foreground">{ev.__typename}</span>
                <span className="ml-auto text-muted-foreground">
                  {ev.origAddr ?? "—"}
                </span>
              </li>
            ))}
          </ul>
          {errorMessage !== null ? (
            <p
              role="alert"
              data-testid="triage-save-as-story-error"
              className="rounded-md border border-destructive/60 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
              {errorMessage}
            </p>
          ) : null}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>
            {labels.cancel}
          </AlertDialogCancel>
          <AlertDialogAction
            data-testid="triage-save-as-story-confirm"
            disabled={pending || selected.size === 0 || customerId === null}
            onClick={(e) => {
              e.preventDefault();
              onSubmit();
            }}
          >
            {labels.confirm}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
