"use client";

/**
 * Admin-only "Rebuild this period" affordance for the Triage menu
 * Baseline-mode header (#473).
 *
 * Visibility rules:
 *   - The caller must be a `SystemAdministrator`. The server enforces
 *     this on the route handler; the page only renders this component
 *     when the server already established the role.
 *   - The button shows only when the effective customer scope has
 *     exactly one customer. With 2+ customers the button is hidden
 *     and a disabled-tooltip affordance takes its place so the
 *     operator knows the gate exists.
 *
 * Click flow:
 *   1. Click → GET /api/triage/baseline/rebuild/estimate for the
 *      currently selected period + the resolved single customer id.
 *   2. Confirm modal renders {customer, period, what-this-does,
 *      estimated row count, retention warning if any, abort note}.
 *   3. Confirm → POST /api/triage/baseline/rebuild. Spinner during
 *      execution. On 200, toast with deleted/inserted counts. On
 *      409 (`RebuildBusy`) / 504 (`RebuildTimeout`) / other error,
 *      toast with the error message and re-enable the button.
 *   4. router.refresh() on success so the freshness header and the
 *      menu row list reflect the new corpus state.
 */

import { useRouter } from "next/navigation";
import { useState } from "react";

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
import { readCsrfToken } from "@/lib/csrf-client";

export interface TriageRebuildLabels {
  /** "Rebuild this period" — the button face. */
  button: string;
  /** Disabled affordance tooltip when scope has >1 customer. */
  multiScopeTooltip: string;
  /** Modal title. */
  modalTitle: string;
  /** Single-line description above the body. */
  modalIntro: string;
  /** Field label preceding the resolved customer name+id. */
  customerLabel: string;
  /** Field label preceding the period. */
  periodLabel: string;
  /** "What this does" block label. */
  whatThisDoesLabel: string;
  /** "What this does" body text. */
  whatThisDoesBody: string;
  /** Field label preceding the estimated row-count value. */
  estimateLabel: string;
  /** Hint shown next to the row-count value. */
  estimateHint: string;
  /**
   * Standard "keep this tab open / stay on this page" abort note.
   *
   * The completion toast lives in component state on this button, so
   * any unmount of the menu page — tab close, hard reload, or in-app
   * navigation away — hides the toast even when the in-flight POST
   * eventually commits. The audit log is the canonical post-hoc
   * record of the outcome in those cases.
   */
  abortNote: string;
  /** Modal confirm button. */
  confirmButton: string;
  /** Modal cancel button. */
  cancelButton: string;
  /**
   * Success toast template — `{deleted}` and `{inserted}` are
   * replaced with the precise row counts from the rebuild response.
   */
  toastSuccessTemplate: string;
  /** Busy-error toast. */
  toastBusy: string;
  /** Timeout-error toast. */
  toastTimeout: string;
  /**
   * Incomplete-fetch toast — review's paginator never reached
   * `hasNextPage = false` within the safety cap (or returned
   * `hasNextPage = true` without a usable `endCursor`). The corpus
   * was left untouched; the operator should split the period and
   * retry, or investigate the resolver if the page count was
   * unexpected for the range. Distinct from `toastTimeout` because
   * the failure cause and the operator's next step are different —
   * a timeout suggests the period is too large for the 300 s cap,
   * whereas an incomplete fetch suggests a paginator fault and the
   * operator should retry the same period after investigating.
   */
  toastIncomplete: string;
  /** Generic-error toast prefix. */
  toastErrorPrefix: string;
  /**
   * Non-blocking "rebuilding..." overlay label rendered over the
   * menu row list while the destructive rebuild is in flight so the
   * operator can see that the visible corpus may briefly drop to 0
   * and refill, even after the confirm modal has closed.
   */
  rebuildingOverlay: string;
}

export interface TriageRebuildPeriod {
  startIso: string;
  endIso: string;
}

interface TriageRebuildButtonProps {
  customer: { id: number; name: string } | null;
  multiCustomerScope: boolean;
  period: TriageRebuildPeriod;
  labels: TriageRebuildLabels;
  /**
   * Called whenever the in-flight rebuild status flips. The parent
   * shell renders the non-blocking "rebuilding..." overlay over the
   * menu row list while this is `true`, so the operator sees the row
   * list status — not just the button label — change during the
   * destructive operation.
   */
  onSubmittingChange?: (submitting: boolean) => void;
}

interface EstimateState {
  status: "idle" | "loading" | "ready" | "error";
  currentTriagedRowCount?: number;
  warnings?: string[];
  error?: string;
}

export function TriageRebuildButton({
  customer,
  multiCustomerScope,
  period,
  labels,
  onSubmittingChange,
}: TriageRebuildButtonProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [estimate, setEstimate] = useState<EstimateState>({ status: "idle" });
  const [submitting, setSubmittingRaw] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  // Mirror `submitting` to the parent so the menu row-list overlay
  // stays in sync without coupling the parent shell to this
  // component's internals (the parent only needs the boolean).
  function setSubmitting(next: boolean) {
    setSubmittingRaw(next);
    onSubmittingChange?.(next);
  }

  if (multiCustomerScope || customer === null) {
    return (
      <button
        type="button"
        disabled
        title={labels.multiScopeTooltip}
        aria-label={labels.multiScopeTooltip}
        className="cursor-not-allowed rounded-md border border-input/40 px-2 py-1 text-xs text-muted-foreground opacity-60"
      >
        {labels.button}
      </button>
    );
  }

  async function openWithEstimate() {
    if (!customer) return;
    setOpen(true);
    setEstimate({ status: "loading" });
    try {
      const url = new URL(
        "/api/triage/baseline/rebuild/estimate",
        window.location.origin,
      );
      url.searchParams.set("customerId", String(customer.id));
      url.searchParams.set("from", period.startIso);
      url.searchParams.set("to", period.endIso);
      const res = await fetch(url.toString(), { credentials: "same-origin" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        setEstimate({
          status: "error",
          error: body.error ?? `HTTP ${res.status}`,
        });
        return;
      }
      const body = (await res.json()) as {
        currentTriagedRowCount: number;
        warnings: string[];
      };
      setEstimate({
        status: "ready",
        currentTriagedRowCount: body.currentTriagedRowCount,
        warnings: body.warnings,
      });
    } catch (err) {
      setEstimate({
        status: "error",
        error: err instanceof Error ? err.message : "estimate failed",
      });
    }
  }

  async function onConfirm() {
    if (!customer) return;
    setSubmitting(true);
    setOpen(false);
    try {
      const csrf = readCsrfToken();
      const res = await fetch("/api/triage/baseline/rebuild", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          ...(csrf ? { "X-CSRF-Token": csrf } : {}),
        },
        body: JSON.stringify({
          customerId: customer.id,
          from: period.startIso,
          to: period.endIso,
        }),
      });
      if (res.ok) {
        const body = (await res.json()) as {
          deletedTriagedRows: number;
          insertedTriagedRows: number;
        };
        setToast(
          labels.toastSuccessTemplate
            .replace("{deleted}", String(body.deletedTriagedRows))
            .replace("{inserted}", String(body.insertedTriagedRows)),
        );
        router.refresh();
      } else if (res.status === 409) {
        setToast(labels.toastBusy);
      } else if (res.status === 504) {
        // 504 covers two distinct failure modes that need different
        // operator follow-up: `RebuildTimeout` means the period was
        // too large for the 300 s cap (operator splits and retries),
        // while `RebuildIncomplete` means review's paginator never
        // reached `hasNextPage = false` within the safety cap and
        // the corpus was left untouched (operator investigates the
        // paginator or splits and retries). Branching on the typed
        // `code` keeps the toast text aligned with the actual cause
        // rather than collapsing both into the timeout copy.
        const body = (await res.json().catch(() => ({}))) as { code?: string };
        if (body.code === "RebuildIncomplete") {
          setToast(labels.toastIncomplete);
        } else {
          setToast(labels.toastTimeout);
        }
      } else {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setToast(
          `${labels.toastErrorPrefix} ${body.error ?? `HTTP ${res.status}`}`,
        );
      }
    } catch (err) {
      setToast(
        `${labels.toastErrorPrefix} ${err instanceof Error ? err.message : "request failed"}`,
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={openWithEstimate}
        disabled={submitting}
        className="rounded-md border border-input/60 bg-background px-2 py-1 text-xs hover:bg-accent disabled:cursor-wait disabled:opacity-50"
      >
        {submitting ? "…" : labels.button}
      </button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{labels.modalTitle}</AlertDialogTitle>
            <AlertDialogDescription>{labels.modalIntro}</AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-3 text-sm">
            <div>
              <span className="font-medium">{labels.customerLabel}: </span>
              <span>
                {customer.name} (#{customer.id})
              </span>
            </div>
            <div>
              <span className="font-medium">{labels.periodLabel}: </span>
              <span>
                {period.startIso} → {period.endIso}
              </span>
            </div>
            <div>
              <span className="font-medium">{labels.whatThisDoesLabel}: </span>
              <span>{labels.whatThisDoesBody}</span>
            </div>
            <div>
              <span className="font-medium">{labels.estimateLabel}: </span>
              {estimate.status === "loading" ? (
                <span>…</span>
              ) : estimate.status === "ready" ? (
                <span>
                  {estimate.currentTriagedRowCount} {labels.estimateHint}
                </span>
              ) : estimate.status === "error" ? (
                <span className="text-destructive">{estimate.error}</span>
              ) : null}
            </div>
            {estimate.status === "ready" &&
            estimate.warnings &&
            estimate.warnings.length > 0 ? (
              <ul className="rounded-md border border-amber-300/60 bg-amber-50 px-3 py-2 text-amber-900 dark:border-amber-500/40 dark:bg-amber-950/40 dark:text-amber-200">
                {estimate.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            ) : null}
            <p className="text-xs text-muted-foreground">{labels.abortNote}</p>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>{labels.cancelButton}</AlertDialogCancel>
            <AlertDialogAction
              onClick={onConfirm}
              disabled={estimate.status !== "ready"}
            >
              {labels.confirmButton}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {toast !== null ? (
        <p
          role="status"
          className="fixed right-4 bottom-4 z-50 rounded-md border bg-background px-3 py-2 text-xs shadow-lg"
        >
          <span>{toast}</span>
          <button
            type="button"
            onClick={() => setToast(null)}
            aria-label="Dismiss"
            className="ml-3 text-muted-foreground"
          >
            ×
          </button>
        </p>
      ) : null}
    </>
  );
}
