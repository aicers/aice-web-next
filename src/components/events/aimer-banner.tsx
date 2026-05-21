"use client";

import { Loader2, Send } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

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
import type {
  AimerIntegrationMissingReason,
  AimerIntegrationSetupStatus,
} from "@/lib/aimer/setup-status";
import { mutatingFetch } from "@/lib/csrf-client";
import type { EventLocator } from "@/lib/events/event-locator";

// ── Types ───────────────────────────────────────────────────────

interface AnalyzeEnvelopeResponse {
  contextToken: string;
  eventsEnvelope: string;
  eventsData: string;
  analyzeParamsToken: string;
  targetUrl: string;
}

interface AnalyzeEnvelopeErrorBody {
  error?: string;
}

interface Props {
  locator: EventLocator;
  candidates: AimerCustomerCandidate[];
  customerBridgeEligible: Record<number, boolean>;
  aimerSetup: AimerIntegrationSetupStatus;
}

const FORCE_QUERY_PARAM = "aimerForce";

// ── Helpers ─────────────────────────────────────────────────────

/**
 * Build the hidden multipart form that the analyze-bridge flow
 * submits as a top-level navigation to aimer-web (#629). The form
 * carries the four signed fields produced by
 * `POST /api/aimer/analyze-envelope` and submits into `target` — a
 * named window the click handler pre-opened synchronously so the
 * navigation runs under the still-fresh transient user activation.
 * Defaults to `_blank` for direct callers (e.g. unit tests).
 */
export function buildAnalyzeBridgeForm(
  res: AnalyzeEnvelopeResponse,
  doc: Document,
  target: string = "_blank",
): HTMLFormElement {
  const form = doc.createElement("form");
  form.action = res.targetUrl;
  form.method = "POST";
  form.enctype = "multipart/form-data";
  form.target = target;
  form.hidden = true;
  const fields: ReadonlyArray<readonly [string, string]> = [
    ["context_token", res.contextToken],
    ["events_envelope", res.eventsEnvelope],
    ["events_data", res.eventsData],
    ["analyze_params_token", res.analyzeParamsToken],
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

function localeToLang(locale: string): "KOREAN" | "ENGLISH" {
  return locale.toLowerCase() === "ko" ? "KOREAN" : "ENGLISH";
}

// ── Component ───────────────────────────────────────────────────

export function AimerBanner({
  locator,
  candidates,
  customerBridgeEligible,
  aimerSetup,
}: Props) {
  const t = useTranslations("events.overview");
  const locale = useLocale();

  const eligibleIds = useMemo(
    () =>
      candidates.filter((c) => customerBridgeEligible[c.id]).map((c) => c.id),
    [candidates, customerBridgeEligible],
  );

  const noCandidates = candidates.length === 0;
  const allIneligible = !noCandidates && eligibleIds.length === 0;
  const setupNotConfigured = !aimerSetup.configured;
  const disabled = noCandidates || allIneligible || setupNotConfigured;

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

  const initialSelectedId =
    candidates.length === 1 ? (eligibleIds[0] ?? null) : null;
  const [selectedId, setSelectedId] = useState<number | null>(
    initialSelectedId,
  );
  const radioGroupId = useId();

  // One-shot force flag, armed by reading `?aimerForce=1` from the
  // URL on mount. Cleared after the next click consumes it (or after
  // the URL is rewritten, whichever happens first), so a manual
  // refresh of the event detail page does not silently re-force.
  const forceArmedRef = useRef(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (url.searchParams.get(FORCE_QUERY_PARAM) === "1") {
      forceArmedRef.current = true;
      url.searchParams.delete(FORCE_QUERY_PARAM);
      const next = `${url.pathname}${url.search}${url.hash}`;
      window.history.replaceState(window.history.state, "", next);
    }
  }, []);

  const requestIdRef = useRef(0);

  const openModal = useCallback(() => {
    setSelectedId(candidates.length === 1 ? (eligibleIds[0] ?? null) : null);
    setError(null);
    setSubmitting(false);
    setModalOpen(true);
  }, [candidates.length, eligibleIds]);

  const closeModal = useCallback(() => {
    requestIdRef.current += 1;
    setModalOpen(false);
    setSubmitting(false);
    setError(null);
  }, []);

  const submitAnalyzeBridge = useCallback(
    async (
      customerId: number,
      requestId: number,
      targetWindow: Window | null,
      targetName: string,
    ): Promise<void> => {
      // Consume the force flag before the fetch — the browser-side
      // arm is one-shot and must not survive a fetch failure (the
      // user can retry the click; the next click should not be
      // forced unless they re-arrive via the round-trip URL).
      const force = forceArmedRef.current;
      forceArmedRef.current = false;

      const closeReservedTab = () => {
        if (targetWindow && !targetWindow.closed) targetWindow.close();
      };

      let form: HTMLFormElement | null = null;
      try {
        const res = await mutatingFetch("/api/aimer/analyze-envelope", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            locator,
            customerId,
            lang: localeToLang(locale),
            force,
          }),
        });
        if (requestId !== requestIdRef.current) {
          closeReservedTab();
          return;
        }
        if (!res.ok) {
          const message = await translateErrorBody(t, res);
          setError(message);
          setSubmitting(false);
          closeReservedTab();
          return;
        }
        const payload = (await res.json()) as AnalyzeEnvelopeResponse;
        if (requestId !== requestIdRef.current) {
          closeReservedTab();
          return;
        }

        // Submit into the window we pre-opened from the click handler.
        // If the browser blocked or could not open the popup, fall
        // back to `_blank` — the post-await submit may still ride the
        // transient activation on lenient browsers, but the pre-open
        // is the supported path.
        const submitTarget =
          targetWindow !== null && !targetWindow.closed ? targetName : "_blank";
        form = buildAnalyzeBridgeForm(payload, document, submitTarget);
        document.body.appendChild(form);
        form.submit();
        // Deferred cleanup: the analyze-bridge submit navigates the
        // pre-opened tab (`target=<name>`) and the original tab does
        // NOT unload. Removing the form synchronously after
        // `submit()` can cancel the new tab's request on some
        // browsers (per the comment on the prior Phase 1 helper);
        // yield a full event-loop task so the navigation dispatches
        // before the node leaves the DOM.
        const submitted = form;
        setTimeout(() => {
          submitted.parentNode?.removeChild(submitted);
        }, 0);
        form = null;
        // Close the modal — the analysis tab has been opened.
        setSubmitting(false);
        setModalOpen(false);
      } catch (err) {
        if (requestId !== requestIdRef.current) {
          closeReservedTab();
          return;
        }
        const message =
          err instanceof Error && err.message
            ? `${t("aimerErrorGeneric")} (${err.message})`
            : t("aimerErrorGeneric");
        setError(message);
        setSubmitting(false);
        closeReservedTab();
      } finally {
        if (form !== null) form.remove();
      }
    },
    [locale, locator, t],
  );

  const handleSend = useCallback(() => {
    if (selectedId === null) return;
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setSubmitting(true);
    setError(null);
    // Reserve the target tab *synchronously* on the user's click so
    // popup blockers see the open under the still-fresh transient
    // activation. The mint fetch is awaited only after the window
    // exists; the form is then submitted into this window by name.
    // Without this, slow networks or stricter browser policies could
    // let the activation lapse before `form.submit()` runs and turn
    // the button into a silent no-op (#629 reviewer round 2).
    const targetName = `aimer-analyze-bridge-${requestId}`;
    const reservedTab =
      typeof window !== "undefined"
        ? window.open("about:blank", targetName)
        : null;
    void submitAnalyzeBridge(selectedId, requestId, reservedTab, targetName);
  }, [selectedId, submitAnalyzeBridge]);

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

          <DialogFooter>
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
    case "defaultModelName":
      return t("aimerMissingReasonDefaultModelName");
    case "defaultModel":
      return t("aimerMissingReasonDefaultModel");
    case "signingKey":
      return t("aimerMissingReasonSigningKey");
  }
}

async function translateErrorBody(
  t: Translator,
  res: Response,
): Promise<string> {
  let body: AnalyzeEnvelopeErrorBody | null = null;
  try {
    body = (await res.json()) as AnalyzeEnvelopeErrorBody;
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
