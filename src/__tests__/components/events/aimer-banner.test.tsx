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

  /**
   * Stub `fetch` to dispatch on URL: the routing endpoint sees the
   * Phase 1 / Phase 2 decision, the context-token endpoint sees the
   * existing bridge handoff. Tests choose which path the routing
   * endpoint signals.
   */
  function stubRoutingFetch(
    opts: {
      routingBody?: unknown;
      routingStatus?: number;
      contextTokenBody?: unknown;
      contextTokenStatus?: number;
      aimerWebStatus?: number;
      aimerWebBody?: unknown;
    } = {},
  ) {
    const routingBody = opts.routingBody ?? { route: "phase1" };
    const routingStatus = opts.routingStatus ?? 200;
    const contextTokenBody = opts.contextTokenBody ?? {
      contextTokenJws: "ctx.jws",
      eventsEnvelopeJws: "env.jws",
      eventsDataJson: "{}",
      targetUrl: "https://aimer.example.com/api/auth/bridge",
    };
    const contextTokenStatus = opts.contextTokenStatus ?? 200;
    const aimerWebStatus = opts.aimerWebStatus ?? 200;
    const aimerWebBody = opts.aimerWebBody ?? {
      accepted: 1,
      duplicates_skipped: 0,
      received_at: "2026-01-15T00:00:00Z",
      context_jti: "jti-detection-send",
    };
    return vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/aimer/detection-send")) {
        return new Response(JSON.stringify(routingBody), {
          status: routingStatus,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/api/aimer/context-token")) {
        return new Response(JSON.stringify(contextTokenBody), {
          status: contextTokenStatus,
          headers: { "Content-Type": "application/json" },
        });
      }
      // Cross-origin POST to aimer-web's Phase 2 endpoint.
      return new Response(JSON.stringify(aimerWebBody), {
        status: aimerWebStatus,
        headers: { "Content-Type": "application/json" },
      });
    });
  }

  it("Phase 1 path: routing returns phase1, Send hits the bridge via top-level form POST", async () => {
    vi.stubGlobal(
      "fetch",
      stubRoutingFetch({ routingBody: { route: "phase1" } }),
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
    // Phase 1 path: no in-page disclosure is rendered (navigation is
    // the signal).
    expect(screen.queryByTestId("aimer-sent-phase2")).toBeNull();
  });

  it("Phase 2 path: routing returns phase2 envelope, browser POSTs to aimer-web, shows the disclosure", async () => {
    const fetchSpy = stubRoutingFetch({
      routingBody: {
        route: "phase2",
        context_token: "ctx-jws",
        events_envelope: "env-jws",
        events_data: '{"events":[]}',
        context_jti: "jti-detection-send",
        aimer_endpoint_path: "/api/phase2/baseline/batch",
        aimer_endpoint_url:
          "https://aimer.example.com/api/phase2/baseline/batch",
        schema_version: "phase2.baseline.v1",
      },
    });
    vi.stubGlobal("fetch", fetchSpy);

    renderBanner({
      candidates: [{ id: 7, name: "Acme" }],
      customerBridgeEligible: { 7: true },
    });
    fireEvent.click(screen.getByTestId("aimer-send-button"));
    fireEvent.click(screen.getByTestId("aimer-modal-send"));

    // Phase 2 disclosure is rendered locally — no top-level form
    // navigation.
    await waitFor(() =>
      expect(screen.getByTestId("aimer-sent-phase2")).toBeTruthy(),
    );
    expect(submitSpy).not.toHaveBeenCalled();
    // Browser POSTs directly to aimer-web's Phase 2 endpoint.
    const aimerWebCall = fetchSpy.mock.calls.find(([url]) => {
      const u = typeof url === "string" ? url : (url as URL).toString();
      return u.includes("/api/phase2/baseline/batch");
    });
    expect(aimerWebCall).toBeDefined();
    // Context-token route is never called on the Phase 2 path.
    const ctxCall = fetchSpy.mock.calls.find(([url]) => {
      const u = typeof url === "string" ? url : (url as URL).toString();
      return u.includes("/api/aimer/context-token");
    });
    expect(ctxCall).toBeUndefined();
  });

  it("surfaces an error if the routing endpoint fails", async () => {
    vi.stubGlobal(
      "fetch",
      stubRoutingFetch({
        routingStatus: 503,
        routingBody: { error: "aimer_integration_not_configured" },
      }),
    );

    renderBanner({
      candidates: [{ id: 7, name: "Acme" }],
      customerBridgeEligible: { 7: true },
    });
    fireEvent.click(screen.getByTestId("aimer-send-button"));
    fireEvent.click(screen.getByTestId("aimer-modal-send"));

    await waitFor(() => expect(screen.getByTestId("aimer-error")).toBeTruthy());
    expect(submitSpy).not.toHaveBeenCalled();
    // No form is appended on the routing-failure path.
    const formCalls = appendSpy.mock.calls.filter(
      ([n]: [Node]) => n instanceof HTMLFormElement,
    );
    expect(formCalls).toHaveLength(0);
  });

  it("does not append a form when the Phase 1 context-token call fails", async () => {
    vi.stubGlobal(
      "fetch",
      stubRoutingFetch({
        routingBody: { route: "phase1" },
        contextTokenStatus: 503,
        contextTokenBody: { error: "aimer_integration_not_configured" },
      }),
    );

    renderBanner({
      candidates: [{ id: 7, name: "Acme" }],
      customerBridgeEligible: { 7: true },
    });
    fireEvent.click(screen.getByTestId("aimer-send-button"));
    fireEvent.click(screen.getByTestId("aimer-modal-send"));

    await waitFor(() => expect(screen.getByTestId("aimer-error")).toBeTruthy());
    expect(submitSpy).not.toHaveBeenCalled();
    const formCalls = appendSpy.mock.calls.filter(
      ([n]: [Node]) => n instanceof HTMLFormElement,
    );
    expect(formCalls).toHaveLength(0);
  });

  it("removes the partially-built form when Phase 1 submit() throws", async () => {
    submitSpy.mockImplementation(() => {
      throw new Error("submit blocked");
    });
    vi.stubGlobal(
      "fetch",
      stubRoutingFetch({ routingBody: { route: "phase1" } }),
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
