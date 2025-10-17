import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { resolveLocale } from "@/i18n/request";
import type { LocalePageProps } from "@/i18n/types";

export default async function HomePage({ params }: LocalePageProps) {
  const resolvedParams = await params;
  const locale = resolveLocale(resolvedParams.locale);
  const t = await getTranslations({
    locale,
    namespace: "home",
  });

  return (
    <section className="flex flex-1 flex-col justify-center gap-6 py-12">
      <div className="space-y-3">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
          {t("title")}
        </h1>
        <p className="text-base text-muted-foreground sm:text-lg">
          {t("description")}
        </p>
      </div>
      <div>
        <Link
          href="/signin"
          className="inline-flex items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm transition hover:bg-primary/90"
        >
          {t("cta")}
        </Link>
      </div>
    </section>
  );
}
