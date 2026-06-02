/**
 * Render-level coverage for {@link AimerBanner} (#629 analyze-bridge
 * rewire).
 *
 * Covers the disabled-state matrix (no candidates, all ineligible,
 * setup not configured), the modal radio gating in the multi-customer
 * case, and the DOM-level form-build / fetch / submit contract spelled
 * out in the analyze-bridge flow.
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
  buildAnalyzeBridgeForm,
  buildAnalyzeBridgeTargetName,
} from "@/components/events/aimer-banner";
import enMessages from "@/i18n/messages/en.json";
import type { AimerCustomerCandidate } from "@/lib/aimer/candidate-customers";
import type { AimerIntegrationSetupStatus } from "@/lib/aimer/setup-status";
import type { EventLocator } from "@/lib/events/event-locator";

const LOCATOR: EventLocator = {
  id: "12345",
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
    expect(acme?.checked).toBe(false);
    expect(beta?.checked).toBe(false);
    const sendBtn = screen.getByTestId("aimer-modal-send") as HTMLButtonElement;
    expect(sendBtn.disabled).toBe(true);
    fireEvent.click(acme as HTMLInputElement);
    expect(acme?.checked).toBe(true);
    expect(sendBtn.disabled).toBe(false);
  });
});

describe("AimerBanner – analyze-bridge submit contract", () => {
  let appendSpy: ReturnType<typeof vi.spyOn>;
  let submitSpy: ReturnType<typeof vi.fn>;
  let openSpy: ReturnType<typeof vi.fn>;
  let openedWindowClose: ReturnType<typeof vi.fn> & (() => void);
  let openedWindows: Array<{
    name: string;
    closed: boolean;
    close: () => void;
  }>;
  let createdForm: HTMLFormElement | null = null;

  beforeEach(() => {
    createdForm = null;
    submitSpy = vi.fn();
    openedWindowClose = vi.fn() as typeof openedWindowClose;
    openedWindows = [];
    openSpy = vi.fn((_url: string, target: string) => {
      const w = {
        name: target,
        closed: false,
        close: () => {
          w.closed = true;
          openedWindowClose();
        },
      };
      openedWindows.push(w);
      return w as unknown as Window;
    });
    vi.stubGlobal("open", openSpy);
    const originalAppendChild = document.body.appendChild.bind(document.body);
    appendSpy = vi.spyOn(document.body, "appendChild").mockImplementation(((
      node: Node,
    ) => {
      if (node instanceof HTMLFormElement) {
        createdForm = node;
        node.submit = submitSpy as unknown as typeof node.submit;
      }
      return originalAppendChild(node);
    }) as typeof document.body.appendChild);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function stubAnalyzeEnvelopeFetch(
    opts: { status?: number; body?: unknown } = {},
  ) {
    const status = opts.status ?? 200;
    const body = opts.body ?? {
      contextToken: "ctx.jws",
      eventsEnvelope: "env.jws",
      eventsData: '{"event_key":"12345"}',
      analyzeParamsToken: "params.jws",
      targetUrl: "https://aimer.example.com/api/analysis/analyze-bridge",
    };
    return vi.fn(
      async (_input?: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        }),
    );
  }

  it("reserves the target window synchronously on click, then submits the form into it after mint", async () => {
    const fetchSpy = stubAnalyzeEnvelopeFetch();
    vi.stubGlobal("fetch", fetchSpy);

    renderBanner({
      candidates: [{ id: 7, name: "Acme" }],
      customerBridgeEligible: { 7: true },
    });
    fireEvent.click(screen.getByTestId("aimer-send-button"));
    fireEvent.click(screen.getByTestId("aimer-modal-send"));

    // The pre-open must happen synchronously on the click — before
    // any await — so popup blockers see it under the still-fresh
    // transient activation (#629 reviewer round 2).
    expect(openSpy).toHaveBeenCalledTimes(1);
    const [openedUrl, openedTarget] = openSpy.mock.calls[0];
    expect(openedUrl).toBe("about:blank");
    expect(openedTarget).toMatch(/^aimer-analyze-bridge-/);

    await waitFor(() => expect(submitSpy).toHaveBeenCalledTimes(1));
    expect(createdForm).toBeTruthy();
    expect(createdForm?.action).toBe(
      "https://aimer.example.com/api/analysis/analyze-bridge",
    );
    expect(createdForm?.method).toBe("post");
    expect(createdForm?.enctype).toBe("multipart/form-data");
    // Form retargets into the pre-opened window by name, not `_blank`.
    expect(createdForm?.target).toBe(openedTarget);
    // The reserved tab is not closed on the happy path — the submit
    // navigates it.
    expect(openedWindowClose).not.toHaveBeenCalled();

    const mintCall = fetchSpy.mock.calls.find(([url]) => {
      const u = typeof url === "string" ? url : (url as URL).toString();
      return u.includes("/api/aimer/analyze-envelope");
    });
    expect(mintCall).toBeDefined();
  });

  it("falls back to target=_blank when window.open returns null (blocked popup)", async () => {
    openSpy.mockReturnValue(null as unknown as Window);
    const fetchSpy = stubAnalyzeEnvelopeFetch();
    vi.stubGlobal("fetch", fetchSpy);

    renderBanner({
      candidates: [{ id: 7, name: "Acme" }],
      customerBridgeEligible: { 7: true },
    });
    fireEvent.click(screen.getByTestId("aimer-send-button"));
    fireEvent.click(screen.getByTestId("aimer-modal-send"));

    await waitFor(() => expect(submitSpy).toHaveBeenCalledTimes(1));
    expect(createdForm?.target).toBe("_blank");
  });

  it("closes the reserved tab and surfaces an error when the envelope-mint endpoint fails", async () => {
    vi.stubGlobal(
      "fetch",
      stubAnalyzeEnvelopeFetch({
        status: 503,
        body: { error: "aimer_integration_not_configured" },
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
    // The pre-opened tab is closed so the user is not left staring at
    // a stale `about:blank` page after a mint failure.
    expect(openedWindowClose).toHaveBeenCalledTimes(1);
  });

  it("uses a globally unique target name per click so two fresh banner mounts never collide", async () => {
    // Browser named windows are global to the opener, so reusing a
    // target name across mounts (or across two banners on the same
    // page) would navigate an existing Aimer result tab instead of
    // opening a fresh one. The target name must be globally unique
    // per click (#629 reviewer round 7).
    const fetchSpy = stubAnalyzeEnvelopeFetch();
    vi.stubGlobal("fetch", fetchSpy);

    const first = renderBanner({
      candidates: [{ id: 7, name: "Acme" }],
      customerBridgeEligible: { 7: true },
    });
    fireEvent.click(screen.getByTestId("aimer-send-button"));
    fireEvent.click(screen.getByTestId("aimer-modal-send"));
    await waitFor(() => expect(submitSpy).toHaveBeenCalledTimes(1));
    const firstTarget = openSpy.mock.calls[0][1] as string;
    first.unmount();

    renderBanner({
      candidates: [{ id: 7, name: "Acme" }],
      customerBridgeEligible: { 7: true },
    });
    fireEvent.click(screen.getByTestId("aimer-send-button"));
    fireEvent.click(screen.getByTestId("aimer-modal-send"));
    await waitFor(() => expect(submitSpy).toHaveBeenCalledTimes(2));
    const secondTarget = openSpy.mock.calls[1][1] as string;

    expect(firstTarget).toMatch(/^aimer-analyze-bridge-/);
    expect(secondTarget).toMatch(/^aimer-analyze-bridge-/);
    expect(firstTarget).not.toBe(secondTarget);
  });
});

describe("buildAnalyzeBridgeTargetName", () => {
  it("returns a fresh globally unique name on each call (#629 reviewer round 7)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 128; i += 1) {
      const name = buildAnalyzeBridgeTargetName();
      expect(name).toMatch(/^aimer-analyze-bridge-/);
      seen.add(name);
    }
    expect(seen.size).toBe(128);
  });
});

describe("AimerBanner – force-flow arming via ?aimerForce=1", () => {
  let submitSpy: ReturnType<typeof vi.fn>;
  let originalReplaceState: typeof window.history.replaceState;

  beforeEach(() => {
    submitSpy = vi.fn();
    vi.stubGlobal("open", () => ({ name: "", closed: false, close: () => {} }));
    const originalAppendChild = document.body.appendChild.bind(document.body);
    vi.spyOn(document.body, "appendChild").mockImplementation(((node: Node) => {
      if (node instanceof HTMLFormElement) {
        node.submit = submitSpy as unknown as typeof node.submit;
      }
      return originalAppendChild(node);
    }) as typeof document.body.appendChild);
    originalReplaceState = window.history.replaceState.bind(window.history);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.history.replaceState = originalReplaceState;
    // Reset URL to a clean slate so tests don't leak state.
    window.history.replaceState(window.history.state, "", "/");
  });

  function stubAnalyzeEnvelopeFetch() {
    return vi.fn(
      async (_input?: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            contextToken: "ctx.jws",
            eventsEnvelope: "env.jws",
            eventsData: '{"event_key":"12345"}',
            analyzeParamsToken: "params.jws",
            targetUrl: "https://aimer.example.com/api/analysis/analyze-bridge",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
  }

  function lastMintCallBody(
    fetchSpy: ReturnType<typeof stubAnalyzeEnvelopeFetch>,
  ): Record<string, unknown> | null {
    const call = fetchSpy.mock.calls.find(([url]) => {
      const u = typeof url === "string" ? url : (url as URL).toString();
      return u.includes("/api/aimer/analyze-envelope");
    });
    if (!call) return null;
    const init = call[1] as RequestInit | undefined;
    if (!init?.body) return null;
    return JSON.parse(String(init.body)) as Record<string, unknown>;
  }

  it("arms force=true when the URL carries ?aimerForce=1 and strips the param via replaceState once the click consumes it", async () => {
    window.history.replaceState(
      window.history.state,
      "",
      "/detection/events/12345?aimerForce=1&keep=me",
    );
    const replaceSpy = vi.spyOn(window.history, "replaceState");
    const fetchSpy = stubAnalyzeEnvelopeFetch();
    vi.stubGlobal("fetch", fetchSpy);

    renderBanner({
      candidates: [{ id: 7, name: "Acme" }],
      customerBridgeEligible: { 7: true },
    });

    // Mount arms the flag but keeps the URL param so a refresh before
    // the click re-arms force on the next mount.
    expect(window.location.search).toContain("aimerForce=1");
    expect(window.location.search).toContain("keep=me");

    fireEvent.click(screen.getByTestId("aimer-send-button"));
    fireEvent.click(screen.getByTestId("aimer-modal-send"));
    await waitFor(() => expect(submitSpy).toHaveBeenCalledTimes(1));

    const body = lastMintCallBody(fetchSpy);
    expect(body?.force).toBe(true);

    // The click consumed the arm; the param is now stripped.
    expect(window.location.search).not.toContain("aimerForce=1");
    expect(window.location.search).toContain("keep=me");
    expect(replaceSpy).toHaveBeenCalled();
  });

  it("preserves the ?aimerForce=1 arm across a refresh before the click", async () => {
    window.history.replaceState(
      window.history.state,
      "",
      "/detection/events/12345?aimerForce=1",
    );
    const fetchSpy = stubAnalyzeEnvelopeFetch();
    vi.stubGlobal("fetch", fetchSpy);

    // First mount: arm without consuming. Simulate refresh by
    // unmounting and rendering again — the URL still carries the
    // param, so the next mount re-arms force=true.
    const { unmount } = renderBanner({
      candidates: [{ id: 7, name: "Acme" }],
      customerBridgeEligible: { 7: true },
    });
    expect(window.location.search).toContain("aimerForce=1");
    unmount();

    renderBanner({
      candidates: [{ id: 7, name: "Acme" }],
      customerBridgeEligible: { 7: true },
    });
    fireEvent.click(screen.getByTestId("aimer-send-button"));
    fireEvent.click(screen.getByTestId("aimer-modal-send"));
    await waitFor(() => expect(submitSpy).toHaveBeenCalledTimes(1));

    const body = lastMintCallBody(fetchSpy);
    expect(body?.force).toBe(true);
    expect(window.location.search).not.toContain("aimerForce=1");
  });

  it("defaults force=false when the URL does NOT carry ?aimerForce=1", async () => {
    window.history.replaceState(
      window.history.state,
      "",
      "/detection/events/12345",
    );
    const fetchSpy = stubAnalyzeEnvelopeFetch();
    vi.stubGlobal("fetch", fetchSpy);

    renderBanner({
      candidates: [{ id: 7, name: "Acme" }],
      customerBridgeEligible: { 7: true },
    });
    fireEvent.click(screen.getByTestId("aimer-send-button"));
    fireEvent.click(screen.getByTestId("aimer-modal-send"));
    await waitFor(() => expect(submitSpy).toHaveBeenCalledTimes(1));

    const body = lastMintCallBody(fetchSpy);
    expect(body?.force).toBe(false);
  });

  it("force-arm is one-shot: a second click after consumption sends force=false", async () => {
    window.history.replaceState(
      window.history.state,
      "",
      "/detection/events/12345?aimerForce=1",
    );
    const fetchSpy = stubAnalyzeEnvelopeFetch();
    vi.stubGlobal("fetch", fetchSpy);

    renderBanner({
      candidates: [{ id: 7, name: "Acme" }],
      customerBridgeEligible: { 7: true },
    });
    // First click consumes the force arm.
    fireEvent.click(screen.getByTestId("aimer-send-button"));
    fireEvent.click(screen.getByTestId("aimer-modal-send"));
    await waitFor(() => expect(submitSpy).toHaveBeenCalledTimes(1));
    const firstBody = lastMintCallBody(fetchSpy);
    expect(firstBody?.force).toBe(true);

    // Second click should NOT re-force, since the URL was already stripped
    // and the ref was cleared on submit.
    fireEvent.click(screen.getByTestId("aimer-send-button"));
    fireEvent.click(screen.getByTestId("aimer-modal-send"));
    await waitFor(() => expect(submitSpy).toHaveBeenCalledTimes(2));
    const secondCall = fetchSpy.mock.calls
      .filter(([url]) => {
        const u = typeof url === "string" ? url : (url as URL).toString();
        return u.includes("/api/aimer/analyze-envelope");
      })
      .at(-1);
    const secondBody = JSON.parse(
      String((secondCall?.[1] as RequestInit).body),
    ) as Record<string, unknown>;
    expect(secondBody.force).toBe(false);
  });
});

describe("buildAnalyzeBridgeForm", () => {
  it("creates a multipart POST form with the four named text parts and target=_blank", () => {
    const form = buildAnalyzeBridgeForm(
      {
        contextToken: "ctx",
        eventsEnvelope: "env",
        eventsData: "{}",
        analyzeParamsToken: "params",
        targetUrl: "https://aimer.example.com/api/analysis/analyze-bridge",
      },
      document,
    );
    expect(form.action).toBe(
      "https://aimer.example.com/api/analysis/analyze-bridge",
    );
    expect(form.method).toBe("post");
    expect(form.enctype).toBe("multipart/form-data");
    expect(form.target).toBe("_blank");
    expect(form.hidden).toBe(true);
    const inputs = Array.from(form.querySelectorAll<HTMLInputElement>("input"));
    expect(inputs.map((i) => [i.name, i.type, i.value])).toEqual([
      ["context_token", "hidden", "ctx"],
      ["events_envelope", "hidden", "env"],
      ["events_data", "hidden", "{}"],
      ["analyze_params_token", "hidden", "params"],
    ]);
  });
});
