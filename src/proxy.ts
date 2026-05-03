import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import createMiddleware from "next-intl/middleware";

import { routing } from "./i18n/routing";
import { verifyJwtStateless } from "./lib/auth/jwt-verify-stateless";
import { AUTH_COOKIE_NAME, isPublicPath } from "./lib/auth/proxy-auth";
import {
  buildCspHeaderValue,
  CSP_HEADER_NAME,
  CSP_REQUEST_HEADER,
  generateCspNonce,
  NONCE_HEADER,
} from "./lib/security/csp";

const intlMiddleware = createMiddleware(routing);

/**
 * Header used to forward the original request URL to RSC server
 * components, so layouts (which don't receive `searchParams`) can apply
 * search-param-scoped guards above any Suspense boundary. The Node
 * settings page wraps its async work in a `loading.tsx` Suspense, so a
 * `forbidden()` thrown from inside the page lands after headers commit
 * at 200; reading this header in `nodes/(gate)/layout.tsx` lets the
 * mixed-permission write gate enforce the `?dialog=edit&id=…` HTTP 403
 * contract before the loading fallback streams.
 */
export const REQUEST_URL_HEADER = "x-request-url";

export default async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Mint a per-request CSP nonce. The proxy's matcher already
  // excludes `/api/*` and other non-HTML paths, so every request
  // that lands here gets a nonce + CSP header.
  //
  // Two request headers must be set so Next.js's renderer attaches
  // `nonce` attributes to framework scripts, page bundles, and inline
  // scripts it emits:
  //   • `x-nonce` — read by app code that wants the raw nonce
  //   • `Content-Security-Policy` — parsed by Next's renderer for the
  //     `'nonce-{value}'` pattern; the value here is the enforcing
  //     policy even though the response ships it as Report-Only.
  // Mutating in place is sufficient because next-intl's middleware
  // forwards the request headers via
  // `NextResponse.next/rewrite({ request: { headers: new Headers(req.headers) } })`,
  // so our mutations propagate to the RSC render path.
  const nonce = generateCspNonce();
  const cspHeaderValue = buildCspHeaderValue(nonce);
  request.headers.set(NONCE_HEADER, nonce);
  request.headers.set(CSP_REQUEST_HEADER, cspHeaderValue);

  // Forward the request URL on every request — public and protected
  // alike — so the gate layouts can read it via `headers()` regardless
  // of which auth path was taken. Mutating `request.headers` in-place
  // before calling `intlMiddleware(request)` propagates to the RSC
  // request that next-intl forwards.
  request.headers.set(REQUEST_URL_HEADER, request.nextUrl.toString());

  // Public paths: skip auth, run locale middleware
  if (isPublicPath(pathname)) {
    const response = intlMiddleware(request);
    return applyCspHeader(response, cspHeaderValue);
  }

  // Protected path: require valid JWT
  const token = request.cookies.get(AUTH_COOKIE_NAME)?.value;
  if (!token) {
    return applyCspHeader(redirectToSignIn(request), cspHeaderValue);
  }

  try {
    await verifyJwtStateless(token);
  } catch (err) {
    console.error("[proxy] JWT verification failed:", (err as Error).message);
    return applyCspHeader(redirectToSignIn(request), cspHeaderValue);
  }

  const response = intlMiddleware(request);
  return applyCspHeader(response, cspHeaderValue);
}

/**
 * Attach the Content-Security-Policy-Report-Only header to a
 * response on its way back to the browser.  Works for both `Response`
 * (intl middleware result) and `NextResponse` (sign-in redirect).
 *
 * Idempotent — replaces any existing CSP header so a downstream
 * handler can override the policy if it really needs to (none do
 * today).
 */
function applyCspHeader<R extends Response>(
  response: R,
  cspHeaderValue: string,
): R {
  response.headers.set(CSP_HEADER_NAME, cspHeaderValue);
  return response;
}

function redirectToSignIn(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;

  // Preserve locale prefix for non-default locales
  let locale = routing.defaultLocale;
  for (const l of routing.locales) {
    if (pathname.startsWith(`/${l}/`) || pathname === `/${l}`) {
      locale = l;
      break;
    }
  }

  const prefix = locale === routing.defaultLocale ? "" : `/${locale}`;
  const url = new URL(`${prefix}/sign-in`, request.url);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: "/((?!api|trpc|_next|_vercel|.*\\..*).*)",
};
