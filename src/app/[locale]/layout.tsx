import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { LanguageSwitcher } from "@/components/language-switcher";
import { resolveLocale } from "@/i18n/request";
import { routing } from "@/i18n/routing";
import type { LocaleParam } from "@/i18n/types";

type LocaleLayoutProps = {
  children: ReactNode;
  params: Promise<LocaleParam>;
};

export function generateStaticParams(): LocaleParam[] {
  return routing.locales.map((locale) => ({ locale }));
}

export default async function LocaleLayout({
  children,
  params,
}: LocaleLayoutProps) {
  const resolvedParams = await params;
  const locale = resolveLocale(resolvedParams.locale);
  const t = await getTranslations({
    locale,
    namespace: "layout",
  });

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between px-4 py-4">
          <span className="text-lg font-semibold tracking-tight">
            {t("title")}
          </span>
          <LanguageSwitcher />
        </div>
      </header>
      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-4 py-8">
        {children}
      </main>
    </div>
  );
}
