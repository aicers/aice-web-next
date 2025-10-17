import { render } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactElement, ReactNode } from "react";
import { AuthProvider } from "@/components/auth/auth-provider";
import { nestMessages } from "@/i18n/nest-messages";
import enMessages from "../../messages/en.json";

type ProviderOptions = {
  locale?: string;
  messages?: Record<string, string>;
};

function Providers({
  children,
  locale = "en",
  messages = enMessages,
}: {
  readonly children: ReactNode;
  readonly locale?: string;
  readonly messages?: Record<string, string>;
}) {
  const finalMessages = messages ?? enMessages;
  return (
    <AuthProvider>
      <NextIntlClientProvider
        locale={locale}
        messages={nestMessages(finalMessages)}
      >
        {children}
      </NextIntlClientProvider>
    </AuthProvider>
  );
}

export function renderWithProviders(
  ui: ReactElement,
  options: ProviderOptions = {},
) {
  const { locale, messages } = options;
  return render(
    <Providers locale={locale} messages={messages}>
      {ui}
    </Providers>,
  );
}
