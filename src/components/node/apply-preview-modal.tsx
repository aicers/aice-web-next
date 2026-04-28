"use client";

/**
 * Apply preview modal (Phase Node-9d, #362).
 *
 * Drives the BFF apply state machine end-to-end from the operator's
 * point of view:
 *
 *   - On open, calls `createApplyAttempt({ nodeId })` and renders the
 *     returned plan as a client-only view model. The frozen `new` / `old`
 *     payloads on external dispatches are stripped at the boundary —
 *     only `attemptId`, `dispatchId`, `kind`, `state`, `attemptCount`,
 *     and `lastError` ever reach React state.
 *   - On Apply, calls `confirmApplyAttempt({ attemptId })` and rebuilds
 *     the per-row view model from the returned row.
 *   - On per-row Retry (visible only when that dispatch is in
 *     `failed_retryable`), calls
 *     `retryDispatch({ attemptId, dispatchId })`.
 *   - On Rebuild (after a `failed_terminal` or any plan-level error),
 *     discards `attemptId` and re-runs `createApplyAttempt({ nodeId })`
 *     to obtain a fresh plan.
 *
 * Server actions are passed via the `actions` prop so the modal can be
 * tested without hitting the BFF wire. The default consumer wires real
 * server actions from `@/lib/node/apply-actions` and
 * `@/lib/node/apply-attempts`.
 *
 * Accessibility:
 *
 *   - Wrapped in Radix Dialog for focus trapping and `role="dialog"`
 *     semantics.
 *   - Escape closes the modal only when not executing — the underlying
 *     BFF call cannot be cancelled, so dismissing the UI mid-flight
 *     would orphan a row in `executing`.
 *   - Per-row Retry buttons carry `aria-label` strings naming the
 *     dispatch kind so screen readers can disambiguate.
 */

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type {
  ApplyAttemptRow,
  CreateApplyAttemptResult,
  DispatchState,
  PlannedDispatch,
} from "@/lib/node/apply-attempt-types";
import { cn } from "@/lib/utils";

/**
 * Server-action shape the modal calls. Each action returns the same
 * shape its production counterpart returns, so the production wiring
 * is a thin pass-through (see `default-actions` below).
 */
export interface ApplyPreviewActions {
  createApplyAttempt: (args: {
    nodeId: string;
  }) => Promise<CreateApplyAttemptResult>;
  confirmApplyAttempt: (args: {
    attemptId: string;
  }) => Promise<ApplyAttemptRow>;
  retryDispatch: (args: {
    attemptId: string;
    dispatchId: string;
  }) => Promise<ApplyAttemptRow>;
}

export interface ApplyPreviewModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  nodeId: string;
  actions: ApplyPreviewActions;
}

/**
 * Client-only view of a single planned dispatch. Deliberately omits
 * the `new` / `old` fields that `ExternalPlannedDispatch` carries on
 * the wire — those frozen payloads must never enter React state per
 * the durability contract from #362.
 */
interface DispatchView {
  dispatchId: string;
  kind: PlannedDispatch["kind"];
  state: DispatchState;
  attemptCount: number;
  lastError: string | null;
}

function toDispatchView(dispatch: PlannedDispatch): DispatchView {
  return {
    dispatchId: dispatch.dispatchId,
    kind: dispatch.kind,
    state: dispatch.state,
    attemptCount: dispatch.attemptCount,
    lastError: dispatch.lastError,
  };
}

function toDispatchViews(dispatches: PlannedDispatch[]): DispatchView[] {
  return dispatches.map(toDispatchView);
}

type Phase =
  | { kind: "loading" }
  | {
      kind: "planned";
      attemptId: string;
      dispatches: DispatchView[];
      expiresAt: string;
    }
  | {
      kind: "executing";
      attemptId: string;
      dispatches: DispatchView[];
      expiresAt: string;
    }
  | {
      kind: "executed";
      attemptId: string;
      dispatches: DispatchView[];
      expiresAt: string;
      status: ApplyAttemptRow["status"];
    }
  | { kind: "error"; message: string };

export function ApplyPreviewModal({
  open,
  onOpenChange,
  nodeId,
  actions,
}: ApplyPreviewModalProps) {
  const t = useTranslations("nodes.applyPreview");
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });

  // Hold the latest `actions` in a ref so the open-time effect can be
  // keyed on `open` / `nodeId` only. A parent that re-renders with a
  // freshly-allocated `actions` object (the common case for inline
  // `{ createApplyAttempt, ... }` props) MUST NOT retrigger the
  // open-time effect — that would discard the live attemptId and
  // create a duplicate plan on the BFF.
  const actionsRef = useRef(actions);
  useEffect(() => {
    actionsRef.current = actions;
  }, [actions]);

  const buildPlan = useCallback(async () => {
    setPhase({ kind: "loading" });
    try {
      const result = await actionsRef.current.createApplyAttempt({ nodeId });
      setPhase({
        kind: "planned",
        attemptId: result.attemptId,
        dispatches: toDispatchViews(result.plannedDispatches),
        expiresAt: result.expiresAt,
      });
    } catch (err) {
      setPhase({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [nodeId]);

  // Open / close lifecycle. Building the plan happens once per open;
  // closing wipes attemptId from client state so re-opening always
  // takes a fresh path through createApplyAttempt. Dependencies are
  // intentionally limited to `open` and `nodeId` — see actionsRef
  // above for why `actions` is not a dependency.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setPhase({ kind: "loading" });
    actionsRef.current
      .createApplyAttempt({ nodeId })
      .then((result) => {
        if (cancelled) return;
        setPhase({
          kind: "planned",
          attemptId: result.attemptId,
          dispatches: toDispatchViews(result.plannedDispatches),
          expiresAt: result.expiresAt,
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setPhase({
          kind: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [open, nodeId]);

  const isExecuting = phase.kind === "executing";

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next && isExecuting) return;
      onOpenChange(next);
    },
    [isExecuting, onOpenChange],
  );

  const handleApply = useCallback(async () => {
    if (phase.kind !== "planned") return;
    const { attemptId, dispatches, expiresAt } = phase;
    // confirmApplyAttempt is one-shot — the BFF does not stream
    // per-dispatch progress while it walks the plan. Promote every
    // currently-`queued` row to `in_flight` for the duration of the
    // call so the UI surfaces "running" instead of leaving every row
    // in the pre-confirm `queued` state. The settled per-dispatch
    // states from the resolved row replace these on completion.
    const inFlight = dispatches.map((d) =>
      d.state === "queued" ? { ...d, state: "in_flight" as const } : d,
    );
    setPhase({
      kind: "executing",
      attemptId,
      dispatches: inFlight,
      expiresAt,
    });
    try {
      const result = await actionsRef.current.confirmApplyAttempt({
        attemptId,
      });
      setPhase({
        kind: "executed",
        attemptId: result.attemptId,
        dispatches: toDispatchViews(result.plannedDispatches),
        expiresAt: expiresAt,
        status: result.status,
      });
    } catch (err) {
      setPhase({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [phase]);

  const handleRetry = useCallback(
    async (dispatchId: string) => {
      if (phase.kind !== "executed") return;
      const { attemptId, dispatches, expiresAt } = phase;
      // Mark only the retried row as `in_flight` (and clear its prior
      // `lastError` so the failed-state badge does not visually shadow
      // the running state). Other dispatches keep their settled state —
      // a `failed_retryable` resume rule may advance an unrelated
      // `queued` row, but until retryDispatch resolves the row the user
      // clicked is the only one we know is currently in flight.
      const inFlight = dispatches.map((d) =>
        d.dispatchId === dispatchId
          ? { ...d, state: "in_flight" as const, lastError: null }
          : d,
      );
      setPhase({
        kind: "executing",
        attemptId,
        dispatches: inFlight,
        expiresAt,
      });
      try {
        const result = await actionsRef.current.retryDispatch({
          attemptId,
          dispatchId,
        });
        setPhase({
          kind: "executed",
          attemptId: result.attemptId,
          dispatches: toDispatchViews(result.plannedDispatches),
          expiresAt,
          status: result.status,
        });
      } catch (err) {
        setPhase({
          kind: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [phase],
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="sm:max-w-2xl"
        onEscapeKeyDown={(event) => {
          if (isExecuting) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (isExecuting) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <ApplyPreviewBody
          phase={phase}
          onRetry={handleRetry}
          onRebuild={buildPlan}
        />
        <DialogFooter>
          <ApplyPreviewFooter
            phase={phase}
            onApply={handleApply}
            onRebuild={buildPlan}
            onClose={() => onOpenChange(false)}
          />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface ApplyPreviewBodyProps {
  phase: Phase;
  onRetry: (dispatchId: string) => void;
  onRebuild: () => void;
}

function ApplyPreviewBody({
  phase,
  onRetry,
  onRebuild,
}: ApplyPreviewBodyProps) {
  const t = useTranslations("nodes.applyPreview");

  if (phase.kind === "loading") {
    return (
      <p
        className="text-sm text-muted-foreground"
        data-testid="apply-preview-loading"
      >
        {t("loading")}
      </p>
    );
  }
  if (phase.kind === "error") {
    return (
      <div
        className="space-y-2"
        role="alert"
        data-testid="apply-preview-plan-error"
      >
        <p className="text-sm font-medium text-destructive">
          {t("loadFailed")}
        </p>
        <p className="text-sm text-muted-foreground">{phase.message}</p>
        <p className="text-sm">{t("rebuildToRecover")}</p>
      </div>
    );
  }

  const isPlanned = phase.kind === "planned";
  const isExecuting = phase.kind === "executing";
  const isExecuted = phase.kind === "executed";

  const headingKey = isPlanned
    ? "plannedHeading"
    : isExecuting
      ? "executingHeading"
      : phase.status === "succeeded"
        ? "succeededHeading"
        : phase.status === "failed_terminal"
          ? "terminalHeading"
          : "retryableHeading";

  if (phase.dispatches.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">{t("noPendingChanges")}</p>
    );
  }

  return (
    <div className="space-y-3" data-testid="apply-preview-body">
      <p className="text-sm font-medium">{t(headingKey)}</p>
      {isExecuted && phase.status === "failed_terminal" && (
        <p className="text-sm" data-testid="apply-preview-terminal-guidance">
          {t("rebuildToRecover")}
        </p>
      )}
      <ul className="divide-y rounded-md border">
        {phase.dispatches.map((dispatch) => (
          <DispatchRow
            key={dispatch.dispatchId}
            dispatch={dispatch}
            isPlanned={isPlanned}
            canRetry={
              isExecuted &&
              phase.status === "failed_retryable" &&
              dispatch.state === "failed_retryable"
            }
            onRetry={() => onRetry(dispatch.dispatchId)}
          />
        ))}
      </ul>
      {isExecuted && phase.status === "failed_terminal" && (
        <Button
          type="button"
          variant="outline"
          onClick={onRebuild}
          data-testid="apply-preview-terminal-rebuild"
        >
          {t("rebuild")}
        </Button>
      )}
    </div>
  );
}

interface DispatchRowProps {
  dispatch: DispatchView;
  isPlanned: boolean;
  canRetry: boolean;
  onRetry: () => void;
}

function DispatchRow({
  dispatch,
  isPlanned,
  canRetry,
  onRetry,
}: DispatchRowProps) {
  const t = useTranslations("nodes.applyPreview");
  const kindLabel = t(`dispatchKind.${dispatch.kind}` as const);
  const stateLabel = t(`stateLabel.${dispatch.state}` as const);
  return (
    <li
      className="flex items-start justify-between gap-3 px-3 py-2"
      data-testid={`apply-preview-dispatch-${dispatch.dispatchId}`}
      data-state={dispatch.state}
    >
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium">{kindLabel}</span>
        {!isPlanned && (
          <span
            className={cn(
              "text-xs",
              dispatch.state === "failed_terminal" && "text-destructive",
              dispatch.state === "failed_retryable" && "text-amber-600",
              dispatch.state === "succeeded" && "text-emerald-600",
              dispatch.state === "in_flight" && "text-sky-600",
              dispatch.state === "queued" && "text-muted-foreground",
            )}
            data-testid={`apply-preview-dispatch-state-${dispatch.dispatchId}`}
          >
            {stateLabel}
          </span>
        )}
        {dispatch.lastError && (
          <span
            className="text-xs text-destructive"
            data-testid={`apply-preview-dispatch-error-${dispatch.dispatchId}`}
          >
            {t("errorLabel")}: {dispatch.lastError}
          </span>
        )}
      </div>
      {canRetry && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onRetry}
          aria-label={`${t("retry")} – ${kindLabel}`}
          data-testid={`apply-preview-retry-${dispatch.dispatchId}`}
        >
          {t("retry")}
        </Button>
      )}
    </li>
  );
}

interface ApplyPreviewFooterProps {
  phase: Phase;
  onApply: () => void;
  onRebuild: () => void;
  onClose: () => void;
}

function ApplyPreviewFooter({
  phase,
  onApply,
  onRebuild,
  onClose,
}: ApplyPreviewFooterProps) {
  const t = useTranslations("nodes.applyPreview");

  if (phase.kind === "loading") {
    return (
      <Button type="button" variant="outline" onClick={onClose}>
        {t("cancel")}
      </Button>
    );
  }
  if (phase.kind === "error") {
    return (
      <>
        <Button type="button" variant="outline" onClick={onClose}>
          {t("close")}
        </Button>
        <Button type="button" onClick={onRebuild}>
          {t("rebuild")}
        </Button>
      </>
    );
  }
  if (phase.kind === "planned") {
    const empty = phase.dispatches.length === 0;
    return (
      <>
        <Button type="button" variant="outline" onClick={onClose}>
          {t("cancel")}
        </Button>
        <Button
          type="button"
          onClick={onApply}
          disabled={empty}
          data-testid="apply-preview-apply"
        >
          {t("apply")}
        </Button>
      </>
    );
  }
  if (phase.kind === "executing") {
    return (
      <Button type="button" disabled data-testid="apply-preview-applying">
        {t("applying")}
      </Button>
    );
  }
  // executed
  if (phase.status === "failed_terminal") {
    return (
      <Button type="button" variant="outline" onClick={onClose}>
        {t("close")}
      </Button>
    );
  }
  if (phase.status === "failed_retryable") {
    return (
      <>
        <Button type="button" variant="outline" onClick={onClose}>
          {t("close")}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={onRebuild}
          data-testid="apply-preview-retryable-rebuild"
        >
          {t("rebuild")}
        </Button>
      </>
    );
  }
  return (
    <Button type="button" onClick={onClose} data-testid="apply-preview-done">
      {t("close")}
    </Button>
  );
}
