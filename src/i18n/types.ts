import type { routing } from "./routing";

export type AppLocale = (typeof routing)["locales"][number];

export type LocaleParam = {
  locale: string;
};

export type LocalePageProps = {
  params: Promise<LocaleParam>;
};
