"use client";

/**
 * Apply preview modal (Phase Node-9d, #362).
 *
 * Drives the BFF apply state machine end-to-end from the operator's
 * point of view:
 *
 *   - On open, calls `createApplyAttempt({ nodeId })` and renders the
 *     returned `plannedDispatches` list before any execution. The
 *     frozen `new` payloads in those dispatches are NOT carried in
 *     client state — only `attemptId`, `dispatchId`, and the per-row
 *     `state` / `lastError` are read on subsequent updates.
 *   - On Apply, calls `confirmApplyAttempt({ attemptId })` and renders
 *     per-dispatch state from the returned row.
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
import { useCallback, useEffect, useState } from "react";

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

type Phase =
  | { kind: "loading" }
  | {
      kind: "planned";
      attemptId: string;
      plannedDispatches: PlannedDispatch[];
      expiresAt: string;
    }
  | {
      kind: "executing";
      attemptId: string;
      plannedDispatches: PlannedDispatch[];
      expiresAt: string;
      retryingDispatchId: string | null;
    }
  | {
      kind: "executed";
      attemptId: string;
      plannedDispatches: PlannedDispatch[];
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

  const buildPlan = useCallback(async () => {
    setPhase({ kind: "loading" });
    try {
      const result = await actions.createApplyAttempt({ nodeId });
      setPhase({
        kind: "planned",
        attemptId: result.attemptId,
        plannedDispatches: result.plannedDispatches,
        expiresAt: result.expiresAt,
      });
    } catch (err) {
      setPhase({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [actions, nodeId]);

  // Open / close lifecycle. Building the plan happens once per open;
  // closing wipes attemptId from client state so re-opening always
  // takes a fresh path through createApplyAttempt.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setPhase({ kind: "loading" });
    actions
      .createApplyAttempt({ nodeId })
      .then((result) => {
        if (cancelled) return;
        setPhase({
          kind: "planned",
          attemptId: result.attemptId,
          plannedDispatches: result.plannedDispatches,
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
  }, [open, nodeId, actions]);

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
    const { attemptId, plannedDispatches, expiresAt } = phase;
    setPhase({
      kind: "executing",
      attemptId,
      plannedDispatches,
      expiresAt,
      retryingDispatchId: null,
    });
    try {
      const result = await actions.confirmApplyAttempt({ attemptId });
      setPhase({
        kind: "executed",
        attemptId: result.attemptId,
        plannedDispatches: result.plannedDispatches,
        expiresAt: expiresAt,
        status: result.status,
      });
    } catch (err) {
      setPhase({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [actions, phase]);

  const handleRetry = useCallback(
    async (dispatchId: string) => {
      if (phase.kind !== "executed") return;
      const { attemptId, plannedDispatches, expiresAt } = phase;
      setPhase({
        kind: "executing",
        attemptId,
        plannedDispatches,
        expiresAt,
        retryingDispatchId: dispatchId,
      });
      try {
        const result = await actions.retryDispatch({ attemptId, dispatchId });
        setPhase({
          kind: "executed",
          attemptId: result.attemptId,
          plannedDispatches: result.plannedDispatches,
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
    [actions, phase],
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

  if (phase.plannedDispatches.length === 0) {
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
        {phase.plannedDispatches.map((dispatch) => (
          <DispatchRow
            key={dispatch.dispatchId}
            dispatch={dispatch}
            isPlanned={isPlanned}
            canRetry={
              isExecuted &&
              phase.status === "failed_retryable" &&
              dispatch.state === "failed_retryable"
            }
            isRetrying={
              isExecuting && phase.retryingDispatchId === dispatch.dispatchId
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
  dispatch: PlannedDispatch;
  isPlanned: boolean;
  canRetry: boolean;
  isRetrying: boolean;
  onRetry: () => void;
}

function DispatchRow({
  dispatch,
  isPlanned,
  canRetry,
  isRetrying,
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
          {isRetrying ? t("retrying") : t("retry")}
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
    const empty = phase.plannedDispatches.length === 0;
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
