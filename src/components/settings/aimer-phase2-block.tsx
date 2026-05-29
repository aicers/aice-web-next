"use client";

import { AlertCircle, Loader2, PauseCircle, PlayCircle } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CADENCE_CHANGED_EVENT } from "@/components/layout/aimer-phase2-cadence-manager";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { coordinatedDrain } from "@/lib/aimer/phase2/drain-coordinator.client";
import type { DrainResult } from "@/lib/aimer/phase2/transport.client";
import { mutatingFetch } from "@/lib/csrf-client";

const STREAMING_KINDS = ["baseline_event", "story"] as const;
const BASELINE_RETENTION_DAYS = 180;
// Mirror the wrapper-route window bounds
// (src/app/api/aimer/phase2/backfill/route.ts).
const BACKFILL_FUTURE_SKEW_MS = 60_000;
const BACKFILL_RETENTION_MS = BASELINE_RETENTION_DAYS * 24 * 60 * 60 * 1000;

type StreamingKind = (typeof STREAMING_KINDS)[number];

interface StreamingPendingBreakdown {
  withdraw: number;
  refresh: number;
  backfill: number;
}

interface StreamingTrack {
  kind: StreamingKind;
  bucket: "synced" | "behind" | "way_behind" | "paused";
  approximate_count: number | null;
  cursor_lag_seconds: number | null;
  last_synced_at: string | null;
  last_error: string | null;
  pending_notice_count: number;
  pending_oldest_enqueued_at: string | null;
  pending_breakdown: StreamingPendingBreakdown;
  opportunistic_enabled: boolean;
  paused_at: string | null;
  paused_by: string | null;
  cadence_enabled: boolean;
}

interface PolicyRunTrack {
  kind: "policy_run";
  last_sent_run_id: string | null;
  last_sent_at: string | null;
  last_sent_by: string | null;
  total_runs_sent: number;
}

interface PolicyEventTrack {
  kind: "policy_event";
  pending_notice_count: number;
  pending_oldest_enqueued_at: string | null;
  last_error: string | null;
}

interface Phase2StatusDto {
  customer_id: number;
  streaming: StreamingTrack[];
  policy_run: PolicyRunTrack;
  policy_event: PolicyEventTrack;
}

type DrainKind = "baseline_event" | "story" | "policy_event";

interface DrainProgressState {
  kind: DrainKind;
  batchIndex: number;
  approxBatchesTotal: number | null;
}

interface SyncSummary {
  baseline: { delivered: number; errors: number };
  story: { delivered: number; errors: number };
  policy_event: { delivered: number; errors: number };
}

interface Phase2BlockProps {
  customers: { id: number; name: string }[];
}

const POLL_INTERVAL_MS = 8_000;
const TYPICAL_BATCH_SIZE = 25;

export function AimerPhase2Block({ customers }: Phase2BlockProps) {
  const t = useTranslations("aimerIntegration.phase2");
  const tCommon = useTranslations("common");
  const [customerId, setCustomerId] = useState<number | null>(
    customers[0]?.id ?? null,
  );
  const [status, setStatus] = useState<Phase2StatusDto | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [pendingToggle, setPendingToggle] = useState<{
    kind: StreamingKind;
    enabled: boolean;
  } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [syncProgress, setSyncProgress] = useState<DrainProgressState | null>(
    null,
  );
  const [syncSummary, setSyncSummary] = useState<SyncSummary | null>(null);
  const [message, setMessage] = useState<{
    kind: "success" | "error";
    text: string;
  } | null>(null);

  const customerIdRef = useRef(customerId);
  customerIdRef.current = customerId;

  const fetchStatus = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      const id = customerIdRef.current;
      if (id === null) return;
      try {
        setLoading(true);
        const res = await fetch(`/api/aimer/phase2/status?customer_id=${id}`, {
          signal,
          cache: "no-store",
        });
        if (!res.ok) {
          setStatusError(t("errors.loadFailed"));
          setStatus(null);
          return;
        }
        const dto = (await res.json()) as Phase2StatusDto;
        // Drop stale responses: the customer picker may have changed
        // while this request was in flight.
        if (dto.customer_id !== customerIdRef.current) return;
        setStatus(dto);
        setStatusError(null);
      } catch (err) {
        if ((err as { name?: string })?.name === "AbortError") return;
        setStatusError(t("errors.loadFailed"));
      } finally {
        setLoading(false);
      }
    },
    [t],
  );

  useEffect(() => {
    if (customerId === null) return;
    const controller = new AbortController();
    void fetchStatus(controller.signal);
    const timer = window.setInterval(() => {
      void fetchStatus();
    }, POLL_INTERVAL_MS);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [customerId, fetchStatus]);

  const onConfirmToggle = useCallback(async () => {
    if (!pendingToggle || customerId === null) return;
    const { kind, enabled } = pendingToggle;
    setBusy(`toggle:${kind}`);
    setMessage(null);
    try {
      const res = await mutatingFetch("/api/aimer/phase2/pause-toggle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customer_id: customerId, kind, enabled }),
      });
      if (!res.ok) {
        setMessage({ kind: "error", text: t("errors.actionFailed") });
        return;
      }
      await fetchStatus();
    } finally {
      setBusy(null);
      setPendingToggle(null);
    }
  }, [pendingToggle, customerId, fetchStatus, t]);

  // Single logical per-customer cadence toggle (#651). The flag lives on
  // both streaming-kind rows (the route writes them together), so either
  // row reflects the customer's consent state.
  const cadenceEnabled = useMemo(
    () => status?.streaming.some((s) => s.cadence_enabled) ?? false,
    [status],
  );

  const onToggleCadence = useCallback(
    async (enabled: boolean) => {
      if (customerId === null) return;
      setBusy("cadence");
      setMessage(null);
      try {
        const res = await mutatingFetch("/api/aimer/phase2/cadence-toggle", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ customer_id: customerId, enabled }),
        });
        if (!res.ok) {
          setMessage({ kind: "error", text: t("errors.actionFailed") });
          return;
        }
        // Tell the app-shell cadence manager (mounted in the dashboard
        // shell) to re-read its config and start/stop the controller in
        // this tab without a reload.
        window.dispatchEvent(new Event(CADENCE_CHANGED_EVENT));
        await fetchStatus();
      } finally {
        setBusy(null);
      }
    },
    [customerId, fetchStatus, t],
  );

  const visibleSyncNow = useMemo(() => {
    if (!status) return false;
    const baseline = status.streaming.find((s) => s.kind === "baseline_event");
    const story = status.streaming.find((s) => s.kind === "story");
    const policyEventPending = status.policy_event.pending_notice_count > 0;
    const anyStreamingEnabled =
      (baseline?.opportunistic_enabled ?? true) ||
      (story?.opportunistic_enabled ?? true);
    return anyStreamingEnabled || policyEventPending;
  }, [status]);

  const onSyncNow = useCallback(async () => {
    if (customerId === null) return;
    setBusy("sync_now");
    setMessage(null);
    setSyncSummary(null);
    setSyncProgress(null);
    try {
      const res = await mutatingFetch("/api/aimer/phase2/sync-now", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customer_id: customerId }),
      });
      if (!res.ok && res.status !== 204) {
        setMessage({ kind: "error", text: t("errors.actionFailed") });
        return;
      }

      // After the wrapper acks, drive the actual drain in this browser.
      // Three drains run in parallel; per-kind progress callbacks share
      // one state slot so the spinner shows the most-recent kind/batch.
      const baselineState = status?.streaming.find(
        (s) => s.kind === "baseline_event",
      );
      const storyState = status?.streaming.find((s) => s.kind === "story");
      const approxBatches = (state: StreamingTrack | undefined) =>
        state?.approximate_count !== null &&
        state?.approximate_count !== undefined
          ? Math.max(1, Math.ceil(state.approximate_count / TYPICAL_BATCH_SIZE))
          : null;
      const baselineApprox = approxBatches(baselineState);
      const storyApprox = approxBatches(storyState);

      // Route through the in-tab coordinator (#651) so a Sync now click
      // and a concurrent app-shell cadence tick for the same
      // `(kind, customer)` share one drain instead of racing. A joined
      // caller does not receive per-batch progress, so the spinner may
      // skip ahead when a cadence drain is already in flight — harmless.
      const runOne = (
        kind: DrainKind,
        approxBatchesTotal: number | null,
      ): Promise<DrainResult> =>
        coordinatedDrain(kind, customerId, {
          onProgress: (p) => {
            setSyncProgress({
              kind,
              batchIndex: p.batchIndex,
              approxBatchesTotal,
            });
          },
        });

      const [baseline, story, policyEvent] = await Promise.all([
        runOne("baseline_event", baselineApprox),
        runOne("story", storyApprox),
        runOne("policy_event", null),
      ]);

      const errorsOf = (r: DrainResult) =>
        r.stoppedReason === "error" ||
        r.stoppedReason === "max_batches" ||
        r.stoppedReason === "aborted"
          ? 1
          : 0;

      setSyncSummary({
        baseline: {
          delivered: baseline.totalDelivered,
          errors: errorsOf(baseline),
        },
        story: { delivered: story.totalDelivered, errors: errorsOf(story) },
        policy_event: {
          // For withdraw batches `totalNoOp` is aimer-web's `not_found`
          // count: those notices are still successfully ack'd and removed
          // from the queue. Counting only `totalDelivered` would report
          // "0 notices drained" for a successful drain of all-not-found
          // rows.
          delivered: policyEvent.totalDelivered + policyEvent.totalNoOp,
          errors: errorsOf(policyEvent),
        },
      });
      await fetchStatus();
    } finally {
      setBusy(null);
      setSyncProgress(null);
    }
  }, [customerId, status, fetchStatus, t]);

  if (customers.length === 0) {
    return (
      <section className="rounded-md border p-5">
        <h2 className="text-lg font-medium">{t("title")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t("description")}</p>
        <p className="mt-4 text-sm text-muted-foreground">
          {t("noCustomerSelected")}
        </p>
      </section>
    );
  }

  return (
    <section className="rounded-md border p-5" data-testid="aimer-phase2-block">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-lg font-medium">{t("title")}</h2>
          <p className="text-sm text-muted-foreground">{t("description")}</p>
        </div>
        <div className="flex items-end gap-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="aimer-phase2-customer" className="text-xs">
              {t("customerLabel")}
            </Label>
            <Select
              value={customerId !== null ? String(customerId) : undefined}
              onValueChange={(v) => setCustomerId(Number(v))}
            >
              <SelectTrigger
                id="aimer-phase2-customer"
                className="w-[240px]"
                data-testid="aimer-phase2-customer"
              >
                <SelectValue placeholder={t("customerPlaceholder")} />
              </SelectTrigger>
              <SelectContent>
                {customers.map((c) => (
                  <SelectItem key={c.id} value={String(c.id)}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={loading || customerId === null}
            onClick={() => void fetchStatus()}
          >
            {loading ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              t("refresh")
            )}
          </Button>
        </div>
      </header>

      {message && (
        <div
          className={`mt-4 flex items-center gap-2 rounded-md border px-3 py-2 text-sm ${
            message.kind === "success"
              ? "border-green-200 bg-green-50 text-green-800 dark:border-green-800 dark:bg-green-950 dark:text-green-200"
              : "border-destructive/30 bg-destructive/10 text-destructive"
          }`}
        >
          <AlertCircle className="size-4 shrink-0" />
          {message.text}
        </div>
      )}

      {statusError && (
        <div className="mt-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {statusError}
        </div>
      )}

      {status && (
        <div className="mt-4 space-y-3" data-testid="aimer-phase2-tracks">
          {status.streaming.map((track) => (
            <StreamingTrackRow
              key={track.kind}
              track={track}
              busy={busy === `toggle:${track.kind}`}
              onTogglePause={() =>
                setPendingToggle({
                  kind: track.kind,
                  enabled: !track.opportunistic_enabled,
                })
              }
            />
          ))}
          <PolicyRunTrackRow track={status.policy_run} />
          <PolicyEventTrackRow track={status.policy_event} />
        </div>
      )}

      {status && customerId !== null && (
        <div className="mt-5 rounded-md border border-dashed p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-1">
              <Label
                htmlFor="aimer-phase2-cadence"
                className="text-sm font-medium"
              >
                {t("cadence.label")}
              </Label>
              <p className="text-xs text-muted-foreground">
                {t("cadence.description")}
              </p>
            </div>
            <Switch
              id="aimer-phase2-cadence"
              data-testid="aimer-phase2-cadence-toggle"
              checked={cadenceEnabled}
              disabled={busy === "cadence"}
              onCheckedChange={(v) => void onToggleCadence(v)}
            />
          </div>
        </div>
      )}

      {visibleSyncNow && (
        <div className="mt-5 space-y-2 rounded-md border border-dashed p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium">{t("syncNow.button")}</p>
              <p className="text-xs text-muted-foreground">
                {t("syncNow.auditNote")}
              </p>
            </div>
            <Button
              type="button"
              data-testid="aimer-phase2-sync-now"
              disabled={busy === "sync_now" || customerId === null}
              onClick={() => void onSyncNow()}
            >
              {busy === "sync_now" ? (
                <span className="inline-flex items-center gap-2">
                  <Loader2 className="size-4 animate-spin" />
                  {t("syncNow.running")}
                </span>
              ) : (
                t("syncNow.button")
              )}
            </Button>
          </div>
          {syncProgress && (
            <p className="text-xs text-muted-foreground">
              {t("syncNow.progress", {
                // `drainOpportunisticPushQueue` increments `batchIndex`
                // before firing `onProgress`, so the first callback
                // delivers `1`. Render the value as-is — Round 2 review
                // flagged that the previous `+ 1` made every drain
                // start at "batch 2 of ~M".
                kind: t(`kindLabel.${syncProgress.kind}`),
                batch: syncProgress.batchIndex,
                total: syncProgress.approxBatchesTotal ?? "?",
              })}
            </p>
          )}
          {syncSummary && (
            <p
              className="text-xs text-muted-foreground"
              data-testid="aimer-phase2-sync-summary"
            >
              {t("syncNow.summary", {
                baseline: syncSummary.baseline.delivered,
                story: syncSummary.story.delivered,
                policy: syncSummary.policy_event.delivered,
                errors:
                  syncSummary.baseline.errors +
                  syncSummary.story.errors +
                  syncSummary.policy_event.errors,
              })}
            </p>
          )}
        </div>
      )}

      {customerId !== null && (
        <BackfillForm
          customerId={customerId}
          onSuccess={(count) => {
            setMessage({
              kind: "success",
              text: t("backfill.success", { count }),
            });
            void fetchStatus();
          }}
          onError={() =>
            setMessage({ kind: "error", text: t("errors.actionFailed") })
          }
        />
      )}

      <AlertDialog
        open={pendingToggle !== null}
        onOpenChange={(o) => !o && setPendingToggle(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingToggle
                ? pendingToggle.enabled
                  ? t("resumeConfirm.title", {
                      kind: t(`kindLabel.${pendingToggle.kind}`),
                    })
                  : t("pauseConfirm.title", {
                      kind: t(`kindLabel.${pendingToggle.kind}`),
                    })
                : ""}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingToggle?.enabled
                ? t("resumeConfirm.body")
                : t("pauseConfirm.body")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy?.startsWith("toggle:")}>
              {tCommon("cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={busy?.startsWith("toggle:")}
              onClick={(e) => {
                e.preventDefault();
                void onConfirmToggle();
              }}
            >
              {pendingToggle?.enabled
                ? t("resumeConfirm.confirm")
                : t("pauseConfirm.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function StreamingTrackRow({
  track,
  busy,
  onTogglePause,
}: {
  track: StreamingTrack;
  busy: boolean;
  onTogglePause: () => void;
}) {
  const t = useTranslations("aimerIntegration.phase2");
  const tCommon = useTranslations("common");
  return (
    <div
      className="rounded-md border p-3"
      data-testid={`aimer-phase2-track-${track.kind}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="space-y-1">
          <p className="text-sm font-medium">{t(`kindLabel.${track.kind}`)}</p>
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <BucketDot bucket={track.bucket} />
            <span data-testid={`aimer-phase2-bucket-${track.kind}`}>
              {t(`bucket.${track.bucket}`)}
            </span>
            <span>·</span>
            <span>
              {track.last_synced_at
                ? t("lastSynced", {
                    time: relativeTime(track.last_synced_at, tCommon),
                  })
                : t("lastSyncedNever")}
            </span>
          </p>
          <p className="text-xs text-muted-foreground">
            {describeBacklog(track, t, tCommon)}
          </p>
          {track.pending_notice_count > 0 && (
            <div className="text-xs text-muted-foreground">
              <p
                className="flex flex-wrap items-baseline gap-x-2 gap-y-1"
                data-testid={`aimer-phase2-pending-${track.kind}`}
              >
                <span>
                  {t("pendingNotices", { count: track.pending_notice_count })}
                </span>
                {track.pending_oldest_enqueued_at && (
                  <span
                    data-testid={`aimer-phase2-pending-oldest-${track.kind}`}
                  >
                    {t("pendingOldest", {
                      duration: elapsedDuration(
                        track.pending_oldest_enqueued_at,
                        tCommon,
                      ),
                    })}
                  </span>
                )}
              </p>
              <div className="mt-1 flex flex-wrap gap-1">
                {track.pending_breakdown.withdraw > 0 && (
                  <NoticeBadge
                    tone="withdraw"
                    label={t("pendingBadge.withdraw", {
                      count: track.pending_breakdown.withdraw,
                    })}
                  />
                )}
                {track.pending_breakdown.refresh > 0 && (
                  <NoticeBadge
                    tone="refresh"
                    label={t("pendingBadge.refresh", {
                      count: track.pending_breakdown.refresh,
                    })}
                  />
                )}
                {track.pending_breakdown.backfill > 0 && (
                  <NoticeBadge
                    tone="backfill"
                    label={t("pendingBadge.backfill", {
                      count: track.pending_breakdown.backfill,
                    })}
                  />
                )}
              </div>
            </div>
          )}
          {track.last_error && (
            <p className="text-xs text-destructive">
              {t("lastError", { message: track.last_error })}
            </p>
          )}
          {!track.opportunistic_enabled && track.paused_at && (
            <p className="text-xs text-muted-foreground">
              {track.paused_by
                ? t("pausedBadge", {
                    duration: elapsedDuration(track.paused_at, tCommon),
                    actor: track.paused_by,
                  })
                : t("pausedBadgeUnknownActor", {
                    duration: elapsedDuration(track.paused_at, tCommon),
                  })}
            </p>
          )}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={onTogglePause}
          data-testid={`aimer-phase2-toggle-${track.kind}`}
        >
          {busy ? (
            <Loader2 className="size-4 animate-spin" />
          ) : track.opportunistic_enabled ? (
            <span className="inline-flex items-center gap-1.5">
              <PauseCircle className="size-4" />
              {t("pause")}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5">
              <PlayCircle className="size-4" />
              {t("resume")}
            </span>
          )}
        </Button>
      </div>
    </div>
  );
}

function PolicyRunTrackRow({ track }: { track: PolicyRunTrack }) {
  const t = useTranslations("aimerIntegration.phase2");
  const tCommon = useTranslations("common");
  return (
    <div
      className="rounded-md border p-3"
      data-testid="aimer-phase2-track-policy_run"
    >
      <p className="text-sm font-medium">{t("kindLabel.policy_run")}</p>
      <p className="mt-1 text-xs text-muted-foreground">
        {track.last_sent_at
          ? t("policyRun.lastSentRun", {
              runId: track.last_sent_run_id ?? "?",
              time: relativeTime(track.last_sent_at, tCommon),
            })
          : t("policyRun.lastSentRunNever")}
      </p>
      <p className="text-xs text-muted-foreground">
        {t("policyRun.totalRunsSent", { count: track.total_runs_sent })}
      </p>
    </div>
  );
}

function PolicyEventTrackRow({ track }: { track: PolicyEventTrack }) {
  const t = useTranslations("aimerIntegration.phase2");
  const tCommon = useTranslations("common");
  return (
    <div
      className="rounded-md border p-3"
      data-testid="aimer-phase2-track-policy_event"
    >
      <p className="text-sm font-medium">{t("kindLabel.policy_event")}</p>
      <p
        className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs text-muted-foreground"
        data-testid="aimer-phase2-pending-policy_event"
      >
        <span>
          {track.pending_notice_count > 0
            ? t("policyEvent.pending", { count: track.pending_notice_count })
            : t("policyEvent.noPending")}
        </span>
        {track.pending_notice_count > 0 && track.pending_oldest_enqueued_at && (
          <span data-testid="aimer-phase2-pending-oldest-policy_event">
            {t("pendingOldest", {
              duration: elapsedDuration(
                track.pending_oldest_enqueued_at,
                tCommon,
              ),
            })}
          </span>
        )}
      </p>
      {track.pending_notice_count > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          <NoticeBadge
            tone="withdraw"
            label={t("pendingBadge.withdraw", {
              count: track.pending_notice_count,
            })}
          />
        </div>
      )}
      {track.last_error && (
        <p className="text-xs text-destructive">
          {t("lastError", { message: track.last_error })}
        </p>
      )}
    </div>
  );
}

function BackfillForm({
  customerId,
  onSuccess,
  onError,
}: {
  customerId: number;
  onSuccess: (count: number) => void;
  onError: () => void;
}) {
  const t = useTranslations("aimerIntegration.phase2");
  const tCommon = useTranslations("common");
  const [kind, setKind] = useState<"baseline_event" | "story">(
    "baseline_event",
  );
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const hasWindowError = useMemo(() => {
    if (!from || !to) return false;
    const fromMs = new Date(from).getTime();
    const toMs = new Date(to).getTime();
    if (Number.isNaN(fromMs) || Number.isNaN(toMs)) return true;
    if (fromMs >= toMs) return true;
    const nowMs = Date.now();
    if (toMs > nowMs + BACKFILL_FUTURE_SKEW_MS) return true;
    if (fromMs < nowMs - BACKFILL_RETENTION_MS) return true;
    return false;
  }, [from, to]);
  const canSubmit = Boolean(from) && Boolean(to) && !hasWindowError;

  const submit = async () => {
    setBusy(true);
    try {
      const res = await mutatingFetch("/api/aimer/phase2/backfill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customer_id: customerId,
          kind,
          from: new Date(from).toISOString(),
          to: new Date(to).toISOString(),
        }),
      });
      if (!res.ok) {
        onError();
        return;
      }
      const body = (await res.json()) as { enqueued_notice_ids: string[] };
      onSuccess(body.enqueued_notice_ids.length);
      setFrom("");
      setTo("");
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  return (
    <div className="mt-5 rounded-md border border-dashed p-4">
      <p className="text-sm font-medium">{t("backfill.title")}</p>
      <p className="mt-1 text-xs text-muted-foreground">
        {t("backfill.description", { retention: BASELINE_RETENTION_DAYS })}
      </p>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="space-y-1.5">
          <Label className="text-xs">{t("backfill.kindLabel")}</Label>
          <Select
            value={kind}
            onValueChange={(v) => setKind(v as "baseline_event" | "story")}
          >
            <SelectTrigger data-testid="aimer-phase2-backfill-kind">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="baseline_event">
                {t("kindLabel.baseline_event")}
              </SelectItem>
              <SelectItem value="story">{t("kindLabel.story")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs" htmlFor="aimer-phase2-backfill-from">
            {t("backfill.fromLabel")}
          </Label>
          <Input
            id="aimer-phase2-backfill-from"
            data-testid="aimer-phase2-backfill-from"
            type="datetime-local"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs" htmlFor="aimer-phase2-backfill-to">
            {t("backfill.toLabel")}
          </Label>
          <Input
            id="aimer-phase2-backfill-to"
            data-testid="aimer-phase2-backfill-to"
            type="datetime-local"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </div>
      </div>
      {hasWindowError && (
        <p
          className="mt-2 text-xs text-destructive"
          data-testid="aimer-phase2-backfill-window-error"
        >
          {t("backfill.errorWindow", { retention: BASELINE_RETENTION_DAYS })}
        </p>
      )}
      <div className="mt-3 flex justify-end">
        <Button
          type="button"
          data-testid="aimer-phase2-backfill-submit"
          disabled={!canSubmit || busy}
          onClick={() => setConfirming(true)}
        >
          {busy ? t("backfill.submitting") : t("backfill.submit")}
        </Button>
      </div>

      <AlertDialog
        open={confirming}
        onOpenChange={(o) => !o && setConfirming(false)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("backfill.confirm.title", {
                kind: t(`kindLabel.${kind}`),
                from,
                to,
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("backfill.confirm.body")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>
              {tCommon("cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(e) => {
                e.preventDefault();
                void submit();
              }}
            >
              {t("backfill.confirm.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function NoticeBadge({
  tone,
  label,
}: {
  tone: "withdraw" | "refresh" | "backfill";
  label: string;
}) {
  // Withdraw is a real ingest gap (ranks first in severity); refresh /
  // backfill are operator-initiated catch-up work and use cooler tones
  // so the eye lands on withdraws first when both are present.
  const className =
    tone === "withdraw"
      ? "border-amber-300 bg-amber-100 text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200"
      : tone === "refresh"
        ? "border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-200"
        : "border-slate-200 bg-slate-50 text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200";
  return (
    <span
      data-testid={`aimer-phase2-pending-badge-${tone}`}
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${className}`}
    >
      {label}
    </span>
  );
}

function BucketDot({
  bucket,
}: {
  bucket: "synced" | "behind" | "way_behind" | "paused";
}) {
  const color =
    bucket === "synced"
      ? "bg-green-500"
      : bucket === "behind"
        ? "bg-yellow-500"
        : bucket === "way_behind"
          ? "bg-red-500"
          : "bg-muted-foreground";
  return <span className={`inline-block size-2 rounded-full ${color}`} />;
}

function describeBacklog(
  track: StreamingTrack,
  t: ReturnType<typeof useTranslations<"aimerIntegration.phase2">>,
  tCommon: ReturnType<typeof useTranslations<"common">>,
): string {
  if (track.bucket === "synced") {
    return t("approxBacklogCaughtUp");
  }
  // For `paused`, the bucket label "Paused" is rendered alongside this
  // line; we show the actual backlog so the operator can tell how far
  // behind a paused stream is. Falling back to "Caught up" here would
  // hide hours of accumulated unsent events.
  const lag = track.cursor_lag_seconds;
  if (
    track.bucket === "paused" &&
    lag === null &&
    track.approximate_count === null
  ) {
    return t("approxBacklogUnavailable");
  }
  const lagText = lag === null ? "?" : formatDuration(lag, tCommon);
  if (track.approximate_count !== null && track.approximate_count > 0) {
    return t("approxBacklog", {
      count: track.approximate_count,
      lag: lagText,
    });
  }
  return t("approxBacklogLagOnly", { lag: lagText });
}

/**
 * Localized duration formatter (no "ago" suffix). Use this when the
 * surrounding template already provides a temporal word like "old" /
 * "경과" / "전", to avoid double-marking ("Paused 5m ago ago by …",
 * "(oldest 5m ago old)") that Round 2 review flagged.
 */
function formatDuration(
  seconds: number,
  tCommon: ReturnType<typeof useTranslations<"common">>,
): string {
  if (seconds < 60) return tCommon("duration.seconds", { n: seconds });
  if (seconds < 3600) {
    return tCommon("duration.minutes", { n: Math.floor(seconds / 60) });
  }
  if (seconds < 86400) {
    return tCommon("duration.hours", { n: Math.floor(seconds / 3600) });
  }
  return tCommon("duration.days", { n: Math.floor(seconds / 86400) });
}

/**
 * Fully-localized "X ago" / "X 전" string. Use this when the
 * surrounding template does NOT supply a temporal word of its own
 * (e.g. `lastSynced: "Last synced {time}"`). Sub-minute elapsed
 * windows collapse to the locale's "just now" copy.
 */
function relativeTime(
  iso: string,
  tCommon: ReturnType<typeof useTranslations<"common">>,
): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return iso;
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return tCommon("relativeTime.justNow");
  if (seconds < 3600) {
    return tCommon("relativeTime.minutes", { n: Math.floor(seconds / 60) });
  }
  if (seconds < 86400) {
    return tCommon("relativeTime.hours", { n: Math.floor(seconds / 3600) });
  }
  return tCommon("relativeTime.days", { n: Math.floor(seconds / 86400) });
}

/**
 * Duration since `iso` formatted as a bare duration (no "ago"). Pairs
 * with `pendingOldest` / `pausedBadge` templates that already carry
 * the temporal word.
 */
function elapsedDuration(
  iso: string,
  tCommon: ReturnType<typeof useTranslations<"common">>,
): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return iso;
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return formatDuration(seconds, tCommon);
}
