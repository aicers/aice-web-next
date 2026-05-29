/**
 * Component coverage for the per-customer cadence consent toggle added
 * to {@link AimerPhase2Block} (#651). The route- and coordinator-level
 * logic is covered elsewhere; this guards the UI wiring that is easy to
 * regress and invisible from those tests:
 *
 *   - the toggle reflects the customer's `cadence_enabled` flag from the
 *     status DTO, and
 *   - flipping it POSTs to `/api/aimer/phase2/cadence-toggle` AND
 *     dispatches `CADENCE_CHANGED_EVENT` so the app-shell manager
 *     reconciles in the same tab without a reload.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockMutatingFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/csrf-client", () => ({ mutatingFetch: mockMutatingFetch }));

// The toggle path never drains; stub the coordinator so the module's
// transport import does not need a real fetch transport in jsdom.
vi.mock("@/lib/aimer/phase2/drain-coordinator.client", () => ({
  coordinatedDrain: vi.fn(),
}));

import { CADENCE_CHANGED_EVENT } from "@/components/layout/aimer-phase2-cadence-manager";
import { AimerPhase2Block } from "@/components/settings/aimer-phase2-block";
import enMessages from "@/i18n/messages/en.json";

function statusDto(cadenceEnabled: boolean) {
  const track = (kind: string) => ({
    kind,
    bucket: "synced" as const,
    approximate_count: null,
    cursor_lag_seconds: null,
    last_synced_at: null,
    last_error: null,
    pending_notice_count: 0,
    pending_oldest_enqueued_at: null,
    pending_breakdown: { withdraw: 0, refresh: 0, backfill: 0 },
    opportunistic_enabled: true,
    paused_at: null,
    paused_by: null,
    cadence_enabled: cadenceEnabled,
  });
  return {
    customer_id: 42,
    streaming: [track("baseline_event"), track("story")],
    policy_run: {
      kind: "policy_run",
      last_sent_run_id: null,
      last_sent_at: null,
      last_sent_by: null,
      total_runs_sent: 0,
    },
    policy_event: {
      kind: "policy_event",
      pending_notice_count: 0,
      pending_oldest_enqueued_at: null,
      last_error: null,
    },
  };
}

function renderBlock() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <AimerPhase2Block customers={[{ id: 42, name: "Acme" }]} />
    </NextIntlClientProvider>,
  );
}

describe("AimerPhase2Block — cadence toggle (#651)", () => {
  beforeEach(() => {
    mockMutatingFetch.mockReset().mockResolvedValue(
      new Response(null, {
        status: 204,
      }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(statusDto(false)), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reflects cadence_enabled=false as an off switch", async () => {
    renderBlock();
    const toggle = await screen.findByTestId("aimer-phase2-cadence-toggle");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });

  it("reflects cadence_enabled=true as an on switch", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify(statusDto(true)), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    renderBlock();
    const toggle = await screen.findByTestId("aimer-phase2-cadence-toggle");
    await waitFor(() =>
      expect(toggle.getAttribute("aria-checked")).toBe("true"),
    );
  });

  it("POSTs the toggle and dispatches CADENCE_CHANGED_EVENT on flip", async () => {
    const onChanged = vi.fn();
    window.addEventListener(CADENCE_CHANGED_EVENT, onChanged);
    try {
      renderBlock();
      const toggle = await screen.findByTestId("aimer-phase2-cadence-toggle");
      fireEvent.click(toggle);

      await waitFor(() => {
        expect(mockMutatingFetch).toHaveBeenCalledWith(
          "/api/aimer/phase2/cadence-toggle",
          expect.objectContaining({
            method: "POST",
            body: JSON.stringify({ customer_id: 42, enabled: true }),
          }),
        );
      });
      await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
      // The event carries { customerId, enabled } so the app-shell manager
      // can honor an opt-out fail-closed even if its config refetch fails.
      const event = onChanged.mock.calls[0][0] as CustomEvent;
      expect(event.detail).toEqual({ customerId: 42, enabled: true });
    } finally {
      window.removeEventListener(CADENCE_CHANGED_EVENT, onChanged);
    }
  });
});
