import { screen } from "@testing-library/react";
import { useTranslations } from "next-intl";
import { describe, expect, it } from "vitest";
import { renderWithProviders } from "@/test/test-utils";
import koMessages from "../../messages/ko.json";

function ExampleComponent() {
  const t = useTranslations("home");
  return <span>{t("title")}</span>;
}

describe("useTranslations", () => {
  it("renders messages for the default locale", () => {
    renderWithProviders(<ExampleComponent />);
    expect(screen.getByText("Welcome to AICE Web")).toBeInTheDocument();
  });

  it("renders messages for a different locale", () => {
    renderWithProviders(<ExampleComponent />, {
      locale: "ko",
      messages: koMessages,
    });

    expect(
      screen.getByText("AICE 웹에 오신 것을 환영합니다"),
    ).toBeInTheDocument();
  });
});
