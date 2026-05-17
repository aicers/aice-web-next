/**
 * Tests for `src/lib/aimer/phase2/manual-send.client.ts` (#493).
 *
 * The browser-side three-call manual Send flow:
 *   1) POST /api/aimer/phase2/story/build-envelope
 *   2) POST multipart to aimer-web's batch URL
 *   3) POST /api/aimer/phase2/story/ack-manual
 *
 * Runs under jsdom so `fetch` and `FormData` exist. The transport
 * client is mocked so step 2 can return any ack shape without
 * standing up a real aimer-web fixture.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { postPhase2MultipartMock } = vi.hoisted(() => ({
  postPhase2MultipartMock: vi.fn(),
}));

vi.mock("@/lib/aimer/phase2/transport.client", () => ({
  postPhase2Multipart: postPhase2MultipartMock,
}));

import {
  ManualSendError,
  manualSendToAimerWeb,
} from "@/lib/aimer/phase2/manual-send.client";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function envelopeBody(overrides: Record<string, unknown> = {}) {
  return {
    context_token: "ctx-jws",
    events_envelope: "env-jws",
    events_data: '{"stories":[]}',
    context_jti: "jti-abc",
    aimer_endpoint_path: "/api/phase2/story/batch",
    aimer_endpoint_url: "https://aimer.example.com/api/phase2/story/batch",
    schema_version: "phase2.story.v1",
    ...overrides,
  };
}

describe("manualSendToAimerWeb — happy path", () => {
  beforeEach(() => {
    postPhase2MultipartMock.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("threads jti + duplicatesSkipped through build → aimer-web → ack", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(envelopeBody()))
      .mockResolvedValueOnce(
        jsonResponse({
          lastSentAtIso: "2026-05-17T10:00:00.000Z",
          sendCount: 3,
        }),
      );
    postPhase2MultipartMock.mockResolvedValue({
      kind: "insert",
      accepted: 1,
      duplicatesSkipped: 0,
      receivedAt: "2026-05-17T10:00:00.000Z",
      contextJti: "jti-abc",
    });

    const result = await manualSendToAimerWeb({
      customerId: 7,
      storyId: "42",
    });

    expect(result).toEqual({
      lastSentAtIso: "2026-05-17T10:00:00.000Z",
      sendCount: 3,
      duplicatesSkipped: 0,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // Step 1 — build-envelope receives customerId / storyId / forceRefresh.
    const buildArgs = fetchSpy.mock.calls[0];
    expect(buildArgs[0]).toBe("/api/aimer/phase2/story/build-envelope");
    expect(JSON.parse((buildArgs[1] as RequestInit).body as string)).toEqual({
      customerId: 7,
      storyId: "42",
      forceRefresh: false,
    });

    // Step 2 — aimer-web URL composed server-side is forwarded as-is.
    expect(postPhase2MultipartMock).toHaveBeenCalledWith(
      "https://aimer.example.com/api/phase2/story/batch",
      expect.objectContaining({ context_jti: "jti-abc" }),
      "phase2.story.v1",
      expect.objectContaining({ signal: undefined }),
    );

    // Step 3 — ack-manual carries the originating jti + duplicatesSkipped.
    const ackArgs = fetchSpy.mock.calls[1];
    expect(ackArgs[0]).toBe("/api/aimer/phase2/story/ack-manual");
    expect(JSON.parse((ackArgs[1] as RequestInit).body as string)).toEqual({
      customerId: 7,
      storyId: "42",
      contextJti: "jti-abc",
      forceRefresh: false,
      duplicatesSkipped: 0,
    });
  });

  it("forwards forceRefresh=true through every leg", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(envelopeBody()))
      .mockResolvedValueOnce(
        jsonResponse({
          lastSentAtIso: "2026-05-17T10:00:00.000Z",
          sendCount: 1,
        }),
      );
    postPhase2MultipartMock.mockResolvedValue({
      kind: "insert",
      accepted: 1,
      duplicatesSkipped: 1,
      receivedAt: "2026-05-17T10:00:00.000Z",
      contextJti: "jti-abc",
    });

    const result = await manualSendToAimerWeb({
      customerId: 7,
      storyId: "42",
      forceRefresh: true,
    });

    expect(result.duplicatesSkipped).toBe(1);
    expect(
      JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string)
        .forceRefresh,
    ).toBe(true);
    expect(
      JSON.parse((fetchSpy.mock.calls[1][1] as RequestInit).body as string)
        .forceRefresh,
    ).toBe(true);
  });
});

describe("manualSendToAimerWeb — error stages", () => {
  beforeEach(() => {
    postPhase2MultipartMock.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws stage=build_envelope on 4xx from build-envelope and surfaces the structured code", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({ error: "story_not_found" }, { status: 404 }),
    );

    const err = await manualSendToAimerWeb({
      customerId: 7,
      storyId: "42",
    }).catch((e) => e);

    expect(err).toBeInstanceOf(ManualSendError);
    expect((err as ManualSendError).stage).toBe("build_envelope");
    expect((err as ManualSendError).status).toBe(404);
    expect((err as ManualSendError).code).toBe("story_not_found");
    expect(postPhase2MultipartMock).not.toHaveBeenCalled();
  });

  it("throws aimer_integration_not_configured when aimer_endpoint_url is null", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(envelopeBody({ aimer_endpoint_url: null })),
    );

    const err = await manualSendToAimerWeb({
      customerId: 7,
      storyId: "42",
    }).catch((e) => e);

    expect(err).toBeInstanceOf(ManualSendError);
    expect((err as ManualSendError).stage).toBe("build_envelope");
    expect((err as ManualSendError).code).toBe(
      "aimer_integration_not_configured",
    );
    expect(postPhase2MultipartMock).not.toHaveBeenCalled();
  });

  it("throws stage=aimer_post when postPhase2Multipart rejects, never calls ack-manual", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(envelopeBody()));
    postPhase2MultipartMock.mockRejectedValueOnce(
      new Error("network unreachable"),
    );

    const err = await manualSendToAimerWeb({
      customerId: 7,
      storyId: "42",
    }).catch((e) => e);

    expect(err).toBeInstanceOf(ManualSendError);
    expect((err as ManualSendError).stage).toBe("aimer_post");
    expect((err as ManualSendError).message).toContain("network unreachable");
    // Only the build-envelope call should have hit fetch.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("throws stage=aimer_post when aimer-web returns an unexpected ack discriminator", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(envelopeBody()),
    );
    postPhase2MultipartMock.mockResolvedValueOnce({
      kind: "withdraw",
      withdrawn: 1,
      notFound: 0,
      receivedAt: "2026-05-17T10:00:00.000Z",
      contextJti: "jti-abc",
    });

    const err = await manualSendToAimerWeb({
      customerId: 7,
      storyId: "42",
    }).catch((e) => e);

    expect(err).toBeInstanceOf(ManualSendError);
    expect((err as ManualSendError).stage).toBe("aimer_post");
    expect((err as ManualSendError).message).toContain("withdraw");
  });

  it("throws stage=ack_manual on 409 from ack-manual and surfaces replay_or_unknown_jti", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(envelopeBody()))
      .mockResolvedValueOnce(
        jsonResponse({ error: "replay_or_unknown_jti" }, { status: 409 }),
      );
    postPhase2MultipartMock.mockResolvedValueOnce({
      kind: "insert",
      accepted: 1,
      duplicatesSkipped: 0,
      receivedAt: "2026-05-17T10:00:00.000Z",
      contextJti: "jti-abc",
    });

    const err = await manualSendToAimerWeb({
      customerId: 7,
      storyId: "42",
    }).catch((e) => e);

    expect(err).toBeInstanceOf(ManualSendError);
    expect((err as ManualSendError).stage).toBe("ack_manual");
    expect((err as ManualSendError).status).toBe(409);
    expect((err as ManualSendError).code).toBe("replay_or_unknown_jti");
  });
});
