/**
 * Unsupervised Engine informational panel — render coverage. The panel
 * has no form state and no serialiser, per the issue: only the static
 * title/description plus the absence of any input controls is checked.
 */

import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";

import { UnsupervisedEnginePanel } from "@/components/node/forms/unsupervised-engine-panel";
import enMessages from "@/i18n/messages/en.json";

describe("UnsupervisedEnginePanel", () => {
  it("renders the informational title and description with no inputs", () => {
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <UnsupervisedEnginePanel />
      </NextIntlClientProvider>,
    );
    expect(
      screen.getByRole("heading", {
        name: enMessages.nodes.forms.unsupervisedEngine.title,
      }),
    ).toBeTruthy();
    expect(
      screen.getByText(enMessages.nodes.forms.unsupervisedEngine.description),
    ).toBeTruthy();
    expect(document.querySelector("input")).toBeNull();
    expect(document.querySelector("select")).toBeNull();
  });
});
