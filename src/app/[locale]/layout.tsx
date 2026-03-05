import type { Metadata } from "next";
import { Roboto } from "next/font/google";
import { notFound } from "next/navigation";
import { hasLocale, NextIntlClientProvider } from "next-intl";
import { setRequestLocale } from "next-intl/server";
import { ThemeProvider } from "next-themes";

import { SessionExtensionDialog } from "@/components/session/session-extension-dialog";
import { routing } from "@/i18n/routing";
import { themeConfig } from "@/lib/theme";

import "../globals.css";

const roboto = Roboto({
  subsets: ["latin"],
  weight: ["400", "500", "700"],
});

export const metadata: Metadata = {
  title: "aice-web-next",
  description: "aice-web-next",
};

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export default async function LocaleLayout({
  children,
  params,
}: Readonly<{
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}>) {
  const { locale } = await params;

  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }

  setRequestLocale(locale);

  return (
    <html lang={locale} suppressHydrationWarning>
      <body className={roboto.className}>
        <ThemeProvider {...themeConfig}>
          <NextIntlClientProvider>
            {children}
            <SessionExtensionDialog />
          </NextIntlClientProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
