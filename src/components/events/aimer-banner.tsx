"use client";

import { Loader2, Send } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useId, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { AimerCustomerCandidate } from "@/lib/aimer/candidate-customers";
import { postPhase2Multipart } from "@/lib/aimer/phase2/transport.client";
import type {
  AimerIntegrationMissingReason,
  AimerIntegrationSetupStatus,
} from "@/lib/aimer/setup-status";
import { mutatingFetch } from "@/lib/csrf-client";
import type { EventLocator } from "@/lib/events/event-locator";

// ── Types ───────────────────────────────────────────────────────

interface ContextTokenResponse {
  contextTokenJws: string;
  eventsEnvelopeJws: string;
  eventsDataJson: string;
  targetUrl: string;
}

interface ContextTokenErrorBody {
  error?: string;
}

/**
 * Response shape from `POST /api/aimer/detection-send` — the
 * server-side baseline-passing probe that routes the operator's click
 * between Phase 1 (existing bridge handoff to `detection_events`) and
 * Phase 2 (single-event baseline batch direct to aimer-web). See
 * `src/app/api/aimer/detection-send/route.ts` for the routing rule.
 */
type DetectionSendResponse =
  | { route: "phase1" }
  | {
      route: "phase2";
      context_token: string;
      events_envelope: string;
      events_data: string;
      context_jti: string;
      aimer_endpoint_path: "/api/phase2/baseline/batch";
      aimer_endpoint_url: string;
      schema_version: "phase2.baseline.v1";
    };

interface Props {
  locator: EventLocator;
  candidates: AimerCustomerCandidate[];
  customerBridgeEligible: Record<number, boolean>;
  aimerSetup: AimerIntegrationSetupStatus;
}

// ── Helpers ─────────────────────────────────────────────────────

/** Build the hidden form per Sub-7.2.E §"Click flow" step 3. */
export function buildAimerHiddenForm(
  res: ContextTokenResponse,
  doc: Document,
): HTMLFormElement {
  const form = doc.createElement("form");
  form.action = res.targetUrl;
  form.method = "POST";
  form.enctype = "multipart/form-data";
  form.hidden = true;
  const fields: ReadonlyArray<readonly [string, string]> = [
    ["context_token", res.contextTokenJws],
    ["events_envelope", res.eventsEnvelopeJws],
    ["events_data", res.eventsDataJson],
  ];
  for (const [name, value] of fields) {
    const input = doc.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = value;
    form.appendChild(input);
  }
  return form;
}

// ── Component ───────────────────────────────────────────────────

export function AimerBanner({
  locator,
  candidates,
  customerBridgeEligible,
  aimerSetup,
}: Props) {
  const t = useTranslations("events.overview");

  const eligibleIds = useMemo(
    () =>
      candidates.filter((c) => customerBridgeEligible[c.id]).map((c) => c.id),
    [candidates, customerBridgeEligible],
  );

  const noCandidates = candidates.length === 0;
  const allIneligible = !noCandidates && eligibleIds.length === 0;
  const setupNotConfigured = !aimerSetup.configured;
  const disabled = noCandidates || allIneligible || setupNotConfigured;

  // Compose the disabled-state tooltip.  Order matters — the spec
  // gives the per-customer messages priority over the system-wide one
  // when both apply, so the operator sees the single concrete fix
  // first.
  let disabledTooltip: string | null = null;
  if (noCandidates) {
    disabledTooltip = t("aimerNoCustomerTooltip");
  } else if (allIneligible) {
    disabledTooltip = t("aimerCustomerIneligibleTooltip");
  } else if (setupNotConfigured) {
    disabledTooltip = t("aimerSetupTooltip");
    if (aimerSetup.missingReasons && aimerSetup.missingReasons.length > 0) {
      const reasons = aimerSetup.missingReasons
        .map((r) => formatMissingReason(t, r))
        .join(", ");
      disabledTooltip += ` ${t("aimerSetupTooltipMissing", { reasons })}`;
    }
  }

  const [modalOpen, setModalOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * Phase 2 single-event sends stay on the page (no top-level
   * navigation), so we surface a post-send disclosure locally. Per
   * #621 we only render the disclosure on the Phase 2 path: Phase 1
   * still page-navigates and the disclosure folds into the destination
   * view (option 2 of the pre-implementation UX decision — smaller
   * change, keeps the Phase 1 bridge handoff untouched).
   */
  const [phase2Sent, setPhase2Sent] = useState(false);
  // Single-customer events auto-select to keep the flow one-click; the
  // multi-customer modal must force an explicit operator choice per the
  // issue's "selection is required" requirement, so start with no
  // selection.
  const initialSelectedId =
    candidates.length === 1 ? (eligibleIds[0] ?? null) : null;
  const [selectedId, setSelectedId] = useState<number | null>(
    initialSelectedId,
  );
  const radioGroupId = useId();

  // Track the in-flight fetch so we can ignore a stale response that
  // races a modal close (the user cancels mid-flight).
  const requestIdRef = useRef(0);

  const openModal = useCallback(() => {
    setSelectedId(candidates.length === 1 ? (eligibleIds[0] ?? null) : null);
    setError(null);
    setSubmitting(false);
    setPhase2Sent(false);
    setModalOpen(true);
  }, [candidates.length, eligibleIds]);

  const closeModal = useCallback(() => {
    requestIdRef.current += 1;
    setModalOpen(false);
    setSubmitting(false);
    setError(null);
  }, []);

  /**
   * Phase 1 bridge handoff (unchanged from #441): fetch a context token
   * + envelope, build the hidden multipart form, and `form.submit()`
   * to top-level-navigate to the bridge. Kept verbatim in this branch
   * because option 2 of the §621 UX decision deliberately preserves
   * the existing page-navigation flow.
   */
  const sendPhase1 = useCallback(
    async (customerId: number, requestId: number): Promise<void> => {
      let form: HTMLFormElement | null = null;
      try {
        const res = await mutatingFetch("/api/aimer/context-token", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ locator, customerId }),
        });
        if (requestId !== requestIdRef.current) return;
        if (!res.ok) {
          const message = await translateErrorBody(t, res);
          setError(message);
          setSubmitting(false);
          return;
        }
        const payload = (await res.json()) as ContextTokenResponse;
        if (requestId !== requestIdRef.current) return;

        form = buildAimerHiddenForm(payload, document);
        document.body.appendChild(form);
        form.submit();
        // Successful submit → top-level navigation in flight.  Do NOT
        // remove the form here; some browsers treat detaching the form
        // synchronously after submit() as cancelling the request.  The
        // page is unloading anyway so the DOM will be discarded.
        form = null;
      } catch (err) {
        if (requestId !== requestIdRef.current) return;
        const message =
          err instanceof Error && err.message
            ? `${t("aimerErrorGeneric")} (${err.message})`
            : t("aimerErrorGeneric");
        setError(message);
        setSubmitting(false);
      } finally {
        if (form !== null) {
          // Failure path: form was appended but submit() threw.  Pull
          // it out so the DOM does not retain orphaned hidden inputs
          // before we render the error toast.
          form.remove();
        }
      }
    },
    [locator, t],
  );

  /**
   * Phase 2 single-event push (new in #621). The server has already
   * confirmed the event is baseline-passing and minted the multipart
   * tokens; we POST them directly to aimer-web's
   * `/api/phase2/baseline/batch` endpoint via {@link postPhase2Multipart}
   * (the same browser transport the opportunistic drain uses) and
   * render the post-send disclosure in place — no top-level
   * navigation.
   *
   * Cursor advancement is the server's call to make and the server has
   * already decided not to advance it (RFC 0002 §8 "Race vs cursor"),
   * so a re-click against the same event is idempotent on aimer-web's
   * `(baseline_version, event_key)` check.
   */
  const sendPhase2 = useCallback(
    async (
      phase2: Extract<DetectionSendResponse, { route: "phase2" }>,
      requestId: number,
    ): Promise<void> => {
      try {
        const ack = await postPhase2Multipart(
          phase2.aimer_endpoint_url,
          {
            context_token: phase2.context_token,
            events_envelope: phase2.events_envelope,
            events_data: phase2.events_data,
            context_jti: phase2.context_jti,
          },
          phase2.schema_version,
        );
        if (requestId !== requestIdRef.current) return;
        if (ack.kind !== "insert") {
          setError(t("aimerErrorGeneric"));
          setSubmitting(false);
          return;
        }
        setSubmitting(false);
        setPhase2Sent(true);
      } catch (err) {
        if (requestId !== requestIdRef.current) return;
        const message =
          err instanceof Error && err.message
            ? `${t("aimerErrorGeneric")} (${err.message})`
            : t("aimerErrorGeneric");
        setError(message);
        setSubmitting(false);
      }
    },
    [t],
  );

  const handleSend = useCallback(async () => {
    if (selectedId === null) return;
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setSubmitting(true);
    setError(null);
    setPhase2Sent(false);

    // Server-side routing decision: ask whether the event is currently
    // baseline-passing. The route also issues the Phase 2 envelope on
    // the spot when so, so the click→envelope round-trip stays
    // server-authoritative — the browser does not get to decide which
    // phase a click maps to.
    let routing: DetectionSendResponse;
    try {
      const res = await mutatingFetch("/api/aimer/detection-send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ locator, customerId: selectedId }),
      });
      if (requestId !== requestIdRef.current) return;
      if (!res.ok) {
        const message = await translateErrorBody(t, res);
        setError(message);
        setSubmitting(false);
        return;
      }
      routing = (await res.json()) as DetectionSendResponse;
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      const message =
        err instanceof Error && err.message
          ? `${t("aimerErrorGeneric")} (${err.message})`
          : t("aimerErrorGeneric");
      setError(message);
      setSubmitting(false);
      return;
    }
    if (requestId !== requestIdRef.current) return;

    if (routing.route === "phase2") {
      await sendPhase2(routing, requestId);
      return;
    }
    await sendPhase1(selectedId, requestId);
  }, [locator, selectedId, sendPhase1, sendPhase2, t]);

  const sendDisabled = submitting || selectedId === null;

  const button = (
    <Button
      type="button"
      size="sm"
      variant="outline"
      onClick={openModal}
      disabled={disabled}
      data-testid="aimer-send-button"
    >
      <Send className="size-4" aria-hidden="true" />
      {t("aimerCta")}
    </Button>
  );

  return (
    <div className="border-border bg-card flex flex-col gap-3 rounded-md border p-4">
      <div className="flex items-start gap-2">
        <Send className="mt-0.5 size-4 text-blue-500" aria-hidden="true" />
        <div className="flex-1">
          <h3 className="text-foreground text-sm font-semibold">
            {t("aimerTitle")}
          </h3>
          <p className="text-muted-foreground mt-1 text-sm">{t("aimerBody")}</p>
        </div>
      </div>
      <div>
        {disabled && disabledTooltip ? (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                {/*
                 * Disabled <button> swallows pointer events in some
                 * browsers, so wrap in a span so the tooltip still
                 * reacts on hover.
                 */}
                <span>{button}</span>
              </TooltipTrigger>
              <TooltipContent>{disabledTooltip}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : (
          button
        )}
      </div>

      <Dialog
        open={modalOpen}
        onOpenChange={(next) => {
          if (!next) closeModal();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("aimerModalTitle")}</DialogTitle>
            <DialogDescription>
              {candidates.length === 1
                ? t("aimerModalBodySingle", { name: candidates[0].name })
                : t("aimerModalBodyMulti")}
            </DialogDescription>
          </DialogHeader>

          {candidates.length > 1 ? (
            <fieldset
              className="flex flex-col gap-2"
              aria-label={t("aimerModalTitle")}
            >
              {candidates.map((c) => {
                const eligible = customerBridgeEligible[c.id] ?? false;
                const inputId = `${radioGroupId}-${c.id}`;
                return (
                  <label
                    key={c.id}
                    htmlFor={inputId}
                    className={
                      eligible
                        ? "flex items-center gap-2 text-sm"
                        : "flex items-center gap-2 text-sm text-muted-foreground"
                    }
                  >
                    <input
                      id={inputId}
                      type="radio"
                      name={radioGroupId}
                      value={c.id}
                      disabled={!eligible || submitting}
                      checked={selectedId === c.id}
                      onChange={() => setSelectedId(c.id)}
                    />
                    <span>{c.name}</span>
                    {!eligible ? (
                      <span className="text-xs italic">
                        {t("aimerModalIneligibleHint")}
                      </span>
                    ) : null}
                  </label>
                );
              })}
            </fieldset>
          ) : null}

          {error ? (
            <p
              role="alert"
              className="text-destructive text-sm"
              data-testid="aimer-error"
            >
              <span className="font-semibold">{t("aimerErrorTitle")}: </span>
              {error}
            </p>
          ) : null}

          {phase2Sent ? (
            <p
              role="status"
              className="text-sm text-emerald-700 dark:text-emerald-400"
              data-testid="aimer-sent-phase2"
            >
              {t("aimerSentPhase2")}
            </p>
          ) : null}

          <DialogFooter>
            {phase2Sent ? (
              <Button
                type="button"
                variant="outline"
                onClick={closeModal}
                data-testid="aimer-sent-dismiss"
              >
                {t("aimerSentPhase2Dismiss")}
              </Button>
            ) : (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={closeModal}
                  disabled={submitting}
                >
                  {t("aimerModalCancel")}
                </Button>
                <Button
                  type="button"
                  onClick={handleSend}
                  disabled={sendDisabled}
                  data-testid="aimer-modal-send"
                >
                  {submitting ? (
                    <Loader2
                      className="mr-2 size-4 animate-spin"
                      aria-hidden="true"
                    />
                  ) : null}
                  {submitting ? t("aimerSending") : t("aimerModalSend")}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Internal helpers ────────────────────────────────────────────

type Translator = ReturnType<typeof useTranslations>;

function formatMissingReason(
  t: Translator,
  reason: AimerIntegrationMissingReason,
): string {
  switch (reason) {
    case "aiceId":
      return t("aimerMissingReasonAiceId");
    case "bridgeUrl":
      return t("aimerMissingReasonBridgeUrl");
    case "signingKey":
      return t("aimerMissingReasonSigningKey");
  }
}

async function translateErrorBody(
  t: Translator,
  res: Response,
): Promise<string> {
  let body: ContextTokenErrorBody | null = null;
  try {
    body = (await res.json()) as ContextTokenErrorBody;
  } catch {
    body = null;
  }
  if (res.status === 429) return t("aimerErrorRateLimited");
  if (body?.error === "aimer_integration_not_configured") {
    return t("aimerErrorNotConfigured");
  }
  if (body?.error === "customer_external_key_missing") {
    return t("aimerErrorExternalKeyMissing");
  }
  if (body?.error === "event_not_found_for_customer") {
    return t("aimerErrorEventNotFound");
  }
  return t("aimerErrorGeneric");
}
