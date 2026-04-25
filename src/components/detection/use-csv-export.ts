"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  type SaveTarget,
  startSavePicker,
  streamResponseToHandle,
  triggerBlobDownload,
} from "@/components/detection/csv-download";
import { readCsrfToken } from "@/components/session/session-extension-dialog";
import {
  AVERAGE_CSV_ROW_BYTES,
  buildExportFilename,
  CSV_EXPORT_MAX_ROWS,
  type CsvColumnHeaders,
  type FormatCsvRowOptions,
  LARGE_EXPORT_ROW_THRESHOLD,
} from "@/lib/detection/csv-export";
import type { Filter } from "@/lib/detection/filter";

export interface CsvExportPayload {
  filter: Filter;
  periodKey: string | null;
  headers: CsvColumnHeaders;
  formatRowOptions: FormatCsvRowOptions;
}

export interface CsvExportConfirmation {
  totalCount: string;
  estimatedBytes: number;
  threshold: number;
}

export type CsvExportStatus =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "confirm-required"; confirmation: CsvExportConfirmation }
  | { kind: "error"; message: string };

interface UseCsvExportOptions {
  /**
   * Retrieves the current export payload (committed filter +
   * translated labels). Called lazily so the hook always works
   * from the latest committed state at the moment the operator
   * clicks Download, not from a stale closure.
   */
  buildPayload: () => CsvExportPayload;
  /**
   * Returns the currently displayed total row count as a decimal
   * string (or `null` if unknown — e.g. the shell has not yet
   * completed a query, or the result header hid the count because
   * of a streaming error). Called lazily at click time so the hook
   * can gate known-large and known-over-cap exports locally before
   * opening the native save picker (Reviewer Round 10). The server's
   * 409 / 413 responses remain the backstop when the local count is
   * absent or disagrees with `fetchExportRowCount`'s authoritative
   * probe.
   */
  getKnownTotalCount?: () => string | null;
  /** Localized error-state message shown when an export fails. */
  errorMessage: string;
  /**
   * Localized error-state message surfaced when the server rejects
   * the request because the estimated row count exceeds the hard
   * per-export ceiling. Receives the advertised count and limit
   * from the 413 body so the message can quote the exact figures
   * that caused the rejection.
   */
  formatLimitExceededMessage?: (args: {
    totalCount: string;
    limit: number;
  }) => string;
  /**
   * Called when the server signals a successful export. Receives
   * the total count header so the caller can surface a brief
   * "N events exported" confirmation if desired.
   */
  onSuccess?: (totalCount: string | null) => void;
}

interface UseCsvExportReturn {
  status: CsvExportStatus;
  /** Triggered by the Download CSV button. */
  start: () => void;
  /** Triggered by the confirmation dialog's Continue action. */
  confirmAndContinue: () => void;
  /** Triggered by Cancel or overlay click. */
  cancelConfirmation: () => void;
  /** Clears a surfaced error banner. */
  dismissError: () => void;
}

/** Cached across the confirmation dialog — see `confirmAndContinue`. */
interface PendingConfirmation {
  payload: CsvExportPayload;
  /**
   * `null` when the confirmation was raised by the local
   * known-large gate (Reviewer Round 10): the picker was deliberately
   * deferred so the operator sees the row-count confirmation *before*
   * any native save prompt. `confirmAndContinue` opens the picker
   * synchronously on that fresh Continue click (transient activation
   * is renewed by the button press). Non-null when the server
   * responded with `409 confirmation-required` for an export that the
   * client had expected to be small; in that case the picker was
   * already opened on the initial click and the resolved handle is
   * reused on Continue.
   */
  saveTarget: SaveTarget | null;
  /**
   * Filename decided at click time and pinned for the duration of
   * the confirmation round-trip so the Continue re-POST quotes the
   * same timestamp/summary the picker was opened with.
   */
  filename: string;
}

/**
 * Outcome of awaiting the save-picker promise started synchronously
 * in `start()`. Separating cancellation from a real picker failure
 * (`SecurityError`, permission denied, filesystem errors, etc.) is
 * the whole point of this shape — collapsing every rejection into
 * `cancelled` would hide non-Abort failures as a silent no-op
 * (Reviewer Round 8). `failed` lets the caller surface the same
 * generic export error the 500 / network branches use.
 */
type SaveOutcome = SaveTarget | { kind: "failed" };

/**
 * Detect whether an error came from `fetch`/`AbortController` after the
 * caller aborted the request. Browsers throw `DOMException` named
 * `"AbortError"`; Node-style fetches mirror that name. Anything else
 * is a real network or stream failure.
 */
function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "AbortError" ||
      (err as { code?: string }).code === "ABORT_ERR")
  );
}

/**
 * Orchestrates the CSV export round-trip on the client. Owns the
 * three user-visible phases:
 *
 *   1. The initial POST. Surfaces row counts at or above the
 *      threshold as a `confirm-required` status so the shell can
 *      render the confirmation dialog.
 *   2. The follow-up POST with `confirmedLargeExport: true` when
 *      the operator chooses Continue.
 *   3. Success — a Chromium picker handle receives the streamed
 *      body via `pipeTo`; browsers without the File System Access
 *      API fall back to a Blob anchor click.
 *
 * Activation note: when the result header's total count is below
 * the large-export threshold (or unknown), `start()` kicks off the
 * save picker **synchronously** so the browser sees
 * `showSaveFilePicker()` while transient activation from the click
 * is still alive; the picker promise then races the preflight
 * fetch. When the result header already shows a count at or above
 * the threshold, the save picker is deliberately deferred to the
 * dialog's Continue click (Reviewer Round 10) — the row-count
 * confirmation must come before any native save prompt, and
 * Continue is a fresh user gesture that renews transient
 * activation. On a server-surfaced 409 (the client's estimate
 * disagreed with the authoritative count), the handle that was
 * already opened on the initial click is cached so the Continue
 * click does not re-prompt for a save path.
 *
 * Errors from the server, network failures, and mid-stream aborts
 * all land on the `error` status with a localized message; the
 * confirmation dialog is closed on cancel without issuing any
 * further request. When the operator dismisses the native save-as
 * prompt, the hook flips back to `idle` without surfacing an error.
 */
export function useCsvExport(options: UseCsvExportOptions): UseCsvExportReturn {
  const {
    buildPayload,
    errorMessage,
    formatLimitExceededMessage,
    getKnownTotalCount,
    onSuccess,
  } = options;
  const [status, setStatus] = useState<CsvExportStatus>({ kind: "idle" });
  const [pendingConfirmation, setPendingConfirmation] =
    useState<PendingConfirmation | null>(null);
  // Tracks the AbortController for any in-flight `fetch("/api/detection/export",
  // ...)` so cancellation paths (picker dismissed / failed mid-flight,
  // confirmation cancelled while the preflight is still pending,
  // component unmount) can abort the request end-to-end. The route
  // observes the abort via `request.signal` and the export stream
  // forwards it into each `searchEvents` page request, so REview itself
  // sees the cancel and rejects the in-flight page promptly instead of
  // running it to completion (#342). Stored as a ref so the in-flight
  // controller is shared across `runExport` invocations and the
  // `cancelConfirmation` / unmount cleanup paths without going through
  // re-renders.
  const inFlightRef = useRef<AbortController | null>(null);
  const abortInFlight = useCallback(() => {
    const controller = inFlightRef.current;
    if (!controller) return;
    inFlightRef.current = null;
    try {
      controller.abort();
    } catch {
      // best-effort: AbortController.abort() never throws in practice,
      // but we don't want a stray exception here to swallow the
      // surrounding state transition.
    }
  }, []);
  // On unmount, abort any in-flight export so we don't leave the
  // server streaming pages into a tab that no longer cares about the
  // body. Without this, a tab close that happens before the response
  // body would cancel naturally still leaves the route's pagination
  // loop fetching pages until `request.signal` notices the disconnect.
  useEffect(() => () => abortInFlight(), [abortInFlight]);

  const runExport = useCallback(
    async (
      payload: CsvExportPayload,
      confirmed: boolean,
      savePromise: Promise<SaveTarget>,
      filename: string,
    ) => {
      // Await the picker exactly once. Unlike a blanket `.catch →
      // cancelled`, we keep cancellation and real failures distinct
      // so non-Abort picker errors end up on the error status
      // instead of silently returning to idle.
      const resolveSaveOutcome = (): Promise<SaveOutcome> =>
        savePromise.then<SaveOutcome, SaveOutcome>(
          (target) => target,
          (): SaveOutcome => ({ kind: "failed" }),
        );

      const csrfToken = readCsrfToken();
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (csrfToken) headers["X-CSRF-Token"] = csrfToken;

      // Abort any earlier in-flight request before starting a new one
      // so a quick double-click on Download CSV (or a Continue after a
      // 409 round-trip) does not leave an orphan fetch streaming on
      // the server.
      abortInFlight();
      const controller = new AbortController();
      inFlightRef.current = controller;

      // Watch the save-picker promise as soon as the fetch is set up
      // so a Save-As dismissal aborts the in-flight request
      // immediately, even while the row-count probe or initial REview
      // round-trip is still pending. Without this side-effect, the
      // hook only consulted the picker outcome *after* `await fetch()`
      // returned (Reviewer Round 1), so a Cancel during a slow
      // preflight let the request run to completion before we
      // noticed — defeating the manual claim that dismissing the Save
      // As dialog aborts the underlying fetch end-to-end. The latched
      // outcome lets the catch block below distinguish a picker
      // cancellation (silent return-to-idle) from a real picker
      // failure (export-failed banner), mirroring the response-path
      // branches.
      let pickerAbortReason: "cancelled" | "failed" | null = null;
      void savePromise.then(
        (target) => {
          if (target.kind === "cancelled") {
            pickerAbortReason = "cancelled";
            try {
              controller.abort();
            } catch {
              // best-effort
            }
          }
        },
        () => {
          pickerAbortReason = "failed";
          try {
            controller.abort();
          } catch {
            // best-effort
          }
        },
      );

      let response: Response;
      try {
        response = await fetch("/api/detection/export", {
          method: "POST",
          headers,
          body: JSON.stringify({
            filter: payload.filter,
            periodKey: payload.periodKey,
            headers: payload.headers,
            formatRowOptions: payload.formatRowOptions,
            confirmedLargeExport: confirmed,
            // Client-decided filename — pinned at click time so the
            // picker's suggestedName and the server's
            // Content-Disposition stay in lockstep. Reviewer Round 8:
            // without threading this through, Chromium users saved
            // the file under a static `detection-events.csv` even
            // though the route quoted a timestamped/summarized name.
            filename,
          }),
          // The signal threads cancellation end-to-end (#342): a
          // dismissed save picker, a fresh Download click that
          // supersedes this one, or unmount calls
          // `controller.abort()`, which fires the route's
          // `request.signal` and propagates into each `searchEvents`
          // page request through `graphqlRequest`. Without this the
          // browser would only signal cancellation when the body
          // stream is cancelled, leaving any in-flight REview page
          // running to completion.
          signal: controller.signal,
        });
      } catch (err) {
        void resolveSaveOutcome();
        if (controller.signal.aborted || isAbortError(err)) {
          // The fetch was aborted by us (picker dismissed, picker
          // failed, supersede, unmount). Picker cancellation and
          // supersede/unmount are not errors — return to idle. A real
          // picker failure (SecurityError, permission denial, etc.)
          // is surfaced via the latched `pickerAbortReason` so the
          // operator still sees an export-failed banner here, not a
          // silent no-op (mirrors the response-path 200 branch).
          if (inFlightRef.current === controller) inFlightRef.current = null;
          if (pickerAbortReason === "failed") {
            setStatus({ kind: "error", message: errorMessage });
          } else {
            setStatus({ kind: "idle" });
          }
          return;
        }
        if (inFlightRef.current === controller) inFlightRef.current = null;
        setStatus({ kind: "error", message: errorMessage });
        return;
      }

      // The fetch resolved with response headers — we no longer hold
      // an in-flight controller for the preflight stage. Subsequent
      // body streaming has its own cancellation path
      // (`response.body?.cancel()` / `controller.abort()` for the
      // streaming branches).
      if (inFlightRef.current === controller) inFlightRef.current = null;

      if (response.status === 409) {
        const json = (await response.json().catch(() => null)) as Record<
          string,
          unknown
        > | null;
        const saveOutcome = await resolveSaveOutcome();
        if (saveOutcome.kind === "cancelled") {
          // Operator dismissed the save-as picker — treat the whole
          // export as cancelled even though the server was about to
          // ask for confirmation.
          setStatus({ kind: "idle" });
          return;
        }
        if (saveOutcome.kind === "failed") {
          // Real picker error (SecurityError, permission denial,
          // etc.) — surface the export error instead of a silent
          // no-op.
          setStatus({ kind: "error", message: errorMessage });
          return;
        }
        if (json?.code === "confirmation-required") {
          setPendingConfirmation({
            payload,
            saveTarget: saveOutcome,
            filename,
          });
          setStatus({
            kind: "confirm-required",
            confirmation: {
              totalCount: String(json.totalCount ?? "0"),
              estimatedBytes: Number(json.estimatedBytes ?? 0),
              threshold: Number(json.threshold ?? 0),
            },
          });
          return;
        }
        setStatus({ kind: "error", message: errorMessage });
        return;
      }

      if (response.status === 413) {
        const json = (await response.json().catch(() => null)) as Record<
          string,
          unknown
        > | null;
        void resolveSaveOutcome();
        if (json?.code === "row-limit-exceeded" && formatLimitExceededMessage) {
          setPendingConfirmation(null);
          setStatus({
            kind: "error",
            message: formatLimitExceededMessage({
              totalCount: String(json.totalCount ?? "0"),
              limit: Number(json.limit ?? 0),
            }),
          });
          return;
        }
        setStatus({ kind: "error", message: errorMessage });
        return;
      }

      if (!response.ok) {
        void resolveSaveOutcome();
        setStatus({ kind: "error", message: errorMessage });
        return;
      }

      // 200 OK — stream the body to whichever save target resolved.
      const saveOutcome = await resolveSaveOutcome();
      try {
        if (saveOutcome.kind === "cancelled" || saveOutcome.kind === "failed") {
          // Aborting the fetch fires the route's `request.signal`,
          // which propagates into the export stream's pagination loop
          // and through `graphqlRequest` into REview's in-flight page
          // (#342). `response.body?.cancel()` alone only stops the
          // body once a chunk arrives; aborting the fetch ends both
          // the connection and any pending REview round-trip.
          try {
            controller.abort();
          } catch {
            // best-effort; controller.abort() never throws in
            // practice, but a stray exception here would mask the
            // surrounding state transition.
          }
          try {
            await response.body?.cancel();
          } catch {
            // best-effort; the operator has already walked away
          }
          if (saveOutcome.kind === "failed") {
            setStatus({ kind: "error", message: errorMessage });
          } else {
            setStatus({ kind: "idle" });
          }
          setPendingConfirmation(null);
          return;
        }
        if (saveOutcome.kind === "unsupported") {
          await triggerBlobDownload(response, filename);
        } else {
          await streamResponseToHandle(response, saveOutcome);
        }
        const totalCount = response.headers.get("X-Total-Count");
        setStatus({ kind: "idle" });
        setPendingConfirmation(null);
        onSuccess?.(totalCount);
      } catch (err) {
        if (controller.signal.aborted || isAbortError(err)) {
          // Body streaming was aborted by us (e.g. unmount or a
          // supersede). The download is gone — return to idle.
          setStatus({ kind: "idle" });
          setPendingConfirmation(null);
          return;
        }
        setStatus({ kind: "error", message: errorMessage });
      }
    },
    [abortInFlight, errorMessage, formatLimitExceededMessage, onSuccess],
  );

  const start = useCallback(() => {
    // The filename is pinned at click time and passed both to the
    // picker (as `suggestedName`) and to the server (which echoes
    // it in `Content-Disposition`), so the two cannot drift. Using
    // the same timestamp on both sides means the download shows a
    // meaningful `detection-events_<ts>_<summary>.csv` name even on
    // the File System Access path where the browser, not the server,
    // owns the save prompt.
    const payload = buildPayload();
    const filename = buildExportFilename(payload.filter, {
      periodKey: payload.periodKey,
    });

    // Reviewer Round 10: gate known-large and known-over-cap
    // exports on the client *before* opening the native save
    // picker. The original implementation opened the picker
    // synchronously on every click to preserve transient
    // activation, which meant a filter above the threshold
    // prompted for a save location first and then showed the
    // row-count confirmation — and an export already known to
    // exceed the hard cap still opened the picker even though the
    // server was going to reject it. Continue is a fresh user
    // gesture, so deferring `startSavePicker()` to that click
    // keeps the picker within the activation window without
    // violating the "confirm before prompting" contract. The
    // server's 409 / 413 responses remain the backstop for cases
    // where the result header's count is stale or unavailable.
    const knownCount = getKnownTotalCount?.() ?? null;
    const knownAsNumber =
      knownCount === null ? Number.NaN : Number.parseInt(knownCount, 10);
    if (Number.isFinite(knownAsNumber)) {
      if (knownAsNumber > CSV_EXPORT_MAX_ROWS) {
        // Known over-cap: surface the limit error immediately and
        // never touch the save picker. The export is rejected by
        // the route anyway, so opening the picker would only waste
        // the operator's click on a dialog whose outcome is
        // discarded.
        setPendingConfirmation(null);
        const message = formatLimitExceededMessage
          ? formatLimitExceededMessage({
              totalCount: knownCount as string,
              limit: CSV_EXPORT_MAX_ROWS,
            })
          : errorMessage;
        setStatus({ kind: "error", message });
        return;
      }
      if (knownAsNumber >= LARGE_EXPORT_ROW_THRESHOLD) {
        // Known large: raise the confirmation dialog locally with
        // the count already in hand. No preflight fetch, no
        // picker — the server's 409 round-trip is redundant when
        // the client already has the same number the server would
        // quote. `saveTarget: null` signals to
        // `confirmAndContinue` that it should open the picker on
        // the Continue click.
        setPendingConfirmation({ payload, saveTarget: null, filename });
        setStatus({
          kind: "confirm-required",
          confirmation: {
            totalCount: knownCount as string,
            estimatedBytes: knownAsNumber * AVERAGE_CSV_ROW_BYTES,
            threshold: LARGE_EXPORT_ROW_THRESHOLD,
          },
        });
        return;
      }
    }

    // Known-small (or unknown) count: open the picker
    // synchronously within the user gesture. Transient activation
    // is consumed at the moment `showSaveFilePicker()` is invoked
    // and Chromium drops activation across `await fetch()`, so the
    // picker must be kicked off here to survive the preflight
    // await. Firefox / Safari (no picker implementation) resolve
    // immediately to `unsupported` and the export drops to the
    // Blob anchor fallback on success.
    const savePromise = startSavePicker(filename);
    setStatus({ kind: "running" });
    void runExport(payload, false, savePromise, filename);
  }, [
    buildPayload,
    errorMessage,
    formatLimitExceededMessage,
    getKnownTotalCount,
    runExport,
  ]);

  const confirmAndContinue = useCallback(() => {
    const pending = pendingConfirmation;
    if (!pending) return;
    setStatus({ kind: "running" });
    // Continue is a fresh user gesture, so `showSaveFilePicker()`
    // is within transient activation when invoked here — the
    // deferred-picker path (local large-export gate) opens the
    // save prompt synchronously on this click. When the
    // confirmation was raised by the server's 409 backstop
    // (client's estimate disagreed with the authoritative count),
    // the picker was already opened on the initial click and the
    // resolved handle is replayed so the operator is not prompted
    // for a save path twice. The filename from the original click
    // is replayed in both cases so the re-POST quotes the exact
    // timestamp / summary the picker opened with.
    const savePromise =
      pending.saveTarget === null
        ? startSavePicker(pending.filename)
        : Promise.resolve(pending.saveTarget);
    void runExport(pending.payload, true, savePromise, pending.filename);
  }, [pendingConfirmation, runExport]);

  const cancelConfirmation = useCallback(() => {
    // Abort any in-flight fetch the dialog was raised over (e.g. the
    // server-surfaced 409 path, where the preflight has already
    // resolved but a body fetch could still be racing). Without this
    // a Cancel click would clear the UI while leaving the request
    // streaming on the server until it noticed the client disconnect
    // — defeating the point of cancelling.
    abortInFlight();
    setPendingConfirmation(null);
    setStatus({ kind: "idle" });
  }, [abortInFlight]);

  const dismissError = useCallback(() => {
    setStatus({ kind: "idle" });
  }, []);

  return {
    status,
    start,
    confirmAndContinue,
    cancelConfirmation,
    dismissError,
  };
}
