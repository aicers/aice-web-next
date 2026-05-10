import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthSession } from "@/lib/auth/jwt";

const mockGetCurrentSession = vi.hoisted(() => vi.fn());
const mockRequirePermission = vi.hoisted(() => vi.fn());
const mockRedirect = vi.hoisted(() => vi.fn());
const mockFetchEventByLocator = vi.hoisted(() => vi.fn());
const mockGetTranslations = vi.hoisted(() => vi.fn());
const mockGetCustomerBridgeEligibility = vi.hoisted(() => vi.fn());
const mockGetAimerIntegrationSetupStatus = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/session", () => ({
  getCurrentSession: mockGetCurrentSession,
  requirePermission: mockRequirePermission,
}));

vi.mock("next/navigation", () => ({
  redirect: mockRedirect,
}));

vi.mock("@/lib/detection", () => ({
  fetchEventByLocator: mockFetchEventByLocator,
}));

vi.mock("next-intl/server", () => ({
  getTranslations: mockGetTranslations,
}));

vi.mock("@/lib/aimer/customer-eligibility", () => ({
  getCustomerBridgeEligibility: mockGetCustomerBridgeEligibility,
}));

vi.mock("@/lib/aimer/setup-status", () => ({
  getAimerIntegrationSetupStatus: mockGetAimerIntegrationSetupStatus,
}));

vi.mock("@/components/events/event-investigation", () => ({
  EventInvestigation: ({ event }: { event: { __typename: string } }) =>
    `investigation:${event.__typename}`,
}));

vi.mock("@/components/events/event-not-found", () => ({
  EventNotFound: ({ reason }: { reason: string }) => `not-found:${reason}`,
}));

const validSession: AuthSession = {
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
};

function buildToken(): string {
  const payload = { id: "evt-AAAA-BBBB-CCCC" };
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

function noSearch(): Promise<Record<string, string | string[] | undefined>> {
  return Promise.resolve({});
}

beforeEach(() => {
  mockGetCurrentSession.mockReset();
  mockRequirePermission.mockReset();
  mockRedirect.mockReset();
  mockFetchEventByLocator.mockReset();
  mockGetTranslations.mockReset();
  mockGetTranslations.mockResolvedValue((key: string) => key);
  mockGetCustomerBridgeEligibility.mockReset();
  mockGetCustomerBridgeEligibility.mockResolvedValue({});
  mockGetAimerIntegrationSetupStatus.mockReset();
  mockGetAimerIntegrationSetupStatus.mockResolvedValue({ configured: true });
  vi.resetModules();
});

describe("EventInvestigationPage", () => {
  it("returns null when no session is present", async () => {
    mockGetCurrentSession.mockResolvedValue(null);
    const Page = (
      await import("@/app/[locale]/(dashboard)/events/[token]/page")
    ).default;

    const result = await Page({
      params: Promise.resolve({ locale: "en", token: buildToken() }),
      searchParams: noSearch(),
    });
    expect(result).toBeNull();
  });

  it("calls requirePermission with detection:read", async () => {
    mockGetCurrentSession.mockResolvedValue(validSession);
    mockRequirePermission.mockResolvedValue(undefined);
    mockFetchEventByLocator.mockResolvedValue({
      status: "one",
      event: {
        __typename: "HttpThreat",
        id: "evt-AAAA-BBBB-CCCC",
        time: "2026-04-22T10:00:00.000000000Z",
        sensor: "sensor-1",
        confidence: 0.8,
        category: null,
        level: "HIGH",
        triageScores: null,
      },
    });
    const Page = (
      await import("@/app/[locale]/(dashboard)/events/[token]/page")
    ).default;

    await Page({
      params: Promise.resolve({ locale: "en", token: buildToken() }),
      searchParams: noSearch(),
    });

    expect(mockRequirePermission).toHaveBeenCalledWith(
      validSession,
      "detection:read",
    );
  });

  it("renders the invalid-token state when the token cannot be decoded", async () => {
    mockGetCurrentSession.mockResolvedValue(validSession);
    mockRequirePermission.mockResolvedValue(undefined);
    const Page = (
      await import("@/app/[locale]/(dashboard)/events/[token]/page")
    ).default;

    const result = await Page({
      params: Promise.resolve({ locale: "en", token: "!!garbage!!" }),
      searchParams: noSearch(),
    });
    expect(result?.props?.reason).toBe("invalid-token");
    expect(mockFetchEventByLocator).not.toHaveBeenCalled();
  });

  it("renders the invalid-token state for tampered payload shapes without hitting REview", async () => {
    mockGetCurrentSession.mockResolvedValue(validSession);
    mockRequirePermission.mockResolvedValue(undefined);
    const Page = (
      await import("@/app/[locale]/(dashboard)/events/[token]/page")
    ).default;

    // Payloads that pass JSON validation but violate the
    // `{ id: non-empty string }` contract should short-circuit to
    // invalid-token rather than reaching fetchEventByLocator.
    const tamperedPayloads = [
      {},
      { id: "" },
      { id: 42 },
      { id: "x".repeat(2048) },
    ];

    for (const payload of tamperedPayloads) {
      const token = Buffer.from(JSON.stringify(payload)).toString("base64url");
      const result = await Page({
        params: Promise.resolve({ locale: "en", token }),
        searchParams: noSearch(),
      });
      expect(result?.props?.reason).toBe("invalid-token");
    }
    expect(mockFetchEventByLocator).not.toHaveBeenCalled();
  });

  it("renders the zero-match state when the service returns no event", async () => {
    mockGetCurrentSession.mockResolvedValue(validSession);
    mockRequirePermission.mockResolvedValue(undefined);
    mockFetchEventByLocator.mockResolvedValue({ status: "zero" });
    const Page = (
      await import("@/app/[locale]/(dashboard)/events/[token]/page")
    ).default;

    const result = await Page({
      params: Promise.resolve({ locale: "en", token: buildToken() }),
      searchParams: noSearch(),
    });
    expect(result?.props?.reason).toBe("not-found");
  });

  it("renders the fetch-error state when fetchEventByLocator throws", async () => {
    mockGetCurrentSession.mockResolvedValue(validSession);
    mockRequirePermission.mockResolvedValue(undefined);
    mockFetchEventByLocator.mockRejectedValue(new Error("boom"));
    const Page = (
      await import("@/app/[locale]/(dashboard)/events/[token]/page")
    ).default;

    const result = await Page({
      params: Promise.resolve({ locale: "en", token: buildToken() }),
      searchParams: noSearch(),
    });
    expect(result?.props?.reason).toBe("fetch-error");
  });

  it("renders the investigation view when an event is found", async () => {
    mockGetCurrentSession.mockResolvedValue(validSession);
    mockRequirePermission.mockResolvedValue(undefined);
    mockFetchEventByLocator.mockResolvedValue({
      status: "one",
      event: {
        __typename: "HttpThreat",
        id: "evt-AAAA-BBBB-CCCC",
        time: "2026-04-22T10:00:00.000000000Z",
        sensor: "sensor-1",
        confidence: 0.8,
        category: null,
        level: "HIGH",
        triageScores: null,
      },
    });
    const Page = (
      await import("@/app/[locale]/(dashboard)/events/[token]/page")
    ).default;

    const result = await Page({
      params: Promise.resolve({ locale: "en", token: buildToken() }),
      searchParams: noSearch(),
    });
    expect(result?.props?.event?.__typename).toBe("HttpThreat");
  });

  it("defaults backHref to /detection when no returnTo is supplied", async () => {
    mockGetCurrentSession.mockResolvedValue(validSession);
    mockRequirePermission.mockResolvedValue(undefined);
    mockFetchEventByLocator.mockResolvedValue({
      status: "one",
      event: {
        __typename: "HttpThreat",
        id: "evt-AAAA-BBBB-CCCC",
        time: "2026-04-22T10:00:00.000000000Z",
        sensor: "sensor-1",
        confidence: 0.8,
        category: null,
        level: "HIGH",
        triageScores: null,
      },
    });
    const Page = (
      await import("@/app/[locale]/(dashboard)/events/[token]/page")
    ).default;

    const result = await Page({
      params: Promise.resolve({ locale: "en", token: buildToken() }),
      searchParams: noSearch(),
    });
    expect(result?.props?.backHref).toBe("/detection");
  });

  it("propagates a same-origin returnTo into the back link", async () => {
    mockGetCurrentSession.mockResolvedValue(validSession);
    mockRequirePermission.mockResolvedValue(undefined);
    mockFetchEventByLocator.mockResolvedValue({
      status: "one",
      event: {
        __typename: "HttpThreat",
        id: "evt-AAAA-BBBB-CCCC",
        time: "2026-04-22T10:00:00.000000000Z",
        sensor: "sensor-1",
        confidence: 0.8,
        category: null,
        level: "HIGH",
        triageScores: null,
      },
    });
    const Page = (
      await import("@/app/[locale]/(dashboard)/events/[token]/page")
    ).default;

    const result = await Page({
      params: Promise.resolve({ locale: "en", token: buildToken() }),
      searchParams: Promise.resolve({
        returnTo: "/detection?source=10.0.0.5&window=1d",
      }),
    });
    expect(result?.props?.backHref).toBe(
      "/detection?source=10.0.0.5&window=1d",
    );
  });

  it("rejects off-site returnTo values and falls back to /detection", async () => {
    mockGetCurrentSession.mockResolvedValue(validSession);
    mockRequirePermission.mockResolvedValue(undefined);
    mockFetchEventByLocator.mockResolvedValue({
      status: "one",
      event: {
        __typename: "HttpThreat",
        id: "evt-AAAA-BBBB-CCCC",
        time: "2026-04-22T10:00:00.000000000Z",
        sensor: "sensor-1",
        confidence: 0.8,
        category: null,
        level: "HIGH",
        triageScores: null,
      },
    });
    const Page = (
      await import("@/app/[locale]/(dashboard)/events/[token]/page")
    ).default;

    const result = await Page({
      params: Promise.resolve({ locale: "en", token: buildToken() }),
      searchParams: Promise.resolve({ returnTo: "//evil.tld/phish" }),
    });
    expect(result?.props?.backHref).toBe("/detection");
  });
});
