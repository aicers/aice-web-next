/**
 * Render-level coverage for {@link AimerBanner} (#440 / Sub-7.2.E).
 *
 * Covers the disabled-state matrix (no candidates, all ineligible,
 * setup not configured), the modal radio gating in the multi-customer
 * case, and the form-build / fetch / append-and-submit DOM-level
 * contract spelled out in the issue's acceptance criteria.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: () => {}, replace: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {} }),
}));

import {
  AimerBanner,
  buildAimerHiddenForm,
} from "@/components/events/aimer-banner";
import enMessages from "@/i18n/messages/en.json";
import type { AimerCustomerCandidate } from "@/lib/aimer/candidate-customers";
import type { AimerIntegrationSetupStatus } from "@/lib/aimer/setup-status";
import type { EventLocator } from "@/lib/events/event-locator";

const LOCATOR: EventLocator = {
  id: "evt-AAAA-BBBB-CCCC",
};

const CONFIGURED: AimerIntegrationSetupStatus = { configured: true };

function renderBanner(
  opts: {
    candidates?: AimerCustomerCandidate[];
    customerBridgeEligible?: Record<number, boolean>;
    aimerSetup?: AimerIntegrationSetupStatus;
  } = {},
) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <AimerBanner
        locator={LOCATOR}
        candidates={opts.candidates ?? []}
        customerBridgeEligible={opts.customerBridgeEligible ?? {}}
        aimerSetup={opts.aimerSetup ?? CONFIGURED}
      />
    </NextIntlClientProvider>,
  );
}

describe("AimerBanner – disabled states", () => {
  it("disables the button when there are no candidates", () => {
    renderBanner({ candidates: [] });
    const button = screen.getByTestId("aimer-send-button") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("disables the button when every candidate is ineligible", () => {
    renderBanner({
      candidates: [{ id: 1, name: "Acme" }],
      customerBridgeEligible: { 1: false },
    });
    const button = screen.getByTestId("aimer-send-button") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("disables the button when aimerSetup.configured is false", () => {
    renderBanner({
      candidates: [{ id: 1, name: "Acme" }],
      customerBridgeEligible: { 1: true },
      aimerSetup: { configured: false, missingReasons: ["bridgeUrl"] },
    });
    const button = screen.getByTestId("aimer-send-button") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("enables the button when at least one candidate is eligible and setup is configured", () => {
    renderBanner({
      candidates: [{ id: 1, name: "Acme" }],
      customerBridgeEligible: { 1: true },
      aimerSetup: CONFIGURED,
    });
    const button = screen.getByTestId("aimer-send-button") as HTMLButtonElement;
    expect(button.disabled).toBe(false);
  });

  it("enables the button in the mixed-eligibility multi-candidate case", () => {
    renderBanner({
      candidates: [
        { id: 1, name: "Acme" },
        { id: 2, name: "Beta" },
      ],
      customerBridgeEligible: { 1: true, 2: false },
    });
    const button = screen.getByTestId("aimer-send-button") as HTMLButtonElement;
    expect(button.disabled).toBe(false);
  });
});

describe("AimerBanner – modal radio gating", () => {
  it("shows a radio per candidate, marks ineligible ones as disabled, and starts with no selection", () => {
    renderBanner({
      candidates: [
        { id: 1, name: "Acme" },
        { id: 2, name: "Beta" },
      ],
      customerBridgeEligible: { 1: true, 2: false },
    });
    fireEvent.click(screen.getByTestId("aimer-send-button"));
    const radios = screen.getAllByRole("radio") as HTMLInputElement[];
    expect(radios).toHaveLength(2);
    const acme = radios.find((r) => r.value === "1");
    const beta = radios.find((r) => r.value === "2");
    expect(acme?.disabled).toBe(false);
    expect(beta?.disabled).toBe(true);
    // Multi-candidate modal must force an explicit operator choice; no
    // radio is preselected and Send stays disabled until one is picked.
    expect(acme?.checked).toBe(false);
    expect(beta?.checked).toBe(false);
    const sendBtn = screen.getByTestId("aimer-modal-send") as HTMLButtonElement;
    expect(sendBtn.disabled).toBe(true);
    fireEvent.click(acme as HTMLInputElement);
    expect(acme?.checked).toBe(true);
    expect(sendBtn.disabled).toBe(false);
  });
});

describe("AimerBanner – DOM-level submit contract", () => {
  let appendSpy: ReturnType<typeof vi.spyOn>;
  let submitSpy: ReturnType<typeof vi.fn>;
  let createdForm: HTMLFormElement | null = null;

  beforeEach(() => {
    createdForm = null;
    submitSpy = vi.fn();
    const originalAppendChild = document.body.appendChild.bind(document.body);
    appendSpy = vi.spyOn(document.body, "appendChild").mockImplementation(((
      node: Node,
    ) => {
      if (node instanceof HTMLFormElement) {
        createdForm = node;
        // Patch submit() so the test does not actually navigate.
        node.submit = submitSpy as unknown as typeof node.submit;
      }
      return originalAppendChild(node);
    }) as typeof document.body.appendChild);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("appends the hidden form and calls submit() on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              contextTokenJws: "ctx.jws",
              eventsEnvelopeJws: "env.jws",
              eventsDataJson: '{"hello":"world"}',
              targetUrl: "https://aimer.example.com/api/auth/bridge",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );

    renderBanner({
      candidates: [{ id: 7, name: "Acme" }],
      customerBridgeEligible: { 7: true },
    });
    fireEvent.click(screen.getByTestId("aimer-send-button"));
    fireEvent.click(screen.getByTestId("aimer-modal-send"));

    await waitFor(() => expect(submitSpy).toHaveBeenCalledTimes(1));
    expect(appendSpy).toHaveBeenCalled();
    expect(createdForm).toBeTruthy();
    expect(createdForm?.action).toBe(
      "https://aimer.example.com/api/auth/bridge",
    );
    expect(createdForm?.method).toBe("post");
    expect(createdForm?.enctype).toBe("multipart/form-data");
    // The form is intentionally NOT removed after a successful submit.
    expect(createdForm?.parentNode).not.toBeNull();
  });

  it("does not append a form on a 4xx response and surfaces an error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: "aimer_integration_not_configured" }),
            { status: 503, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );

    renderBanner({
      candidates: [{ id: 7, name: "Acme" }],
      customerBridgeEligible: { 7: true },
    });
    fireEvent.click(screen.getByTestId("aimer-send-button"));
    fireEvent.click(screen.getByTestId("aimer-modal-send"));

    await waitFor(() => expect(screen.getByTestId("aimer-error")).toBeTruthy());
    expect(submitSpy).not.toHaveBeenCalled();
    // No form was attached to the body.
    const formCalls = appendSpy.mock.calls.filter(
      ([n]: [Node]) => n instanceof HTMLFormElement,
    );
    expect(formCalls).toHaveLength(0);
  });

  it("removes the partially-built form when submit() throws", async () => {
    submitSpy.mockImplementation(() => {
      throw new Error("submit blocked");
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              contextTokenJws: "ctx.jws",
              eventsEnvelopeJws: "env.jws",
              eventsDataJson: "{}",
              targetUrl: "https://aimer.example.com/api/auth/bridge",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );

    renderBanner({
      candidates: [{ id: 7, name: "Acme" }],
      customerBridgeEligible: { 7: true },
    });
    fireEvent.click(screen.getByTestId("aimer-send-button"));
    fireEvent.click(screen.getByTestId("aimer-modal-send"));

    await waitFor(() => expect(screen.getByTestId("aimer-error")).toBeTruthy());
    expect(createdForm).toBeTruthy();
    // Form was removed from its parent before the error rendered.
    expect(createdForm?.parentNode).toBeNull();
  });
});

describe("buildAimerHiddenForm", () => {
  it("creates a multipart POST form with the three named text parts", () => {
    const form = buildAimerHiddenForm(
      {
        contextTokenJws: "ctx",
        eventsEnvelopeJws: "env",
        eventsDataJson: "{}",
        targetUrl: "https://aimer.example.com/api/auth/bridge",
      },
      document,
    );
    expect(form.action).toBe("https://aimer.example.com/api/auth/bridge");
    expect(form.method).toBe("post");
    expect(form.enctype).toBe("multipart/form-data");
    expect(form.hidden).toBe(true);
    const inputs = Array.from(form.querySelectorAll<HTMLInputElement>("input"));
    expect(inputs.map((i) => [i.name, i.type, i.value])).toEqual([
      ["context_token", "hidden", "ctx"],
      ["events_envelope", "hidden", "env"],
      ["events_data", "hidden", "{}"],
    ]);
  });
});
