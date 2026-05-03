import { connection } from "next/server";
import { getTranslations } from "next-intl/server";

import { Link } from "@/i18n/navigation";

export default async function LocaleNotFound() {
  // Opt out of static rendering so the per-request CSP nonce minted in
  // `src/proxy.ts` reaches every framework script tag on this page.
  // Without this opt-out, Next.js prerenders not-found at build time and
  // the resulting HTML carries no per-request nonce, which becomes a hard
  // failure once CSP promotes from Report-Only to enforcing.  See:
  // https://nextjs.org/docs/app/guides/content-security-policy#static-vs-dynamic-rendering-with-csp
  await connection();

  const t = await getTranslations("notFound");

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
      <p className="text-muted-foreground max-w-md text-sm">
        {t("description")}
      </p>
      <Link
        href="/dashboard"
        className="text-primary text-sm font-medium underline-offset-4 hover:underline"
      >
        {t("backToDashboard")}
      </Link>
    </main>
  );
}
