import { getTranslations } from "next-intl/server";
import { SignInForm } from "@/features/auth/sign-in-form";
import { resolveLocale } from "@/i18n/request";
import type { LocalePageProps } from "@/i18n/types";

export default async function SignInPage({ params }: LocalePageProps) {
  const resolvedParams = await params;
  const locale = resolveLocale(resolvedParams.locale);
  const t = await getTranslations({
    locale,
    namespace: "signin",
  });

  return (
    <section className="mx-auto flex w-full max-w-md flex-col gap-6">
      <div className="space-y-2 text-center sm:text-left">
        <h1 className="text-3xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="text-sm text-muted-foreground sm:text-base">
          {t("description")}
        </p>
      </div>
      <SignInForm />
    </section>
  );
}
