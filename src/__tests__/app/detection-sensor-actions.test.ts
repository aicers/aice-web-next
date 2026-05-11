import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthSession } from "@/lib/auth/jwt";

const mockGetCurrentSession = vi.hoisted(() => vi.fn());
const mockListSensors = vi.hoisted(() => vi.fn());
// Export `sensorsOrEmpty` unchanged from the mock so the server
// action's `result.sensors` destructuring path still works.
const mockSensorsOrEmpty = vi.hoisted(
  () => (result: { endpointAvailable: boolean; sensors?: unknown[] }) =>
    result.endpointAvailable ? (result.sensors ?? []) : [],
);

class MockDetectionUnauthorizedError extends Error {}

vi.mock("@/lib/auth/session", () => ({
  getCurrentSession: mockGetCurrentSession,
}));

vi.mock("@/lib/detection", () => ({
  listSensors: mockListSensors,
  sensorsOrEmpty: mockSensorsOrEmpty,
  DetectionUnauthorizedError: MockDetectionUnauthorizedError,
}));

const SESSION: AuthSession = {
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

describe("fetchSensors server action", () => {
  beforeEach(() => {
    mockGetCurrentSession.mockReset();
    mockListSensors.mockReset();
  });

  it("rejects an unauthenticated caller without touching the backend", async () => {
    mockGetCurrentSession.mockResolvedValue(null);

    const { fetchSensors } = await import(
      "@/app/[locale]/(dashboard)/detection/sensor-actions"
    );

    const result = await fetchSensors();
    expect(result).toEqual({ ok: false, code: "unauthenticated" });
    expect(mockListSensors).not.toHaveBeenCalled();
  });

  it("maps DetectionUnauthorizedError to a `forbidden` code", async () => {
    mockGetCurrentSession.mockResolvedValue(SESSION);
    mockListSensors.mockRejectedValue(
      new MockDetectionUnauthorizedError("nope"),
    );

    const { fetchSensors } = await import(
      "@/app/[locale]/(dashboard)/detection/sensor-actions"
    );

    const result = await fetchSensors();
    expect(result).toEqual({ ok: false, code: "forbidden" });
  });

  it("surfaces `endpointAvailable: false` with an empty list when the schema lacks the query", async () => {
    // Mirrors the degrade-gracefully clause in the issue: the drawer
    // must be able to distinguish "endpoint absent" from an empty
    // sensor inventory, because the former triggers the "Coming soon"
    // fallback while the latter just renders an empty options list.
    mockGetCurrentSession.mockResolvedValue(SESSION);
    mockListSensors.mockResolvedValue({ endpointAvailable: false });

    const { fetchSensors } = await import(
      "@/app/[locale]/(dashboard)/detection/sensor-actions"
    );

    const result = await fetchSensors();
    expect(result).toEqual({
      ok: true,
      endpointAvailable: false,
      sensors: [],
    });
  });

  it("flattens Sensor objects to serialization-friendly rows when the endpoint is live", async () => {
    mockGetCurrentSession.mockResolvedValue(SESSION);
    mockListSensors.mockResolvedValue({
      endpointAvailable: true,
      sensors: [
        { id: "s1", name: "Sensor One", customerId: 1 },
        { id: "s2", name: "Sensor Two", customerId: 2 },
      ],
    });

    const { fetchSensors } = await import(
      "@/app/[locale]/(dashboard)/detection/sensor-actions"
    );

    const result = await fetchSensors();
    expect(result).toEqual({
      ok: true,
      endpointAvailable: true,
      sensors: [
        { id: "s1", name: "Sensor One", customerId: 1 },
        { id: "s2", name: "Sensor Two", customerId: 2 },
      ],
    });
  });

  it("catches unexpected errors and returns a server-error code", async () => {
    mockGetCurrentSession.mockResolvedValue(SESSION);
    mockListSensors.mockRejectedValue(new Error("boom"));

    const { fetchSensors } = await import(
      "@/app/[locale]/(dashboard)/detection/sensor-actions"
    );

    const result = await fetchSensors();
    expect(result).toEqual({ ok: false, code: "server-error" });
  });
});
