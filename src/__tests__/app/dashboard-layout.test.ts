import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthSession } from "@/lib/auth/jwt";

const mockGetCurrentSession = vi.hoisted(() => vi.fn());
const mockRedirect = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/session", () => ({
  getCurrentSession: mockGetCurrentSession,
}));

vi.mock("next/navigation", () => ({
  redirect: mockRedirect,
}));

vi.mock("@/components/layout/dashboard-layout", () => ({
  default: ({ children }: { children: unknown }) => children,
}));

const now = Math.floor(Date.now() / 1000);

const validSession: AuthSession = {
  accountId: "account-1",
  sessionId: "session-1",
  roles: ["System Administrator"],
  tokenVersion: 0,
  mustChangePassword: false,
  iat: now,
  exp: now + 900,
  sessionIp: "127.0.0.1",
  sessionUserAgent: "Mozilla/5.0 Chrome/131",
  sessionBrowserFingerprint: "Chrome/131",
  needsReauth: false,
  sessionCreatedAt: new Date(),
  sessionLastActiveAt: new Date(),
};

beforeEach(() => {
  mockGetCurrentSession.mockReset();
  mockRedirect.mockReset();
  mockRedirect.mockImplementation((path: string) => {
    throw new Error(`redirect:${path}`);
  });
  vi.resetModules();
});

describe("DashboardLayout", () => {
  it("redirects to default-locale sign-in when session is missing", async () => {
    mockGetCurrentSession.mockResolvedValue(null);

    const DashboardLayout = (await import("@/app/[locale]/(dashboard)/layout"))
      .default;

    await expect(
      DashboardLayout({
        children: "child",
        params: Promise.resolve({ locale: "en" }),
      }),
    ).rejects.toThrow("redirect:/sign-in");
  });

  it("redirects to localized sign-in when session is missing", async () => {
    mockGetCurrentSession.mockResolvedValue(null);

    const DashboardLayout = (await import("@/app/[locale]/(dashboard)/layout"))
      .default;

    await expect(
      DashboardLayout({
        children: "child",
        params: Promise.resolve({ locale: "ko" }),
      }),
    ).rejects.toThrow("redirect:/ko/sign-in");
  });

  it("redirects must-change-password sessions to localized change-password", async () => {
    mockGetCurrentSession.mockResolvedValue({
      ...validSession,
      mustChangePassword: true,
    });

    const DashboardLayout = (await import("@/app/[locale]/(dashboard)/layout"))
      .default;

    await expect(
      DashboardLayout({
        children: "child",
        params: Promise.resolve({ locale: "ko" }),
      }),
    ).rejects.toThrow("redirect:/ko/change-password");
  });

  it("renders children when session is valid", async () => {
    mockGetCurrentSession.mockResolvedValue(validSession);

    const DashboardLayout = (await import("@/app/[locale]/(dashboard)/layout"))
      .default;

    const result = await DashboardLayout({
      children: "child",
      params: Promise.resolve({ locale: "en" }),
    });

    expect(result.props.children).toBe("child");
    expect(mockRedirect).not.toHaveBeenCalled();
  });
});
