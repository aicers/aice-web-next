import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Hoisted mocks ──────────────────────────────────────────────

const mockVerifyJwtStateless = vi.hoisted(() => vi.fn());
const mockIntlMiddleware = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/jwt-verify-stateless", () => ({
  verifyJwtStateless: mockVerifyJwtStateless,
}));

vi.mock("next-intl/middleware", () => ({
  default: () => mockIntlMiddleware,
}));

// ── Import under test (after mocks) ───────────────────────────

import proxy, { config } from "@/proxy";

// ── Helpers ────────────────────────────────────────────────────

function makeRequest(path: string, cookie?: string): NextRequest {
  const request = new NextRequest(`http://localhost:3000${path}`);
  if (cookie) {
    request.cookies.set("at", cookie);
  }
  return request;
}

function getRedirectPathname(response: Response): string {
  const location = response.headers.get("location") ?? "";
  return new URL(location).pathname;
}

// ── Tests ──────────────────────────────────────────────────────

describe("proxy", () => {
  beforeEach(() => {
    mockVerifyJwtStateless.mockReset();
    mockIntlMiddleware.mockReset();
    mockIntlMiddleware.mockReturnValue(new Response(null, { status: 200 }));
  });

  describe("public routes", () => {
    it("passes / to intl middleware without auth check", async () => {
      await proxy(makeRequest("/"));

      expect(mockIntlMiddleware).toHaveBeenCalledTimes(1);
      expect(mockVerifyJwtStateless).not.toHaveBeenCalled();
    });

    it("passes /sign-in to intl middleware without auth check", async () => {
      await proxy(makeRequest("/sign-in"));

      expect(mockIntlMiddleware).toHaveBeenCalledTimes(1);
      expect(mockVerifyJwtStateless).not.toHaveBeenCalled();
    });

    it("passes /ko/sign-in to intl middleware without auth check", async () => {
      await proxy(makeRequest("/ko/sign-in"));

      expect(mockIntlMiddleware).toHaveBeenCalledTimes(1);
      expect(mockVerifyJwtStateless).not.toHaveBeenCalled();
    });
  });

  describe("protected routes — no cookie", () => {
    it("redirects /audit-logs to /sign-in", async () => {
      const response = await proxy(makeRequest("/audit-logs"));

      expect(response.status).toBe(307);
      expect(getRedirectPathname(response)).toBe("/sign-in");
      expect(mockIntlMiddleware).not.toHaveBeenCalled();
    });

    it("redirects /ko/audit-logs to /ko/sign-in", async () => {
      const response = await proxy(makeRequest("/ko/audit-logs"));

      expect(response.status).toBe(307);
      expect(getRedirectPathname(response)).toBe("/ko/sign-in");
    });

    it("redirects /en/audit-logs to /sign-in (default locale, no prefix)", async () => {
      const response = await proxy(makeRequest("/en/audit-logs"));

      expect(response.status).toBe(307);
      // "en" is the default locale — redirect has no locale prefix
      expect(getRedirectPathname(response)).toBe("/sign-in");
    });

    // Regression: with the default `nginx-prod` host mapping of
    // `9443:443`, the browser sends `Host: localhost:9443`. Nginx
    // must forward that authority verbatim (`proxy_set_header Host
    // $http_host`) so Next builds `request.url` against it; otherwise
    // the sign-in redirect lands on the unpublished `:443`.
    it("preserves the inbound host:port authority on the sign-in redirect", async () => {
      const request = new NextRequest("https://localhost:9443/audit-logs");
      const response = await proxy(request);

      expect(response.status).toBe(307);
      const location = new URL(response.headers.get("location") ?? "");
      expect(location.origin).toBe("https://localhost:9443");
      expect(location.pathname).toBe("/sign-in");
    });
  });

  describe("protected routes — invalid JWT", () => {
    it("redirects when verifyJwtStateless throws", async () => {
      mockVerifyJwtStateless.mockRejectedValue(new Error("JWT expired"));

      const response = await proxy(makeRequest("/audit-logs", "bad-token"));

      expect(response.status).toBe(307);
      expect(getRedirectPathname(response)).toBe("/sign-in");
      expect(mockVerifyJwtStateless).toHaveBeenCalledWith("bad-token");
    });
  });

  describe("protected routes — valid JWT", () => {
    it("calls intl middleware when JWT is valid", async () => {
      mockVerifyJwtStateless.mockResolvedValue({
        sub: "account-1",
        sid: "session-1",
        roles: ["admin"],
        token_version: 0,
        kid: "key-1",
      });

      await proxy(makeRequest("/audit-logs", "valid-token"));

      expect(mockVerifyJwtStateless).toHaveBeenCalledWith("valid-token");
      expect(mockIntlMiddleware).toHaveBeenCalledTimes(1);
    });

    it("does not redirect when JWT is valid", async () => {
      mockVerifyJwtStateless.mockResolvedValue({
        sub: "account-1",
        sid: "session-1",
        roles: ["admin"],
        token_version: 0,
        kid: "key-1",
      });

      const response = await proxy(makeRequest("/audit-logs", "valid-token"));

      expect(response.status).toBe(200);
    });
  });

  describe("config", () => {
    it("exports matcher that excludes api, _next, and static files", () => {
      expect(config.matcher).toBe("/((?!api|trpc|_next|_vercel|.*\\..*).*)");
    });
  });

  describe("CSP header (Report-Only)", () => {
    it("attaches Content-Security-Policy-Report-Only on the public path response", async () => {
      const response = await proxy(makeRequest("/sign-in"));

      const csp = response.headers.get("Content-Security-Policy-Report-Only");
      expect(csp).toBeTruthy();
      expect(csp).toContain("default-src 'self'");
      expect(csp).toMatch(
        /script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/,
      );
      expect(csp).toContain("frame-ancestors 'none'");
    });

    it("attaches CSP-Report-Only on the sign-in redirect from a protected path", async () => {
      const response = await proxy(makeRequest("/audit-logs"));

      expect(response.status).toBe(307);
      expect(
        response.headers.get("Content-Security-Policy-Report-Only"),
      ).toBeTruthy();
    });

    it("attaches CSP-Report-Only on the redirect when JWT verification fails", async () => {
      mockVerifyJwtStateless.mockRejectedValue(new Error("JWT expired"));

      const response = await proxy(makeRequest("/audit-logs", "bad-token"));

      expect(response.status).toBe(307);
      expect(
        response.headers.get("Content-Security-Policy-Report-Only"),
      ).toBeTruthy();
    });

    it("does NOT emit the enforcing Content-Security-Policy header (Report-Only only)", async () => {
      const response = await proxy(makeRequest("/sign-in"));

      // Promotion to enforcing CSP is a separate follow-up after one
      // release of Report-Only validation.
      expect(response.headers.get("Content-Security-Policy")).toBeNull();
    });

    it("forwards the nonce to RSC via the x-nonce request header", async () => {
      mockIntlMiddleware.mockImplementation((request: NextRequest) => {
        // Capture the request that the intl middleware sees so we can
        // assert that x-nonce was forwarded.
        const nonce = request.headers.get("x-nonce");
        const response = new Response(null, { status: 200 });
        if (nonce) response.headers.set("x-test-nonce", nonce);
        return response;
      });

      const response = await proxy(makeRequest("/sign-in"));

      const forwardedNonce = response.headers.get("x-test-nonce");
      expect(forwardedNonce).toBeTruthy();
      // The same nonce should appear in the CSP header.
      const csp = response.headers.get("Content-Security-Policy-Report-Only");
      expect(csp).toContain(`'nonce-${forwardedNonce}'`);
    });

    it("forwards the enforcing-style Content-Security-Policy request header so Next's renderer can extract the nonce", async () => {
      mockIntlMiddleware.mockImplementation((request: NextRequest) => {
        // Next.js's renderer parses the *request*-side CSP header for
        // the `'nonce-{value}'` pattern and uses that value as the
        // nonce attribute on framework scripts.  Capture what the
        // proxy forwarded.
        const cspRequest = request.headers.get("Content-Security-Policy");
        const xNonce = request.headers.get("x-nonce");
        const response = new Response(null, { status: 200 });
        if (cspRequest) response.headers.set("x-test-csp-request", cspRequest);
        if (xNonce) response.headers.set("x-test-nonce", xNonce);
        return response;
      });

      const response = await proxy(makeRequest("/sign-in"));

      const cspRequest = response.headers.get("x-test-csp-request");
      const nonce = response.headers.get("x-test-nonce");
      expect(cspRequest).toBeTruthy();
      expect(nonce).toBeTruthy();
      // The forwarded request header carries the same nonce as the
      // browser-facing Report-Only response header.
      expect(cspRequest).toContain(`'nonce-${nonce}'`);
      const cspResponse = response.headers.get(
        "Content-Security-Policy-Report-Only",
      );
      expect(cspResponse).toBe(cspRequest);
    });

    it("forwards the nonce-bearing CSP request header to the renderer for an unmatched (not-found) path with a valid session", async () => {
      // The proxy is fail-closed, so an unauthenticated `/missing` would
      // hit the `/sign-in` redirect branch instead of the not-found
      // branch.  Driving with a valid JWT exercises the same renderer
      // path that produces the dynamic not-found HTML, which is the only
      // way to assert that the per-request nonce reaches the boundary
      // that issue #411 makes dynamic.
      mockVerifyJwtStateless.mockResolvedValue({
        sub: "account-1",
        sid: "session-1",
        roles: ["admin"],
        token_version: 0,
        kid: "key-1",
      });
      mockIntlMiddleware.mockImplementation((request: NextRequest) => {
        const cspRequest = request.headers.get("Content-Security-Policy");
        const xNonce = request.headers.get("x-nonce");
        const response = new Response(null, { status: 404 });
        if (cspRequest) response.headers.set("x-test-csp-request", cspRequest);
        if (xNonce) response.headers.set("x-test-nonce", xNonce);
        return response;
      });

      const response = await proxy(makeRequest("/missing", "valid-token"));

      const cspRequest = response.headers.get("x-test-csp-request");
      const nonce = response.headers.get("x-test-nonce");
      expect(cspRequest).toBeTruthy();
      expect(nonce).toBeTruthy();
      expect(cspRequest).toContain(`'nonce-${nonce}'`);
      const cspResponse = response.headers.get(
        "Content-Security-Policy-Report-Only",
      );
      expect(cspResponse).toBe(cspRequest);
    });

    it("mints a fresh nonce per request", async () => {
      // Return a fresh Response each call so applyCspHeader writes
      // into distinct header objects.
      mockIntlMiddleware.mockImplementation(
        () => new Response(null, { status: 200 }),
      );

      const r1 = await proxy(makeRequest("/sign-in"));
      const r2 = await proxy(makeRequest("/sign-in"));

      const csp1 = r1.headers.get("Content-Security-Policy-Report-Only") ?? "";
      const csp2 = r2.headers.get("Content-Security-Policy-Report-Only") ?? "";
      const nonce1 = csp1.match(/'nonce-([^']+)'/)?.[1];
      const nonce2 = csp2.match(/'nonce-([^']+)'/)?.[1];

      expect(nonce1).toBeTruthy();
      expect(nonce2).toBeTruthy();
      expect(nonce1).not.toBe(nonce2);
    });
  });
});
