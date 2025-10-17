"use client";

import { useLocale, useTranslations } from "next-intl";
import { useTransition } from "react";
import { usePathname, useRouter } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";

export function LanguageSwitcher() {
  const locale = useLocale();
  const t = useTranslations("languageSwitcher");
  const router = useRouter();
  const pathname = usePathname();
  const [isPending, startTransition] = useTransition();

  return (
    <label className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
      <span>{t("label")}</span>
      <select
        className="rounded-md border border-input bg-background px-3 py-1 text-foreground shadow-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60"
        disabled={isPending}
        value={locale}
        onChange={(event) => {
          const nextLocale = event.target.value;
          startTransition(() =>
            router.replace(pathname, {
              locale: nextLocale,
            }),
          );
        }}
      >
        {routing.locales.map((locale) => (
          <option key={locale} value={locale}>
            {t(`option.${locale}` as const)}
          </option>
        ))}
      </select>
    </label>
  );
}
