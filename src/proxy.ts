import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import createMiddleware from "next-intl/middleware";

import { routing } from "./i18n/routing";
import { verifyJwtStateless } from "./lib/auth/jwt-verify-stateless";
import { AUTH_COOKIE_NAME, isPublicPath } from "./lib/auth/proxy-auth";

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

  // Forward the request URL on every request — public and protected
  // alike — so the gate layouts can read it via `headers()` regardless
  // of which auth path was taken. Mutating `request.headers` in-place
  // before calling `intlMiddleware(request)` propagates to the RSC
  // request that next-intl forwards.
  request.headers.set(REQUEST_URL_HEADER, request.nextUrl.toString());

  // Public paths: skip auth, run locale middleware
  if (isPublicPath(pathname)) {
    return intlMiddleware(request);
  }

  // Protected path: require valid JWT
  const token = request.cookies.get(AUTH_COOKIE_NAME)?.value;
  if (!token) {
    return redirectToSignIn(request);
  }

  try {
    await verifyJwtStateless(token);
  } catch (err) {
    console.error("[proxy] JWT verification failed:", (err as Error).message);
    return redirectToSignIn(request);
  }

  return intlMiddleware(request);
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
