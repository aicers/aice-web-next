import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import createMiddleware from "next-intl/middleware";

import { routing } from "./i18n/routing";
import { verifyJwtStateless } from "./lib/auth/jwt-verify-stateless";
import { AUTH_COOKIE_NAME, isPublicPath } from "./lib/auth/proxy-auth";

const intlMiddleware = createMiddleware(routing);

export default async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

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
