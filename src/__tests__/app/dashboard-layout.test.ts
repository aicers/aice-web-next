import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthSession } from "@/lib/auth/jwt";

const mockGetCurrentSession = vi.hoisted(() => vi.fn());
const mockRedirect = vi.hoisted(() => vi.fn());
const mockGetEffectiveCustomerScope = vi.hoisted(() => vi.fn());
const mockHasPermission = vi.hoisted(() => vi.fn());
const mockQuery = vi.hoisted(() => vi.fn());
const mockCookies = vi.hoisted(() => vi.fn());

vi.mock("next/headers", () => ({
  cookies: mockCookies,
}));

vi.mock("@/lib/auth/session", () => ({
  getCurrentSession: mockGetCurrentSession,
}));

vi.mock("@/lib/auth/customer-scope", () => ({
  getEffectiveCustomerScope: mockGetEffectiveCustomerScope,
}));

vi.mock("@/lib/auth/permissions", () => ({
  hasPermission: mockHasPermission,
}));

vi.mock("@/lib/db/client", () => ({
  query: mockQuery,
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
  mustEnrollMfa: false,
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
  mockGetEffectiveCustomerScope.mockReset();
  mockGetEffectiveCustomerScope.mockResolvedValue({
    kind: "admin",
    customers: [],
  });
  mockHasPermission.mockReset();
  mockHasPermission.mockResolvedValue(false);
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [{ username: "admin" }] });
  mockCookies.mockReset();
  mockCookies.mockResolvedValue({ get: () => undefined });
  vi.resetModules();
});

function cookieStoreFor(value: string | undefined) {
  return {
    get: (name: string) =>
      name === "sidebar-collapsed" && value !== undefined
        ? { name, value }
        : undefined,
  };
}

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

  it("forwards initialSidebarCollapsed=true when cookie is 'true'", async () => {
    mockGetCurrentSession.mockResolvedValue(validSession);
    mockCookies.mockResolvedValue(cookieStoreFor("true"));

    const DashboardLayout = (await import("@/app/[locale]/(dashboard)/layout"))
      .default;

    const result = await DashboardLayout({
      children: "child",
      params: Promise.resolve({ locale: "en" }),
    });

    expect(result.props.initialSidebarCollapsed).toBe(true);
  });

  it("forwards initialSidebarCollapsed=false when cookie is 'false'", async () => {
    mockGetCurrentSession.mockResolvedValue(validSession);
    mockCookies.mockResolvedValue(cookieStoreFor("false"));

    const DashboardLayout = (await import("@/app/[locale]/(dashboard)/layout"))
      .default;

    const result = await DashboardLayout({
      children: "child",
      params: Promise.resolve({ locale: "en" }),
    });

    expect(result.props.initialSidebarCollapsed).toBe(false);
  });

  it("forwards initialSidebarCollapsed=false when cookie is missing", async () => {
    mockGetCurrentSession.mockResolvedValue(validSession);
    mockCookies.mockResolvedValue(cookieStoreFor(undefined));

    const DashboardLayout = (await import("@/app/[locale]/(dashboard)/layout"))
      .default;

    const result = await DashboardLayout({
      children: "child",
      params: Promise.resolve({ locale: "en" }),
    });

    expect(result.props.initialSidebarCollapsed).toBe(false);
  });

  // The layout used to wrap `getEffectiveCustomerScope` in a `try/catch`
  // that collapsed any failure to `{ kind: "empty" }`, which made the
  // indicator silently impersonate the legitimate "no customer access"
  // state on a DB outage. The contract now is to let the error
  // propagate so Next's error boundary surfaces the actual fault.
  it("propagates getEffectiveCustomerScope failures instead of masking them as empty scope", async () => {
    mockGetCurrentSession.mockResolvedValue(validSession);
    const failure = new Error("DB unavailable");
    mockGetEffectiveCustomerScope.mockRejectedValue(failure);

    const DashboardLayout = (await import("@/app/[locale]/(dashboard)/layout"))
      .default;

    await expect(
      DashboardLayout({
        children: "child",
        params: Promise.resolve({ locale: "en" }),
      }),
    ).rejects.toThrow("DB unavailable");
  });
});
