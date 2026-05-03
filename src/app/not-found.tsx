import { headers } from "next/headers";
import { connection } from "next/server";

import { routing } from "@/i18n/routing";
import { REQUEST_URL_HEADER } from "@/proxy";

import "./globals.css";

type NotFoundMessages = {
  title: string;
  description: string;
  backToDashboard: string;
};

type Locale = (typeof routing.locales)[number];

function isLocale(value: string): value is Locale {
  return (routing.locales as readonly string[]).includes(value);
}

/**
 * Derive the locale to render the root not-found document under.
 *
 * The root boundary catches unmatched URLs that escape the `[locale]`
 * segment, but the request URL still carries the user's locale intent
 * for shapes like `/ko/missing` or `/en/missing`.  Reading the original
 * URL from the `x-request-url` header that `proxy.ts` forwards lets
 * `<html lang>` and the body copy track the locale the user actually
 * asked for.  Invalid prefixes (e.g. `/xx/missing`) and the
 * no-locale-prefix shape (`/missing`, the default-locale form under
 * `localePrefix: "as-needed"`) fall back to `routing.defaultLocale`.
 */
function resolveLocale(requestUrl: string | null): Locale {
  if (!requestUrl) return routing.defaultLocale;
  let pathname: string;
  try {
    pathname = new URL(requestUrl).pathname;
  } catch {
    return routing.defaultLocale;
  }
  const firstSegment = pathname.split("/")[1] ?? "";
  return isLocale(firstSegment) ? firstSegment : routing.defaultLocale;
}

export default async function RootNotFound() {
  // Opt out of static rendering so the per-request CSP nonce minted in
  // `src/proxy.ts` reaches every framework script tag.  This boundary
  // catches unmatched URLs that escape the `[locale]` segment (e.g. when
  // next-intl's middleware does not rewrite the request into a locale).
  // Without this opt-out, Next.js prerenders the root not-found at build
  // time and the resulting HTML carries no per-request nonce — which is
  // a hard failure once CSP promotes from Report-Only to enforcing.  See:
  // https://nextjs.org/docs/app/guides/content-security-policy#static-vs-dynamic-rendering-with-csp
  await connection();

  // The root layout (`src/app/layout.tsx`) is a pass-through and the
  // locale provider/theme/font shell lives in `[locale]/layout.tsx`, so
  // this boundary must render its own minimal HTML document.  Derive the
  // locale from the original request URL forwarded by the proxy so a
  // `/ko/missing` request renders Korean copy under `<html lang="ko">`
  // even on an English-default deployment, and vice versa.  Falls back
  // to `routing.defaultLocale` when the prefix is missing or invalid.
  const requestUrl = (await headers()).get(REQUEST_URL_HEADER);
  const locale = resolveLocale(requestUrl);
  const messages = (await import(`@/i18n/messages/${locale}.json`)).default;
  const t = messages.notFound as NotFoundMessages;

  return (
    <html lang={locale}>
      <body
        style={{
          fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "1rem",
          padding: "1.5rem",
          textAlign: "center",
          backgroundColor: "#fff",
          color: "#111",
        }}
      >
        <h1 style={{ fontSize: "1.5rem", fontWeight: 600, margin: 0 }}>
          {t.title}
        </h1>
        <p style={{ maxWidth: "32rem", fontSize: "0.875rem", margin: 0 }}>
          {t.description}
        </p>
        <a
          href={
            locale === routing.defaultLocale
              ? "/dashboard"
              : `/${locale}/dashboard`
          }
          style={{
            fontSize: "0.875rem",
            fontWeight: 500,
            color: "#2563eb",
            textDecoration: "underline",
          }}
        >
          {t.backToDashboard}
        </a>
      </body>
    </html>
  );
}
