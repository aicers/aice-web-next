import type { Metadata } from "next";
import { Roboto } from "next/font/google";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { hasLocale, NextIntlClientProvider } from "next-intl";
import { setRequestLocale } from "next-intl/server";
import { ThemeProvider } from "next-themes";

import { SessionExtensionDialog } from "@/components/session/session-extension-dialog";
import { routing } from "@/i18n/routing";
import { appIcons } from "@/lib/icons";
import { NONCE_HEADER } from "@/lib/security/csp";
import { themeConfig } from "@/lib/theme";

import "../globals.css";

const roboto = Roboto({
  subsets: ["latin"],
  weight: ["400", "500", "700"],
});

export const metadata: Metadata = {
  title: "Clumit Security",
  description: "Clumit Security",
  icons: appIcons,
};

export default async function LocaleLayout({
  children,
  params,
}: Readonly<{
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}>) {
  // Opt out of static rendering so the per-request CSP nonce minted in
  // `src/proxy.ts` actually reaches every framework script tag.  Next's
  // CSP/nonce flow only injects nonces during dynamic SSR — pages
  // generated at build time have no per-request nonce to attach.  See
  // Next.js docs: https://nextjs.org/docs/app/guides/content-security-policy#static-vs-dynamic-rendering-with-csp
  await connection();

  const { locale } = await params;

  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }

  setRequestLocale(locale);

  // `next-themes` injects an inline pre-paint script to set the theme
  // before hydration. That script is app-emitted (not framework-
  // emitted), so Next.js's renderer does not stamp the per-request
  // nonce on it — the package exposes its own `nonce` prop, and CSP
  // refuses the script without it under the script-src nonce policy.
  const nonce = (await headers()).get(NONCE_HEADER) ?? undefined;

  return (
    <html lang={locale} suppressHydrationWarning>
      <body className={roboto.className}>
        <ThemeProvider {...themeConfig} nonce={nonce}>
          <NextIntlClientProvider>
            {children}
            <SessionExtensionDialog />
          </NextIntlClientProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
