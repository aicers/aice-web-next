import { createTranslator } from "use-intl/core";
import { describe, expect, it } from "vitest";
import enMessages from "../../messages/en.json";
import { nestMessages } from "./nest-messages";
import { resolveLocale } from "./request";
import { routing } from "./routing";

describe("server-side translations", () => {
  it("falls back to the default locale when the requested one is unsupported", () => {
    expect(resolveLocale("fr")).toBe(routing.defaultLocale);
  });

  it("creates a translator for the home namespace", () => {
    const translator = createTranslator({
      locale: "en",
      messages: nestMessages(enMessages) as { home: { title: string } },
      namespace: "home",
    });

    expect(translator("title")).toBe("Welcome to AICE Web");
  });
});
