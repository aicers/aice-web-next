/**
 * Browser-side helper for the Phase 2 manual Send-to-aimer-web flow
 * (#493). Three sequential calls:
 *
 *   1. `POST /api/aimer/phase2/story/build-envelope` — mints the
 *      multipart tokens for a single Story.
 *   2. Browser POSTs the multipart body to `aimer_endpoint_url`
 *      (composed server-side from `setup.bridgeUrl + path` so the
 *      browser does not read the bridge URL itself).
 *   3. On 2xx from aimer-web, `POST /api/aimer/phase2/story/ack-manual`
 *      commits β + emits the `triage.story.send` audit row.
 *
 * Returns the post-commit β snapshot so the calling card can render
 * `"Sent · just now · 3×"` without a full menu refresh. Errors at any
 * stage throw a {@link ManualSendError} so the caller can map to a
 * toast with the structured code.
 */

import { mutatingFetch } from "@/lib/csrf-client";

import { type Phase2PushResult, postPhase2Multipart } from "./transport.client";

export interface ManualSendArgs {
  customerId: number;
  storyId: string;
  forceRefresh?: boolean;
  signal?: AbortSignal;
}

export interface ManualSendResult {
  lastSentAtIso: string;
  sendCount: number;
  duplicatesSkipped: number;
}

export type ManualSendErrorStage =
  | "build_envelope"
  | "aimer_post"
  | "ack_manual";

export class ManualSendError extends Error {
  readonly stage: ManualSendErrorStage;
  readonly status?: number;
  readonly code?: string;

  constructor(args: {
    stage: ManualSendErrorStage;
    message: string;
    status?: number;
    code?: string;
    cause?: unknown;
  }) {
    super(args.message, args.cause ? { cause: args.cause } : undefined);
    this.name = "ManualSendError";
    this.stage = args.stage;
    this.status = args.status;
    this.code = args.code;
  }
}

interface BuildEnvelopeResponse {
  context_token: string;
  events_envelope: string;
  events_data: string;
  context_jti: string;
  aimer_endpoint_path: string;
  aimer_endpoint_url: string | null;
  schema_version: "phase2.story.v1";
}

interface AckManualResponse {
  lastSentAtIso: string;
  sendCount: number;
}

async function postJson(
  path: string,
  body: unknown,
  signal: AbortSignal | undefined,
): Promise<Response> {
  // `withAuth` rejects unsafe-method requests that are missing the
  // Double-Submit CSRF header (#493 review round 1), so both local
  // `withAuth` routes — build-envelope and ack-manual — must go through
  // `mutatingFetch`. A bare `fetch()` would 403 before the route
  // handler runs.
  return mutatingFetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
    credentials: "same-origin",
  });
}

async function readErrorCode(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error.length > 0) {
      return body.error;
    }
  } catch {
    // ignore
  }
  return undefined;
}

/**
 * Send a single Story to aimer-web through the three-call manual flow.
 */
export async function manualSendToAimerWeb(
  args: ManualSendArgs,
): Promise<ManualSendResult> {
  // 1) build-envelope
  const buildRes = await postJson(
    "/api/aimer/phase2/story/build-envelope",
    {
      customerId: args.customerId,
      storyId: args.storyId,
      forceRefresh: args.forceRefresh === true,
    },
    args.signal,
  );
  if (!buildRes.ok) {
    const code = await readErrorCode(buildRes);
    throw new ManualSendError({
      stage: "build_envelope",
      message: `build-envelope responded ${buildRes.status}`,
      status: buildRes.status,
      code,
    });
  }
  const built = (await buildRes.json()) as BuildEnvelopeResponse;
  if (!built.aimer_endpoint_url) {
    throw new ManualSendError({
      stage: "build_envelope",
      message: "aimer-web bridge URL not configured",
      code: "aimer_integration_not_configured",
    });
  }

  // 2) POST multipart to aimer-web
  let pushResult: Phase2PushResult;
  try {
    pushResult = await postPhase2Multipart(
      built.aimer_endpoint_url,
      {
        context_token: built.context_token,
        events_envelope: built.events_envelope,
        events_data: built.events_data,
        context_jti: built.context_jti,
      },
      built.schema_version,
      { signal: args.signal },
    );
  } catch (err) {
    throw new ManualSendError({
      stage: "aimer_post",
      message: err instanceof Error ? err.message : "aimer-web push failed",
      cause: err,
    });
  }

  if (pushResult.kind !== "insert") {
    throw new ManualSendError({
      stage: "aimer_post",
      message: `unexpected ack shape: ${pushResult.kind}`,
    });
  }
  const duplicatesSkipped = pushResult.duplicatesSkipped;

  // 3) ack-manual
  const ackRes = await postJson(
    "/api/aimer/phase2/story/ack-manual",
    {
      customerId: args.customerId,
      storyId: args.storyId,
      contextJti: built.context_jti,
      forceRefresh: args.forceRefresh === true,
      duplicatesSkipped,
    },
    args.signal,
  );
  if (!ackRes.ok) {
    const code = await readErrorCode(ackRes);
    throw new ManualSendError({
      stage: "ack_manual",
      message: `ack-manual responded ${ackRes.status}`,
      status: ackRes.status,
      code,
    });
  }
  const acked = (await ackRes.json()) as AckManualResponse;
  return {
    lastSentAtIso: acked.lastSentAtIso,
    sendCount: acked.sendCount,
    duplicatesSkipped,
  };
}
