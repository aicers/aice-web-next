/**
 * Phase 2 push runtime (browser side) per RFC 0002 §7.
 *
 * Three primitives:
 *
 *   - {@link postPhase2Multipart} — single-shot transport. Builds the
 *     `multipart/form-data` body, POSTs once, returns the discriminated
 *     ack on 2xx, throws a structured error on anything else. No retry.
 *   - {@link drainOpportunisticPushQueue} — drain loop. Calls
 *     `<kind>/next-batch` repeatedly, threads `acked_context_jti` on
 *     success and `failed_context_jti` on transient failure (with
 *     bounded retries + backoff), stops on permanent 4xx (after one
 *     cleanup call whose response body is discarded).
 *   - {@link createPeriodicDrain} — visibility-aware timer that fires
 *     {@link drainOpportunisticPushQueue} on `start()`, then every
 *     `intervalMs`. Pauses on `visibilitychange` → hidden, single-flight
 *     (skips overlapping intervals).
 *
 * This module is client-only. It deliberately imports only from
 * {@link ./wire-types}, which has no `server-only` import, so the
 * Next.js build boundary cannot misfire on type-elision.
 */

import type {
  Phase2NextBatchResponse,
  Phase2PushTokens,
  Phase2SchemaVersion,
} from "./wire-types";

// ── Constants ──────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BATCHES_PER_ACTIVATION = 100;
const DEFAULT_RETRIES_PER_BATCH = 3;
const DEFAULT_BACKOFF_MS: readonly number[] = [1_000, 3_000, 9_000];
const DEFAULT_INTERVAL_MS = 5 * 60 * 1_000;

// ── postPhase2Multipart ────────────────────────────────────────────

export interface Phase2PushOptions {
  /** Bounded request timeout. Default 30s. */
  timeoutMs?: number;
  /** Caller-supplied abort signal (tab navigation / unmount). */
  signal?: AbortSignal;
}

/**
 * Discriminated union over the aimer-web ack shapes (RFC 0002 §6.x).
 * Insert-style endpoints (`baseline`, `story`, `policy_run`,
 * `refresh_window`, `backfill`) return
 * `{ accepted, duplicates_skipped, ... }`; withdraw returns
 * `{ withdrawn, not_found, ... }`. The discriminator is the
 * envelope's `schema_version` claim, surfaced on the `next-batch`
 * response.
 */
export type Phase2PushResult =
  | {
      kind: "insert";
      accepted: number;
      duplicatesSkipped: number;
      deleted?: number;
      receivedAt: string;
      contextJti: string;
    }
  | {
      kind: "withdraw";
      withdrawn: number;
      notFound: number;
      receivedAt: string;
      contextJti: string;
    };

export type Phase2PushErrorKind =
  | "transport"
  | "http"
  | "timeout"
  | "aborted"
  | "schema";

export class Phase2PushError extends Error {
  readonly kind: Phase2PushErrorKind;
  readonly contextJti: string;
  readonly status?: number;
  readonly body?: string;

  constructor(args: {
    kind: Phase2PushErrorKind;
    message: string;
    contextJti: string;
    status?: number;
    body?: string;
    cause?: unknown;
  }) {
    super(args.message, args.cause ? { cause: args.cause } : undefined);
    this.name = "Phase2PushError";
    this.kind = args.kind;
    this.contextJti = args.contextJti;
    this.status = args.status;
    this.body = args.body;
  }
}

function isInsertSchema(schemaVersion: Phase2SchemaVersion): boolean {
  return schemaVersion !== "phase2.withdraw.v1";
}

function parsePushResult(
  schemaVersion: Phase2SchemaVersion,
  contextJti: string,
  body: unknown,
): Phase2PushResult {
  if (body === null || typeof body !== "object") {
    throw new Phase2PushError({
      kind: "schema",
      message: "aimer-web response was not a JSON object",
      contextJti,
    });
  }
  const o = body as Record<string, unknown>;
  const receivedAt = typeof o.received_at === "string" ? o.received_at : "";
  const ackJti =
    typeof o.context_jti === "string" && o.context_jti.length > 0
      ? o.context_jti
      : contextJti;

  if (isInsertSchema(schemaVersion)) {
    if (
      typeof o.accepted !== "number" ||
      typeof o.duplicates_skipped !== "number"
    ) {
      throw new Phase2PushError({
        kind: "schema",
        message:
          "aimer-web insert ack missing required fields (accepted, duplicates_skipped)",
        contextJti,
      });
    }
    const result: Phase2PushResult = {
      kind: "insert",
      accepted: o.accepted,
      duplicatesSkipped: o.duplicates_skipped,
      receivedAt,
      contextJti: ackJti,
    };
    if (typeof o.deleted === "number") {
      result.deleted = o.deleted;
    }
    return result;
  }

  if (typeof o.withdrawn !== "number" || typeof o.not_found !== "number") {
    throw new Phase2PushError({
      kind: "schema",
      message:
        "aimer-web withdraw ack missing required fields (withdrawn, not_found)",
      contextJti,
    });
  }
  return {
    kind: "withdraw",
    withdrawn: o.withdrawn,
    notFound: o.not_found,
    receivedAt,
    contextJti: ackJti,
  };
}

function buildMultipartBody(tokens: Phase2PushTokens): FormData {
  const fd = new FormData();
  fd.append("context_token", tokens.context_token);
  fd.append("events_envelope", tokens.events_envelope);
  // RFC 0002 §6.1: `events_data` must be sent with
  // `Content-Type: application/json; charset=utf-8` so the receiver
  // does not have to guess.
  fd.append(
    "events_data",
    new Blob([tokens.events_data], {
      type: "application/json; charset=utf-8",
    }),
    "events_data.json",
  );
  return fd;
}

/**
 * Single-shot Phase 2 push to aimer-web. Per RFC 0002 §6.1 the
 * envelope's `jti` is single-use, so retry must happen *outside* this
 * function (the drain helper recycles tokens by minting a fresh batch).
 */
export async function postPhase2Multipart(
  aimerEndpointUrl: string,
  tokens: Phase2PushTokens,
  schemaVersion: Phase2SchemaVersion,
  options: Phase2PushOptions = {},
): Promise<Phase2PushResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const contextJti = tokens.context_jti;

  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => {
    timeoutController.abort();
  }, timeoutMs);
  const onCallerAbort = () => {
    timeoutController.abort();
  };
  if (options.signal) {
    if (options.signal.aborted) {
      clearTimeout(timeoutId);
      throw new Phase2PushError({
        kind: "aborted",
        message: "push aborted before start",
        contextJti,
      });
    }
    options.signal.addEventListener("abort", onCallerAbort, { once: true });
  }

  let response: Response;
  try {
    response = await fetch(aimerEndpointUrl, {
      method: "POST",
      body: buildMultipartBody(tokens),
      signal: timeoutController.signal,
      // The aimer-web bridge is a different origin; the multipart
      // request is preflight-safe (the only custom header is
      // `Content-Type` set automatically by FormData) and aimer-web
      // does not rely on cookies for auth.
      credentials: "omit",
      mode: "cors",
    });
  } catch (err) {
    // Distinguish caller abort vs timeout vs network failure.
    if (options.signal?.aborted) {
      throw new Phase2PushError({
        kind: "aborted",
        message: "push aborted by caller",
        contextJti,
        cause: err,
      });
    }
    if (timeoutController.signal.aborted) {
      throw new Phase2PushError({
        kind: "timeout",
        message: `push timed out after ${timeoutMs}ms`,
        contextJti,
        cause: err,
      });
    }
    throw new Phase2PushError({
      kind: "transport",
      message: err instanceof Error ? err.message : "network error during push",
      contextJti,
      cause: err,
    });
  } finally {
    clearTimeout(timeoutId);
    if (options.signal) {
      options.signal.removeEventListener("abort", onCallerAbort);
    }
  }

  if (!response.ok) {
    let bodyText = "";
    try {
      bodyText = await response.text();
    } catch {
      // Ignore — the status code is the primary signal.
    }
    throw new Phase2PushError({
      kind: "http",
      message: `aimer-web responded ${response.status}`,
      contextJti,
      status: response.status,
      body: bodyText,
    });
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (err) {
    throw new Phase2PushError({
      kind: "schema",
      message: "aimer-web response was not valid JSON",
      contextJti,
      cause: err,
    });
  }

  return parsePushResult(schemaVersion, contextJti, parsed);
}

// ── drainOpportunisticPushQueue ────────────────────────────────────

export type Phase2DrainKind = "baseline_event" | "story" | "policy_event";

export interface DrainBatchProgress {
  batchIndex: number;
  delivered: number;
  noOp: number;
  hasMore: boolean;
}

export interface DrainOptions {
  signal?: AbortSignal;
  onProgress?: (batch: DrainBatchProgress) => void;
  /** Safety bound on consecutive batches. Default 100. */
  maxBatchesPerActivation?: number;
  /** Forwarded to {@link postPhase2Multipart}. Default 30s. */
  timeoutMs?: number;
  /** Bounded retries per batch on transient failure. Default 3. */
  retriesPerBatch?: number;
  /** Backoff schedule between retries. Default [1000, 3000, 9000]. */
  backoffMs?: number[];
}

export type DrainStoppedReason =
  | "exhausted"
  | "no_more"
  | "error"
  | "aborted"
  | "max_batches"
  | "paused";

export interface DrainResult {
  batchesAttempted: number;
  batchesSucceeded: number;
  totalDelivered: number;
  totalNoOp: number;
  stoppedReason: DrainStoppedReason;
  lastError?: Phase2PushError;
}

const KIND_TO_PATH: Record<Phase2DrainKind, string> = {
  baseline_event: "baseline-event",
  story: "story",
  policy_event: "policy-event",
};

interface NextBatchRequest {
  customerId: number;
  acked_context_jti?: string;
  failed_context_jti?: string;
  failure_reason?: string;
}

async function postNextBatch(
  kind: Phase2DrainKind,
  body: NextBatchRequest,
  signal: AbortSignal,
): Promise<Phase2NextBatchResponse> {
  const path = `/api/aimer/phase2/${KIND_TO_PATH[kind]}/next-batch`;
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
    credentials: "same-origin",
  });
  if (!res.ok) {
    throw new Error(`${path} responded ${res.status}`);
  }
  return (await res.json()) as Phase2NextBatchResponse;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    const id = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(id);
      reject(new DOMException("aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function isPermanentHttp(err: Phase2PushError): boolean {
  if (err.kind !== "http") return false;
  if (err.status === undefined) return false;
  if (err.status === 429) return false;
  return err.status >= 400 && err.status < 500;
}

function failureReasonOf(err: Phase2PushError): string {
  if (err.status !== undefined) {
    return `${err.kind}_${err.status}`;
  }
  return err.kind;
}

function tokensFromResponse(
  response: Phase2NextBatchResponse,
): Phase2PushTokens | null {
  if (
    !response.context_token ||
    !response.events_envelope ||
    response.events_data === null ||
    !response.context_jti
  ) {
    return null;
  }
  return {
    context_token: response.context_token,
    events_envelope: response.events_envelope,
    events_data: response.events_data,
    context_jti: response.context_jti,
  };
}

/**
 * Drain the opportunistic push queue for `kind` on `customerId`.
 *
 * The loop alternates `next-batch` ↔ `postPhase2Multipart`. Each
 * iteration is exactly one push attempt against a freshly minted
 * batch — RFC 0002 §6.1 binds the envelope `jti` to a single use, so
 * "retry" means looping back through `next-batch` (which threads
 * `failed_context_jti`, claims the same un-acked queue rows, and signs
 * a fresh envelope), not re-POSTing the same multipart payload.
 *
 *   - On 2xx ack: thread `acked_context_jti` on the next `next-batch`.
 *   - On transient transport failure (5xx / network / timeout / 429):
 *     thread `failed_context_jti` + `failure_reason` on the next
 *     iteration's `next-batch` (mints fresh tokens) and try again, up
 *     to `retriesPerBatch` consecutive failures. Each retry waits
 *     `backoffMs[consecutiveFailures - 1]` before the next-batch call.
 *   - On permanent 4xx (not 429): thread `failed_context_jti` once for
 *     cleanup and stop. The cleanup call's response body is discarded
 *     — the server, not knowing the client is stopping, will hand out
 *     a fresh batch we deliberately do not deliver.
 *   - On clean abort: return `aborted` and do NOT thread
 *     `failed_context_jti` (TTL handles inflight cleanup).
 *   - On `paused: true` from the server: return `paused`.
 *   - On `has_more: false` with no work: return `no_more` (or
 *     `exhausted` if we previously delivered at least one batch).
 */
export async function drainOpportunisticPushQueue(
  kind: Phase2DrainKind,
  customerId: number,
  options: DrainOptions = {},
): Promise<DrainResult> {
  const maxBatches =
    options.maxBatchesPerActivation ?? DEFAULT_MAX_BATCHES_PER_ACTIVATION;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retriesPerBatch = options.retriesPerBatch ?? DEFAULT_RETRIES_PER_BATCH;
  const backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;

  const externalSignal = options.signal;
  const localController = new AbortController();
  const onExternalAbort = () => {
    localController.abort();
  };
  if (externalSignal) {
    if (externalSignal.aborted) {
      localController.abort();
    } else {
      externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }
  }
  const signal = localController.signal;

  const result: DrainResult = {
    batchesAttempted: 0,
    batchesSucceeded: 0,
    totalDelivered: 0,
    totalNoOp: 0,
    stoppedReason: "no_more",
  };

  // Carries the outcome of the previous batch to the next `next-batch`
  // call. Exactly one of these fields is set at a time.
  let pendingAck: string | undefined;
  let pendingFailure: { contextJti: string; reason: string } | undefined;

  let batchIndex = 0;
  let hasDelivered = false;
  let consecutiveFailures = 0;

  const sendCleanup = async (failure: {
    contextJti: string;
    reason: string;
  }): Promise<void> => {
    // Best-effort: the inflight TTL prune is the backstop if this call
    // also fails. The cleanup response body is intentionally ignored —
    // the server may have already re-claimed the next un-acked rows
    // and signed a fresh batch, but we are stopping and must not
    // deliver it.
    try {
      await postNextBatch(
        kind,
        {
          customerId,
          failed_context_jti: failure.contextJti,
          failure_reason: failure.reason,
        },
        signal,
      );
    } catch {
      // swallow
    }
  };

  try {
    while (!signal.aborted) {
      if (batchIndex >= maxBatches) {
        result.stoppedReason = "max_batches";
        break;
      }

      // Backoff before retry attempts. The first attempt of any batch
      // runs with consecutiveFailures === 0 (no backoff).
      if (consecutiveFailures > 0) {
        const wait =
          backoffMs[consecutiveFailures - 1] ??
          backoffMs[backoffMs.length - 1] ??
          0;
        if (wait > 0) {
          try {
            await delay(wait, signal);
          } catch {
            result.stoppedReason = "aborted";
            break;
          }
        }
      }

      const request: NextBatchRequest = { customerId };
      if (pendingAck) {
        request.acked_context_jti = pendingAck;
      } else if (pendingFailure) {
        request.failed_context_jti = pendingFailure.contextJti;
        request.failure_reason = pendingFailure.reason;
      }
      pendingAck = undefined;
      pendingFailure = undefined;

      let response: Phase2NextBatchResponse;
      try {
        response = await postNextBatch(kind, request, signal);
      } catch (err) {
        if (signal.aborted) {
          result.stoppedReason = "aborted";
          break;
        }
        result.stoppedReason = "error";
        result.lastError = new Phase2PushError({
          kind: "transport",
          message:
            err instanceof Error ? err.message : "next-batch fetch failed",
          contextJti:
            request.failed_context_jti ?? request.acked_context_jti ?? "",
          cause: err,
        });
        break;
      }

      if (response.paused === true) {
        result.stoppedReason = "paused";
        break;
      }

      const tokens = tokensFromResponse(response);
      if (!tokens || !response.aimer_endpoint_url || !response.schema_version) {
        // Empty body: nothing to deliver. If we were mid-retry, the
        // server has already absorbed the failure report and has
        // nothing further; treat that as a graceful end.
        result.stoppedReason = hasDelivered ? "exhausted" : "no_more";
        break;
      }

      result.batchesAttempted += 1;
      batchIndex += 1;

      let ack: Phase2PushResult | undefined;
      let pushErr: Phase2PushError | undefined;
      try {
        ack = await postPhase2Multipart(
          response.aimer_endpoint_url,
          tokens,
          response.schema_version,
          { timeoutMs, signal },
        );
      } catch (err) {
        pushErr =
          err instanceof Phase2PushError
            ? err
            : new Phase2PushError({
                kind: "transport",
                message:
                  err instanceof Error ? err.message : "unknown push error",
                contextJti: tokens.context_jti,
                cause: err,
              });
      }

      if (ack) {
        result.batchesSucceeded += 1;
        const delivered = ack.kind === "insert" ? ack.accepted : ack.withdrawn;
        const noOp =
          ack.kind === "insert" ? ack.duplicatesSkipped : ack.notFound;
        result.totalDelivered += delivered;
        result.totalNoOp += noOp;
        hasDelivered = true;
        options.onProgress?.({
          batchIndex,
          delivered,
          noOp,
          hasMore: response.has_more,
        });
        pendingAck = tokens.context_jti;
        consecutiveFailures = 0;
        if (!response.has_more) {
          result.stoppedReason = "exhausted";
          break;
        }
        continue;
      }

      // Delivery failed.
      if (pushErr) result.lastError = pushErr;
      if (pushErr?.kind === "aborted" || signal.aborted) {
        result.stoppedReason = "aborted";
        break;
      }

      const failure = {
        contextJti: tokens.context_jti,
        reason: pushErr ? failureReasonOf(pushErr) : "unknown",
      };

      if (pushErr && (isPermanentHttp(pushErr) || pushErr.kind === "schema")) {
        // Permanent: one cleanup call, then stop.
        await sendCleanup(failure);
        result.stoppedReason = "error";
        break;
      }

      consecutiveFailures += 1;
      if (consecutiveFailures > retriesPerBatch) {
        // Retries exhausted: final cleanup, then stop.
        await sendCleanup(failure);
        result.stoppedReason = "error";
        break;
      }

      // Loop will thread `failed_context_jti` on the next next-batch
      // call, which mints fresh tokens against the same un-acked rows.
      pendingFailure = failure;
    }

    if (signal.aborted && result.stoppedReason === "no_more") {
      result.stoppedReason = "aborted";
    }
  } finally {
    if (externalSignal) {
      externalSignal.removeEventListener("abort", onExternalAbort);
    }
  }

  return result;
}

// ── createPeriodicDrain ────────────────────────────────────────────

export interface PeriodicDrainController {
  start(): void;
  stop(): void;
  isRunning(): boolean;
  forceNow(): Promise<DrainResult>;
}

export interface CreatePeriodicDrainOptions {
  intervalMs?: number;
  onProgress?: DrainOptions["onProgress"];
  onIdle?: () => void;
}

/**
 * Visibility-aware periodic wrapper around
 * {@link drainOpportunisticPushQueue}. Fires once on `start()` and
 * then every `intervalMs`. Pauses while the document is hidden
 * (`document.visibilityState === 'hidden'`); resumes on visibility.
 * Single-flight: if a drain is in flight when the next interval
 * fires, the interval is skipped (the server's `has_more` flag will
 * pick it up on the next call).
 */
export function createPeriodicDrain(
  kind: Phase2DrainKind,
  customerId: number,
  options: CreatePeriodicDrainOptions = {},
): PeriodicDrainController {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const drainOptions: DrainOptions = {};
  if (options.onProgress) drainOptions.onProgress = options.onProgress;

  let running = false;
  let timerId: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<DrainResult> | null = null;
  let abortController: AbortController | null = null;

  const isHidden = (): boolean =>
    typeof document !== "undefined" && document.visibilityState === "hidden";

  const clearTimer = () => {
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }
  };

  const schedule = () => {
    clearTimer();
    if (!running || isHidden()) return;
    timerId = setTimeout(onTick, intervalMs);
  };

  const runDrain = (): Promise<DrainResult> => {
    if (inFlight) return inFlight;
    abortController = new AbortController();
    const localOptions: DrainOptions = {
      ...drainOptions,
      signal: abortController.signal,
    };
    inFlight = drainOpportunisticPushQueue(kind, customerId, localOptions)
      .then((result) => {
        if (
          result.stoppedReason === "exhausted" ||
          result.stoppedReason === "no_more"
        ) {
          options.onIdle?.();
        }
        return result;
      })
      .finally(() => {
        inFlight = null;
        abortController = null;
        schedule();
      });
    return inFlight;
  };

  const onTick = () => {
    if (!running || isHidden()) return;
    if (inFlight) {
      // Single-flight: skip and reschedule.
      schedule();
      return;
    }
    void runDrain();
  };

  const onVisibilityChange = () => {
    if (!running) return;
    if (isHidden()) {
      clearTimer();
    } else if (!inFlight) {
      void runDrain();
    } else {
      schedule();
    }
  };

  return {
    start() {
      if (running) return;
      running = true;
      if (typeof document !== "undefined") {
        document.addEventListener("visibilitychange", onVisibilityChange);
      }
      if (!isHidden()) {
        void runDrain();
      }
    },
    stop() {
      if (!running) return;
      running = false;
      clearTimer();
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibilityChange);
      }
      if (abortController) {
        abortController.abort();
      }
    },
    isRunning() {
      return running;
    },
    forceNow() {
      return runDrain();
    },
  };
}
