/**
 * Tests for `src/lib/aimer/phase2/transport.client.ts`.
 *
 * Runs under jsdom: `createPeriodicDrain` reads `document.visibilityState`,
 * and the postPhase2Multipart helper builds `FormData` with a `Blob`
 * part — both are easiest exercised in a real DOM environment.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createPeriodicDrain,
  drainOpportunisticPushQueue,
  Phase2PushError,
  postPhase2Multipart,
} from "@/lib/aimer/phase2/transport.client";
import type {
  Phase2NextBatchResponse,
  Phase2PushTokens,
} from "@/lib/aimer/phase2/wire-types";

// ── Helpers ────────────────────────────────────────────────────────

function tokens(jti = "jti-abc"): Phase2PushTokens {
  return {
    context_token: "ctx-jws",
    events_envelope: "env-jws",
    events_data: '{"withdrawals":[{"kind":"policy_event"}]}',
    context_jti: jti,
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function makeNextBatch(
  partial: Partial<Phase2NextBatchResponse>,
): Phase2NextBatchResponse {
  return {
    has_more: false,
    context_token: null,
    events_envelope: null,
    events_data: null,
    context_jti: null,
    aimer_endpoint_path: null,
    aimer_endpoint_url: null,
    batch_jti: null,
    schema_version: null,
    ...partial,
  };
}

function batchResponse(opts: {
  hasMore?: boolean;
  jti: string;
  schemaVersion?: Phase2NextBatchResponse["schema_version"];
  url?: string;
}): Phase2NextBatchResponse {
  return makeNextBatch({
    has_more: opts.hasMore ?? false,
    context_token: "ctx-jws",
    events_envelope: "env-jws",
    events_data: '{"withdrawals":[]}',
    context_jti: opts.jti,
    aimer_endpoint_path: "/api/phase2/withdraw",
    aimer_endpoint_url:
      opts.url ?? "https://aimer.example.com/api/phase2/withdraw",
    batch_jti: opts.jti,
    schema_version: opts.schemaVersion ?? "phase2.withdraw.v1",
  });
}

// ── postPhase2Multipart ────────────────────────────────────────────

describe("postPhase2Multipart", () => {
  const fetchSpy = vi.fn();
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    fetchSpy.mockReset();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns a withdraw-shaped ack for phase2.withdraw.v1", async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({
        withdrawn: 3,
        not_found: 1,
        received_at: "2026-05-16T00:00:00Z",
        context_jti: "jti-abc",
      }),
    );
    const result = await postPhase2Multipart(
      "https://aimer.example.com/api/phase2/withdraw",
      tokens("jti-abc"),
      "phase2.withdraw.v1",
    );
    expect(result).toEqual({
      kind: "withdraw",
      withdrawn: 3,
      notFound: 1,
      receivedAt: "2026-05-16T00:00:00Z",
      contextJti: "jti-abc",
    });

    // Multipart body present + correct URL + POST verb.
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://aimer.example.com/api/phase2/withdraw");
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).body).toBeInstanceOf(FormData);
  });

  it("returns an insert-shaped ack for baseline schema version", async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({
        accepted: 12,
        duplicates_skipped: 2,
        deleted: 0,
        received_at: "2026-05-16T00:00:00Z",
        context_jti: "jti-insert",
      }),
    );
    const result = await postPhase2Multipart(
      "https://aimer.example.com/api/phase2/baseline",
      tokens("jti-insert"),
      "phase2.baseline.v1",
    );
    expect(result).toEqual({
      kind: "insert",
      accepted: 12,
      duplicatesSkipped: 2,
      deleted: 0,
      receivedAt: "2026-05-16T00:00:00Z",
      contextJti: "jti-insert",
    });
  });

  it("throws a structured http error on non-2xx with context_jti attached", async () => {
    fetchSpy.mockResolvedValue(
      new Response("nope", { status: 500, statusText: "Server Error" }),
    );
    await expect(
      postPhase2Multipart(
        "https://aimer.example.com/api/phase2/withdraw",
        tokens("jti-err"),
        "phase2.withdraw.v1",
      ),
    ).rejects.toMatchObject({
      name: "Phase2PushError",
      kind: "http",
      status: 500,
      contextJti: "jti-err",
    });
  });

  it("throws a structured transport error on network failure", async () => {
    fetchSpy.mockRejectedValue(new TypeError("offline"));
    await expect(
      postPhase2Multipart(
        "https://aimer.example.com/api/phase2/withdraw",
        tokens("jti-net"),
        "phase2.withdraw.v1",
      ),
    ).rejects.toMatchObject({
      kind: "transport",
      contextJti: "jti-net",
    });
  });

  it("throws aborted when the caller aborts pre-call", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      postPhase2Multipart(
        "https://aimer.example.com/api/phase2/withdraw",
        tokens("jti-abort"),
        "phase2.withdraw.v1",
        { signal: ac.signal },
      ),
    ).rejects.toMatchObject({
      kind: "aborted",
      contextJti: "jti-abort",
    });
  });

  it("does not retry internally", async () => {
    fetchSpy.mockResolvedValue(new Response("bad", { status: 502 }));
    await expect(
      postPhase2Multipart(
        "https://aimer.example.com/api/phase2/withdraw",
        tokens("jti-single"),
        "phase2.withdraw.v1",
      ),
    ).rejects.toBeInstanceOf(Phase2PushError);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("propagates a caller abort that fires after headers but before body read completes", async () => {
    // Browser `fetch` resolves once headers arrive; the body promise is
    // independent. The helper must keep the caller-abort wiring active
    // through the body read so a late abort is still observed.
    fetchSpy.mockImplementation(
      async (_url: string, init?: RequestInit): Promise<Response> => {
        const requestSignal = init?.signal as AbortSignal;
        return {
          ok: true,
          status: 200,
          json: () =>
            new Promise((_resolve, reject) => {
              const onAbort = () =>
                reject(new DOMException("aborted", "AbortError"));
              if (requestSignal.aborted) {
                onAbort();
              } else {
                requestSignal.addEventListener("abort", onAbort, {
                  once: true,
                });
              }
            }),
          text: () => Promise.resolve(""),
        } as unknown as Response;
      },
    );

    const ac = new AbortController();
    const p = postPhase2Multipart(
      "https://aimer.example.com/api/phase2/withdraw",
      tokens("jti-late-abort"),
      "phase2.withdraw.v1",
      { signal: ac.signal, timeoutMs: 60_000 },
    );
    // Let fetch resolve so we are now waiting on response.json().
    await Promise.resolve();
    ac.abort();

    await expect(p).rejects.toMatchObject({
      kind: "aborted",
      contextJti: "jti-late-abort",
    });
  });

  it("throws timeout when the response body stalls past timeoutMs", async () => {
    // The body promise here only rejects when the request signal aborts,
    // mirroring how browsers tie stream reads to the request's signal.
    // The helper's timeoutMs must continue to fence the body read.
    fetchSpy.mockImplementation(
      async (_url: string, init?: RequestInit): Promise<Response> => {
        const requestSignal = init?.signal as AbortSignal;
        return {
          ok: true,
          status: 200,
          json: () =>
            new Promise((_resolve, reject) => {
              requestSignal.addEventListener(
                "abort",
                () => reject(new DOMException("aborted", "AbortError")),
                { once: true },
              );
            }),
          text: () => Promise.resolve(""),
        } as unknown as Response;
      },
    );

    vi.useFakeTimers();
    try {
      const p = postPhase2Multipart(
        "https://aimer.example.com/api/phase2/withdraw",
        tokens("jti-slow-body"),
        "phase2.withdraw.v1",
        { timeoutMs: 250 },
      );
      // Attach the expectation up-front so the promise has a rejection
      // handler before the timer fires (avoids an unhandled-rejection
      // warning between rejection and the await below).
      const expectation = expect(p).rejects.toMatchObject({
        kind: "timeout",
        contextJti: "jti-slow-body",
      });
      // Let the fetch microtask settle so we are now awaiting json().
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(300);
      await expectation;
    } finally {
      vi.useRealTimers();
    }
  });

  it("throws a schema error on a malformed ack", async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ foo: "bar" }));
    await expect(
      postPhase2Multipart(
        "https://aimer.example.com/api/phase2/withdraw",
        tokens("jti-malformed"),
        "phase2.withdraw.v1",
      ),
    ).rejects.toMatchObject({
      kind: "schema",
      contextJti: "jti-malformed",
    });
  });
});

// ── drainOpportunisticPushQueue ────────────────────────────────────

describe("drainOpportunisticPushQueue", () => {
  const fetchSpy = vi.fn();
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    fetchSpy.mockReset();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("drains multiple batches, threads acked_context_jti, and aggregates totals", async () => {
    // Sequence:
    // 1. next-batch → batch1 (has_more)
    // 2. POST aimer → ack { withdrawn: 2, not_found: 1 }
    // 3. next-batch (acked=jti-1) → batch2 (no more)
    // 4. POST aimer → ack { withdrawn: 5, not_found: 0 }
    // 5. next-batch (acked=jti-2) → empty   ← final commit ack
    const nextBatchBodies: Array<Record<string, unknown>> = [];
    fetchSpy.mockImplementation(async (url: string, init?: RequestInit) => {
      const u = typeof url === "string" ? url : "";
      if (u.endsWith("/api/aimer/phase2/policy-event/next-batch")) {
        const body = JSON.parse((init?.body as string) ?? "{}");
        nextBatchBodies.push(body);
        if (!body.acked_context_jti && !body.failed_context_jti) {
          return jsonResponse(batchResponse({ jti: "jti-1", hasMore: true }));
        }
        if (body.acked_context_jti === "jti-1") {
          return jsonResponse(batchResponse({ jti: "jti-2", hasMore: false }));
        }
        if (body.acked_context_jti === "jti-2") {
          return jsonResponse(makeNextBatch({ has_more: false }));
        }
        throw new Error(`unexpected next-batch body: ${init?.body as string}`);
      }
      if (u === "https://aimer.example.com/api/phase2/withdraw") {
        const fd = init?.body as FormData;
        const ctxToken = fd.get("context_token");
        expect(ctxToken).toBe("ctx-jws");
        // First aimer post acks 2; second acks 5.
        const callsToAimer = fetchSpy.mock.calls.filter(
          (c) => c[0] === "https://aimer.example.com/api/phase2/withdraw",
        ).length;
        if (callsToAimer === 1) {
          return jsonResponse({
            withdrawn: 2,
            not_found: 1,
            received_at: "t",
            context_jti: "jti-1",
          });
        }
        return jsonResponse({
          withdrawn: 5,
          not_found: 0,
          received_at: "t",
          context_jti: "jti-2",
        });
      }
      throw new Error(`unexpected fetch ${u}`);
    });

    const progress: number[] = [];
    const result = await drainOpportunisticPushQueue("policy_event", 42, {
      onProgress: (b) => progress.push(b.delivered),
      retriesPerBatch: 0,
    });

    expect(result.batchesAttempted).toBe(2);
    expect(result.batchesSucceeded).toBe(2);
    expect(result.totalDelivered).toBe(7);
    expect(result.totalNoOp).toBe(1);
    expect(result.stoppedReason).toBe("exhausted");
    expect(progress).toEqual([2, 5]);

    // The final batch (has_more: false) must still trigger a follow-up
    // next-batch with acked_context_jti = last batch's jti — the server
    // commits queue rows + the streaming cursor only on that ack.
    expect(nextBatchBodies).toHaveLength(3);
    expect(nextBatchBodies[2].acked_context_jti).toBe("jti-2");
  });

  it("sends the final acked_context_jti on a single-batch has_more=false drain", async () => {
    // Regression test: when the very first next-batch returns
    // has_more=false with work to do, the drain must still send a
    // follow-up acked_context_jti call so the server commits queue
    // rows / cursor advancement. Without it, the common one-batch
    // case leaves rows inflight and re-delivers them after TTL.
    const nextBatchBodies: Array<Record<string, unknown>> = [];
    fetchSpy.mockImplementation(async (url: string, init?: RequestInit) => {
      const u = typeof url === "string" ? url : "";
      if (u.endsWith("/api/aimer/phase2/policy-event/next-batch")) {
        const body = JSON.parse((init?.body as string) ?? "{}");
        nextBatchBodies.push(body);
        if (!body.acked_context_jti && !body.failed_context_jti) {
          return jsonResponse(
            batchResponse({ jti: "jti-only", hasMore: false }),
          );
        }
        if (body.acked_context_jti === "jti-only") {
          return jsonResponse(makeNextBatch({ has_more: false }));
        }
        throw new Error(`unexpected next-batch body: ${init?.body as string}`);
      }
      if (u === "https://aimer.example.com/api/phase2/withdraw") {
        return jsonResponse({
          withdrawn: 4,
          not_found: 0,
          received_at: "t",
          context_jti: "jti-only",
        });
      }
      throw new Error(`unexpected fetch ${u}`);
    });

    const result = await drainOpportunisticPushQueue("policy_event", 42, {
      retriesPerBatch: 0,
    });

    expect(result.stoppedReason).toBe("exhausted");
    expect(result.batchesSucceeded).toBe(1);
    expect(result.totalDelivered).toBe(4);
    // Two next-batch calls: initial fetch + final commit ack.
    expect(nextBatchBodies).toHaveLength(2);
    expect(nextBatchBodies[1].acked_context_jti).toBe("jti-only");
  });

  it("aggregates insert-shape acks correctly", async () => {
    fetchSpy.mockImplementation(async (url: string, init?: RequestInit) => {
      const u = typeof url === "string" ? url : "";
      if (u.endsWith("/api/aimer/phase2/baseline-event/next-batch")) {
        const body = JSON.parse((init?.body as string) ?? "{}");
        if (!body.acked_context_jti) {
          return jsonResponse(
            batchResponse({
              jti: "jti-base",
              hasMore: false,
              schemaVersion: "phase2.baseline.v1",
              url: "https://aimer.example.com/api/phase2/baseline",
            }),
          );
        }
        return jsonResponse(makeNextBatch({ has_more: false }));
      }
      if (u === "https://aimer.example.com/api/phase2/baseline") {
        return jsonResponse({
          accepted: 9,
          duplicates_skipped: 1,
          received_at: "t",
          context_jti: "jti-base",
        });
      }
      throw new Error(`unexpected fetch ${u}`);
    });

    const result = await drainOpportunisticPushQueue("baseline_event", 1);
    expect(result.totalDelivered).toBe(9);
    expect(result.totalNoOp).toBe(1);
    expect(result.batchesSucceeded).toBe(1);
  });

  it("retries with bounded backoff on transient transport failure, threading failed_context_jti", async () => {
    let aimerCalls = 0;
    const nextBatchBodies: unknown[] = [];
    fetchSpy.mockImplementation(async (url: string, init?: RequestInit) => {
      const u = typeof url === "string" ? url : "";
      if (u.endsWith("/api/aimer/phase2/policy-event/next-batch")) {
        const body = JSON.parse((init?.body as string) ?? "{}");
        nextBatchBodies.push(body);
        if (!body.acked_context_jti && !body.failed_context_jti) {
          return jsonResponse(batchResponse({ jti: "jti-x", hasMore: false }));
        }
        // On failure-threaded call: serve a fresh batch.
        if (body.failed_context_jti === "jti-x") {
          return jsonResponse(batchResponse({ jti: "jti-y", hasMore: false }));
        }
        if (body.acked_context_jti === "jti-y") {
          return jsonResponse(makeNextBatch({ has_more: false }));
        }
        throw new Error(`unexpected next-batch body: ${JSON.stringify(body)}`);
      }
      if (u === "https://aimer.example.com/api/phase2/withdraw") {
        aimerCalls += 1;
        // First two calls fail (5xx). Third succeeds (on jti-y).
        if (aimerCalls <= 2) {
          return new Response("nope", { status: 503 });
        }
        return jsonResponse({
          withdrawn: 1,
          not_found: 0,
          received_at: "t",
          context_jti: "jti-y",
        });
      }
      throw new Error(`unexpected fetch ${u}`);
    });

    const result = await drainOpportunisticPushQueue("policy_event", 42, {
      retriesPerBatch: 1, // 1 retry → 2 attempts on the same batch
      backoffMs: [0],
    });

    // First batch: 2 attempts, both fail → record failure and stop.
    expect(aimerCalls).toBeGreaterThanOrEqual(2);
    // After the first batch's failures, the drain threads
    // failed_context_jti on the next next-batch call.
    const failingBody = nextBatchBodies.find(
      (b) => (b as { failed_context_jti?: string }).failed_context_jti,
    ) as { failed_context_jti: string; failure_reason: string };
    expect(failingBody.failed_context_jti).toBe("jti-x");
    expect(failingBody.failure_reason).toMatch(/http_503/);
    expect(result.stoppedReason).toBe("error");
    expect(result.lastError?.kind).toBe("http");
  });

  it("retries use fresh tokens minted via next-batch — never replays the same context_token", async () => {
    // RFC 0002 §6.1 binds the envelope `jti` to a single use. A retry
    // that re-POSTs the same multipart payload would be rejected by
    // the receiver as a replay. This test asserts the drain helper
    // loops back through `next-batch` (threading `failed_context_jti`)
    // to mint fresh tokens for every push attempt.
    const aimerBodies: FormData[] = [];
    fetchSpy.mockImplementation(async (url: string, init?: RequestInit) => {
      const u = typeof url === "string" ? url : "";
      if (u.endsWith("/api/aimer/phase2/policy-event/next-batch")) {
        const body = JSON.parse((init?.body as string) ?? "{}");
        if (!body.acked_context_jti && !body.failed_context_jti) {
          return jsonResponse({
            ...batchResponse({ jti: "jti-1", hasMore: false }),
            context_token: "ctx-jws-1",
            events_envelope: "env-jws-1",
          });
        }
        if (body.failed_context_jti === "jti-1") {
          return jsonResponse({
            ...batchResponse({ jti: "jti-2", hasMore: false }),
            context_token: "ctx-jws-2",
            events_envelope: "env-jws-2",
          });
        }
        if (body.failed_context_jti === "jti-2") {
          // Final cleanup after retries are exhausted.
          return jsonResponse(makeNextBatch({ has_more: false }));
        }
        throw new Error(`unexpected next-batch body: ${JSON.stringify(body)}`);
      }
      if (u === "https://aimer.example.com/api/phase2/withdraw") {
        aimerBodies.push(init?.body as FormData);
        return new Response("nope", { status: 503 });
      }
      throw new Error(`unexpected fetch ${u}`);
    });

    await drainOpportunisticPushQueue("policy_event", 42, {
      retriesPerBatch: 1,
      backoffMs: [0],
    });

    expect(aimerBodies).toHaveLength(2);
    // Each push attempt must carry a *different* signed context_token
    // — the fresh tokens minted by the failure-threaded next-batch.
    expect(aimerBodies[0].get("context_token")).toBe("ctx-jws-1");
    expect(aimerBodies[1].get("context_token")).toBe("ctx-jws-2");
    expect(aimerBodies[0].get("events_envelope")).toBe("env-jws-1");
    expect(aimerBodies[1].get("events_envelope")).toBe("env-jws-2");
  });

  it("on permanent 4xx, threads failed_context_jti once for cleanup and does NOT deliver the cleanup response body", async () => {
    let aimerCalls = 0;
    const nextBatchBodies: Array<{
      acked_context_jti?: string;
      failed_context_jti?: string;
    }> = [];
    fetchSpy.mockImplementation(async (url: string, init?: RequestInit) => {
      const u = typeof url === "string" ? url : "";
      if (u.endsWith("/api/aimer/phase2/policy-event/next-batch")) {
        const body = JSON.parse((init?.body as string) ?? "{}");
        nextBatchBodies.push(body);
        if (!body.acked_context_jti && !body.failed_context_jti) {
          return jsonResponse(batchResponse({ jti: "jti-bad", hasMore: true }));
        }
        // Cleanup call: server, not knowing the client is stopping,
        // returns a fresh non-empty batch. The drain MUST NOT deliver it.
        if (body.failed_context_jti === "jti-bad") {
          return jsonResponse(
            batchResponse({ jti: "jti-fresh", hasMore: false }),
          );
        }
        return jsonResponse(makeNextBatch({ has_more: false }));
      }
      if (u === "https://aimer.example.com/api/phase2/withdraw") {
        aimerCalls += 1;
        return new Response("bad request", { status: 400 });
      }
      throw new Error(`unexpected fetch ${u}`);
    });

    const result = await drainOpportunisticPushQueue("policy_event", 42, {
      retriesPerBatch: 3, // permanent 4xx must not consume retries
      backoffMs: [0, 0, 0],
    });

    // Exactly one aimer POST attempt (no retries on permanent 4xx).
    expect(aimerCalls).toBe(1);
    // Cleanup call did happen (one failed_context_jti body in the trail).
    const failed = nextBatchBodies.filter((b) => b.failed_context_jti);
    expect(failed).toHaveLength(1);
    expect(failed[0].failed_context_jti).toBe("jti-bad");
    expect(result.batchesAttempted).toBe(1);
    expect(result.totalDelivered).toBe(0);
    expect(result.stoppedReason).toBe("error");
  });

  it("stops with stoppedReason: 'no_more' when the queue is empty", async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(makeNextBatch({ has_more: false })),
    );
    const result = await drainOpportunisticPushQueue("policy_event", 42);
    expect(result.stoppedReason).toBe("no_more");
    expect(result.batchesAttempted).toBe(0);
  });

  it("surfaces stoppedReason: 'paused' when the server reports paused", async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(makeNextBatch({ has_more: false, paused: true })),
    );
    const result = await drainOpportunisticPushQueue("baseline_event", 1);
    expect(result.stoppedReason).toBe("paused");
  });

  it("honors a clean abort and does NOT thread failed_context_jti", async () => {
    const ac = new AbortController();
    const nextBatchBodies: unknown[] = [];
    fetchSpy.mockImplementation(async (url: string, init?: RequestInit) => {
      const u = typeof url === "string" ? url : "";
      if (u.endsWith("/api/aimer/phase2/policy-event/next-batch")) {
        nextBatchBodies.push(JSON.parse((init?.body as string) ?? "{}"));
        // Abort right before the drain attempts the aimer POST.
        ac.abort();
        return jsonResponse(
          batchResponse({ jti: "jti-abort", hasMore: false }),
        );
      }
      throw new Error(`unexpected fetch ${u}`);
    });

    const result = await drainOpportunisticPushQueue("policy_event", 42, {
      signal: ac.signal,
    });
    expect(result.stoppedReason).toBe("aborted");
    // No follow-up next-batch with failed_context_jti — only the
    // initial call (without ack/fail) was made.
    expect(
      nextBatchBodies.every(
        (b) => !(b as { failed_context_jti?: string }).failed_context_jti,
      ),
    ).toBe(true);
  });
});

// ── createPeriodicDrain ────────────────────────────────────────────

describe("createPeriodicDrain", () => {
  const fetchSpy = vi.fn();
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchSpy.mockReset();
    // Default: every next-batch is empty → drain returns immediately.
    fetchSpy.mockResolvedValue(
      jsonResponse(makeNextBatch({ has_more: false })),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });
  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
  });

  function setVisibility(state: "visible" | "hidden") {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => state,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  }

  /**
   * Flush microtasks (`Promise.resolve()` thenables) without advancing
   * fake timers. The drain's promise chain has several `await` points
   * before `.finally` calls `schedule()`, so we need several turns.
   */
  async function flushMicrotasks() {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  }

  it("fires immediately on start and then every intervalMs", async () => {
    setVisibility("visible");
    const ctrl = createPeriodicDrain("policy_event", 42, {
      intervalMs: 1_000,
    });
    ctrl.start();
    // Immediate fire — drain runs, finishes, schedules the 1000ms timer.
    await flushMicrotasks();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Advance exactly one interval → exactly one more drain.
    await vi.advanceTimersByTimeAsync(1_000);
    await flushMicrotasks();
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1_000);
    await flushMicrotasks();
    expect(fetchSpy).toHaveBeenCalledTimes(3);

    ctrl.stop();
  });

  it("pauses while document is hidden and resumes on visibility", async () => {
    setVisibility("hidden");
    const ctrl = createPeriodicDrain("policy_event", 42, {
      intervalMs: 1_000,
    });
    ctrl.start();
    // Started while hidden — no fetch yet.
    await flushMicrotasks();
    expect(fetchSpy).toHaveBeenCalledTimes(0);

    setVisibility("visible");
    await flushMicrotasks();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    ctrl.stop();
  });

  it("is single-flight: overlapping interval ticks are skipped", async () => {
    setVisibility("visible");
    // First call: never resolves until we say so → blocks the in-flight drain.
    let resolveFirst: (v: Response) => void = () => {};
    fetchSpy.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    // Subsequent calls return empty so the next drain exits immediately.
    fetchSpy.mockResolvedValue(
      jsonResponse(makeNextBatch({ has_more: false })),
    );

    const ctrl = createPeriodicDrain("policy_event", 42, {
      intervalMs: 1_000,
    });
    ctrl.start();
    await flushMicrotasks();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Tick: should be skipped because the first drain is still inflight.
    await vi.advanceTimersByTimeAsync(1_000);
    await flushMicrotasks();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Release the blocked drain — `.finally` now schedules the next timer.
    resolveFirst(jsonResponse(makeNextBatch({ has_more: false })));
    await flushMicrotasks();

    // After completion, the next interval fires the next drain.
    await vi.advanceTimersByTimeAsync(1_000);
    await flushMicrotasks();
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    ctrl.stop();
  });

  it("stop() cancels the timer and aborts the in-flight drain", async () => {
    setVisibility("visible");
    let aborted = false;
    fetchSpy.mockImplementationOnce(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          (init?.signal as AbortSignal).addEventListener("abort", () => {
            aborted = true;
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );

    const ctrl = createPeriodicDrain("policy_event", 42, {
      intervalMs: 1_000,
    });
    ctrl.start();
    await flushMicrotasks();
    expect(ctrl.isRunning()).toBe(true);
    ctrl.stop();
    expect(ctrl.isRunning()).toBe(false);
    await flushMicrotasks();
    expect(aborted).toBe(true);
  });

  it("forceNow() bypasses the timer and returns a DrainResult", async () => {
    setVisibility("visible");
    const ctrl = createPeriodicDrain("policy_event", 42, {
      intervalMs: 60_000,
    });
    // Note: not calling start().
    const result = await ctrl.forceNow();
    expect(result.stoppedReason).toBe("no_more");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
