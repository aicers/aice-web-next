import { getRequestConfig } from "next-intl/server";
import { nestMessages } from "./nest-messages";
import { routing } from "./routing";

type AppLocale = (typeof routing.locales)[number];

function resolveLocale(locale: string | undefined): AppLocale {
  if (typeof locale === "string") {
    return (routing.locales as readonly string[]).includes(locale)
      ? (locale as AppLocale)
      : routing.defaultLocale;
  }

  return routing.defaultLocale;
}

export default getRequestConfig(async ({ locale }) => {
  const finalLocale = resolveLocale(locale);
  const flatMessages = (await import(`../../messages/${finalLocale}.json`))
    .default as Record<string, string>;
  const messages = nestMessages(flatMessages);

  return {
    locale: finalLocale,
    messages,
  };
});

export { resolveLocale };
