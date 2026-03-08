import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthSession } from "@/lib/auth/jwt";

type HandlerFn = (
  request: NextRequest,
  context: { params: Promise<Record<string, string>> },
  session: AuthSession,
) => Promise<Response>;

const mockQuery = vi.hoisted(() => vi.fn());
const mockCookiesSet = vi.hoisted(() => vi.fn());
const mockCookiesDelete = vi.hoisted(() => vi.fn());

let currentSession: AuthSession;
vi.mock("@/lib/auth/guard", () => ({
  withAuth: vi.fn((handler: HandlerFn) => {
    return async (
      request: NextRequest,
      context: { params: Promise<Record<string, string>> },
    ) => {
      return handler(request, context, currentSession);
    };
  }),
}));

vi.mock("@/lib/db/client", () => ({
  query: vi.fn((...args: unknown[]) => mockQuery(...args)),
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(() =>
    Promise.resolve({
      set: mockCookiesSet,
      delete: mockCookiesDelete,
    }),
  ),
}));

vi.mock("@/i18n/routing", () => ({
  routing: {
    locales: ["en", "ko"],
    defaultLocale: "en",
  },
}));

const defaultSession: AuthSession = {
  accountId: "00000000-0000-0000-0000-000000000001",
  sessionId: "session-1",
  roles: ["System Administrator"],
  tokenVersion: 0,
  mustChangePassword: false,
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 3600,
  sessionCreatedAt: new Date(),
  sessionLastActiveAt: new Date(),
  sessionIp: "127.0.0.1",
  sessionUserAgent: "test",
  sessionBrowserFingerprint: "test",
  needsReauth: false,
};

const emptyContext = { params: Promise.resolve({}) };

describe("GET /api/accounts/me/preferences", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentSession = { ...defaultSession };
  });

  it("returns stored locale and timezone", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ locale: "ko", timezone: "Asia/Seoul" }],
    });

    const { GET } = await import("@/app/api/accounts/me/preferences/route");
    const res = await GET(
      new NextRequest("http://localhost/api/accounts/me/preferences"),
      emptyContext,
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.locale).toBe("ko");
    expect(body.data.timezone).toBe("Asia/Seoul");
  });

  it("returns null when preferences are not set", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ locale: null, timezone: null }],
    });

    const { GET } = await import("@/app/api/accounts/me/preferences/route");
    const res = await GET(
      new NextRequest("http://localhost/api/accounts/me/preferences"),
      emptyContext,
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.locale).toBeNull();
    expect(body.data.timezone).toBeNull();
  });

  it("returns 404 when account not found", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const { GET } = await import("@/app/api/accounts/me/preferences/route");
    const res = await GET(
      new NextRequest("http://localhost/api/accounts/me/preferences"),
      emptyContext,
    );

    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/accounts/me/preferences", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentSession = { ...defaultSession };
  });

  it("updates locale and sets NEXT_LOCALE cookie", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ locale: "ko", timezone: null }],
    });

    const { PATCH } = await import("@/app/api/accounts/me/preferences/route");
    const res = await PATCH(
      new NextRequest("http://localhost/api/accounts/me/preferences", {
        method: "PATCH",
        body: JSON.stringify({ locale: "ko" }),
      }),
      emptyContext,
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.locale).toBe("ko");
    expect(mockCookiesSet).toHaveBeenCalledWith("NEXT_LOCALE", "ko", {
      path: "/",
      maxAge: 365 * 24 * 60 * 60,
    });
  });

  it("updates timezone", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ locale: null, timezone: "America/New_York" }],
    });

    const { PATCH } = await import("@/app/api/accounts/me/preferences/route");
    const res = await PATCH(
      new NextRequest("http://localhost/api/accounts/me/preferences", {
        method: "PATCH",
        body: JSON.stringify({ timezone: "America/New_York" }),
      }),
      emptyContext,
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.timezone).toBe("America/New_York");
  });

  it("rejects invalid locale", async () => {
    const { PATCH } = await import("@/app/api/accounts/me/preferences/route");
    const res = await PATCH(
      new NextRequest("http://localhost/api/accounts/me/preferences", {
        method: "PATCH",
        body: JSON.stringify({ locale: "fr" }),
      }),
      emptyContext,
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Invalid locale");
  });

  it("rejects invalid timezone", async () => {
    const { PATCH } = await import("@/app/api/accounts/me/preferences/route");
    const res = await PATCH(
      new NextRequest("http://localhost/api/accounts/me/preferences", {
        method: "PATCH",
        body: JSON.stringify({ timezone: "Invalid/Zone" }),
      }),
      emptyContext,
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid timezone");
  });

  it("allows null locale and deletes NEXT_LOCALE cookie", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ locale: null, timezone: null }],
    });

    const { PATCH } = await import("@/app/api/accounts/me/preferences/route");
    const res = await PATCH(
      new NextRequest("http://localhost/api/accounts/me/preferences", {
        method: "PATCH",
        body: JSON.stringify({ locale: null }),
      }),
      emptyContext,
    );

    expect(res.status).toBe(200);
    expect(mockCookiesDelete).toHaveBeenCalledWith("NEXT_LOCALE");
  });

  it("allows null timezone", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ locale: null, timezone: null }],
    });

    const { PATCH } = await import("@/app/api/accounts/me/preferences/route");
    const res = await PATCH(
      new NextRequest("http://localhost/api/accounts/me/preferences", {
        method: "PATCH",
        body: JSON.stringify({ timezone: null }),
      }),
      emptyContext,
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.timezone).toBeNull();
  });

  it("returns current preferences when no fields provided", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ locale: "en", timezone: "UTC" }],
    });

    const { PATCH } = await import("@/app/api/accounts/me/preferences/route");
    const res = await PATCH(
      new NextRequest("http://localhost/api/accounts/me/preferences", {
        method: "PATCH",
        body: JSON.stringify({}),
      }),
      emptyContext,
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.locale).toBe("en");
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it("returns 400 for invalid JSON", async () => {
    const { PATCH } = await import("@/app/api/accounts/me/preferences/route");
    const res = await PATCH(
      new NextRequest("http://localhost/api/accounts/me/preferences", {
        method: "PATCH",
        body: "not-json",
      }),
      emptyContext,
    );

    expect(res.status).toBe(400);
  });

  it("rejects non-string locale type", async () => {
    const { PATCH } = await import("@/app/api/accounts/me/preferences/route");
    const res = await PATCH(
      new NextRequest("http://localhost/api/accounts/me/preferences", {
        method: "PATCH",
        body: JSON.stringify({ locale: 123 }),
      }),
      emptyContext,
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("locale must be a string or null");
  });

  it("rejects non-string timezone type", async () => {
    const { PATCH } = await import("@/app/api/accounts/me/preferences/route");
    const res = await PATCH(
      new NextRequest("http://localhost/api/accounts/me/preferences", {
        method: "PATCH",
        body: JSON.stringify({ timezone: 123 }),
      }),
      emptyContext,
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("timezone must be a string or null");
  });

  it("updates both locale and timezone simultaneously", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ locale: "ko", timezone: "Asia/Seoul" }],
    });

    const { PATCH } = await import("@/app/api/accounts/me/preferences/route");
    const res = await PATCH(
      new NextRequest("http://localhost/api/accounts/me/preferences", {
        method: "PATCH",
        body: JSON.stringify({ locale: "ko", timezone: "Asia/Seoul" }),
      }),
      emptyContext,
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.locale).toBe("ko");
    expect(body.data.timezone).toBe("Asia/Seoul");
    expect(mockCookiesSet).toHaveBeenCalledWith("NEXT_LOCALE", "ko", {
      path: "/",
      maxAge: 365 * 24 * 60 * 60,
    });
    // Verify SQL includes both columns
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("locale"),
      expect.arrayContaining(["ko", "Asia/Seoul"]),
    );
  });

  it("returns 404 when account not found during update", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const { PATCH } = await import("@/app/api/accounts/me/preferences/route");
    const res = await PATCH(
      new NextRequest("http://localhost/api/accounts/me/preferences", {
        method: "PATCH",
        body: JSON.stringify({ locale: "en" }),
      }),
      emptyContext,
    );

    expect(res.status).toBe(404);
  });
});
