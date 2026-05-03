import { connection } from "next/server";

import { routing } from "@/i18n/routing";

import "./globals.css";

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
  // this boundary must render its own minimal HTML document.  We render
  // a static English message rather than reaching for next-intl: the
  // request that lands here has no resolved locale.
  return (
    <html lang={routing.defaultLocale}>
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
          404 — Page not found
        </h1>
        <p style={{ maxWidth: "32rem", fontSize: "0.875rem", margin: 0 }}>
          The page you are looking for does not exist or has been moved.
        </p>
        <a
          href="/"
          style={{
            fontSize: "0.875rem",
            fontWeight: 500,
            color: "#2563eb",
            textDecoration: "underline",
          }}
        >
          Back to home
        </a>
      </body>
    </html>
  );
}
