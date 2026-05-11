import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthSession } from "@/lib/auth/jwt";
import type { Filter } from "@/lib/detection";

const mockGetCurrentSession = vi.hoisted(() => vi.fn());
const mockSearchEventsAtAnchor = vi.hoisted(() => vi.fn());

class MockDetectionUnauthorizedError extends Error {}
class MockDetectionForbiddenError extends Error {}

vi.mock("@/lib/auth/session", () => ({
  getCurrentSession: mockGetCurrentSession,
}));

vi.mock("@/lib/detection", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/detection")>("@/lib/detection");
  return {
    ...actual,
    DetectionUnauthorizedError: MockDetectionUnauthorizedError,
    DetectionForbiddenError: MockDetectionForbiddenError,
    searchEventsAtAnchor: mockSearchEventsAtAnchor,
  };
});

const SESSION = {
  accountId: "account-1",
  sessionId: "session-1",
  roles: ["Security Monitor"],
  tokenVersion: 0,
  mustChangePassword: false,
  mustEnrollMfa: false,
  iat: 0,
  exp: 0,
  sessionIp: "127.0.0.1",
  sessionUserAgent: "test",
  sessionBrowserFingerprint: "test",
  needsReauth: false,
  sessionCreatedAt: new Date(0),
  sessionLastActiveAt: new Date(0),
} as AuthSession;

const STRUCTURED_FILTER: Filter = {
  mode: "structured",
  input: { start: null, end: null },
};

describe("runEventQuery — review-side error mapping (#405 I)", () => {
  beforeEach(() => {
    mockGetCurrentSession.mockReset();
    mockSearchEventsAtAnchor.mockReset();
  });

  it("maps DetectionForbiddenError to `forbidden-customer-scope`", async () => {
    mockGetCurrentSession.mockResolvedValue(SESSION);
    mockSearchEventsAtAnchor.mockRejectedValue(
      new MockDetectionForbiddenError("scope"),
    );

    const { runEventQuery } = await import(
      "@/app/[locale]/(dashboard)/detection/actions"
    );

    const result = await runEventQuery(STRUCTURED_FILTER);
    expect(result).toEqual({ ok: false, code: "forbidden-customer-scope" });
  });

  it("maps DetectionUnauthorizedError to `forbidden`", async () => {
    mockGetCurrentSession.mockResolvedValue(SESSION);
    mockSearchEventsAtAnchor.mockRejectedValue(
      new MockDetectionUnauthorizedError("nope"),
    );

    const { runEventQuery } = await import(
      "@/app/[locale]/(dashboard)/detection/actions"
    );

    const result = await runEventQuery(STRUCTURED_FILTER);
    expect(result).toEqual({ ok: false, code: "forbidden" });
  });

  // The action MUST surface review-side denials with their typed
  // discriminator. Collapsing them into the generic `server-error`
  // bucket would silently swallow Forbidden as "the BFF crashed",
  // which the security guardrails forbid. Unknown errors continue
  // to fall through to `server-error` (next test).
  it("maps ReviewForbiddenError to `forbidden`", async () => {
    mockGetCurrentSession.mockResolvedValue(SESSION);
    const { ReviewForbiddenError } = await import("@/lib/review/errors");
    mockSearchEventsAtAnchor.mockRejectedValue(
      new ReviewForbiddenError("Forbidden"),
    );

    const { runEventQuery } = await import(
      "@/app/[locale]/(dashboard)/detection/actions"
    );

    const result = await runEventQuery(STRUCTURED_FILTER);
    expect(result).toEqual({ ok: false, code: "forbidden" });
  });

  // #278: review-web 0.33.0 rejects `eventList(filter: { sensors: [...] })`
  // with `Forbidden` if any supplied `nodeId` is outside the caller's
  // customer scope. The customer-scope leg already throws
  // `DetectionForbiddenError` before any review round-trip, so a
  // `ReviewForbiddenError` reaching the action with a non-empty
  // `sensors` filter is unambiguously the sensor-out-of-scope path.
  // The classifier must surface the typed `forbidden-sensor-scope`
  // code so the shell can render the "selection no longer accessible"
  // affordance instead of a generic forbidden banner.
  it("maps ReviewForbiddenError with sensors in filter to `forbidden-sensor-scope`", async () => {
    mockGetCurrentSession.mockResolvedValue(SESSION);
    const { ReviewForbiddenError } = await import("@/lib/review/errors");
    mockSearchEventsAtAnchor.mockRejectedValue(
      new ReviewForbiddenError("Forbidden"),
    );

    const filterWithSensors: Filter = {
      mode: "structured",
      input: { start: null, end: null, sensors: ["7", "13", "21"] },
    };

    const { runEventQuery } = await import(
      "@/app/[locale]/(dashboard)/detection/actions"
    );

    const result = await runEventQuery(filterWithSensors);
    expect(result).toEqual({
      ok: false,
      code: "forbidden-sensor-scope",
      unavailableSensorIds: ["7", "13", "21"],
    });
  });

  // #278: a filter with no `sensors` cannot have triggered the sensor-
  // scope rejection; it must collapse back to generic `forbidden`.
  it("maps ReviewForbiddenError with no sensors in filter to `forbidden`", async () => {
    mockGetCurrentSession.mockResolvedValue(SESSION);
    const { ReviewForbiddenError } = await import("@/lib/review/errors");
    mockSearchEventsAtAnchor.mockRejectedValue(
      new ReviewForbiddenError("Forbidden"),
    );

    const filterWithoutSensors: Filter = {
      mode: "structured",
      input: { start: null, end: null, sensors: [] },
    };

    const { runEventQuery } = await import(
      "@/app/[locale]/(dashboard)/detection/actions"
    );

    const result = await runEventQuery(filterWithoutSensors);
    expect(result).toEqual({ ok: false, code: "forbidden" });
  });

  it("maps ReviewInvalidArgumentError to `invalid-input`", async () => {
    mockGetCurrentSession.mockResolvedValue(SESSION);
    const { ReviewInvalidArgumentError } = await import("@/lib/review/errors");
    mockSearchEventsAtAnchor.mockRejectedValue(
      new ReviewInvalidArgumentError(
        "The value of first and last must be within 0-100",
      ),
    );

    const { runEventQuery } = await import(
      "@/app/[locale]/(dashboard)/detection/actions"
    );

    const result = await runEventQuery(STRUCTURED_FILTER);
    expect(result).toEqual({ ok: false, code: "invalid-input" });
  });

  it("maps any other error to `server-error`", async () => {
    mockGetCurrentSession.mockResolvedValue(SESSION);
    mockSearchEventsAtAnchor.mockRejectedValue(new Error("boom"));

    const { runEventQuery } = await import(
      "@/app/[locale]/(dashboard)/detection/actions"
    );

    const result = await runEventQuery(STRUCTURED_FILTER);
    expect(result).toEqual({ ok: false, code: "server-error" });
  });

  // Reviewer Round 2 P1: an unrecognised review GraphQL error is
  // *not* an "ordinary" failure and must NOT collapse into the
  // graceful `server-error` bucket — masking new review-side error
  // codes as a generic state defeats the security guardrail. The
  // action lets `ReviewUnknownGraphQLError` propagate so the route's
  // error boundary surfaces it.
  it("re-throws ReviewUnknownGraphQLError instead of masking as `server-error`", async () => {
    mockGetCurrentSession.mockResolvedValue(SESSION);
    const { ReviewUnknownGraphQLError } = await import("@/lib/review/errors");
    const denied = new ReviewUnknownGraphQLError("future-review-code");
    mockSearchEventsAtAnchor.mockRejectedValue(denied);

    const { runEventQuery } = await import(
      "@/app/[locale]/(dashboard)/detection/actions"
    );

    await expect(runEventQuery(STRUCTURED_FILTER)).rejects.toBe(denied);
  });
});
