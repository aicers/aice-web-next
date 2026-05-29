/**
 * Coverage for the app-shell Phase 2 cadence manager (#651). This is the
 * piece that replaced the per-Triage-screen mounts, so its reconcile
 * logic is the central behavior of the issue and is invisible from the
 * route/coordinator tests:
 *
 *   - on mount it fetches `cadence-config` and starts one
 *     {@link createPeriodicDrain} per `(in-scope ∩ enabled customer) ×
 *     ['baseline_event','story']` — never `policy_event`, never an
 *     out-of-scope or opted-out customer;
 *   - flipping the Settings toggle (CADENCE_CHANGED_EVENT) re-reads the
 *     config and starts/stops controllers without a reload;
 *   - unmount stops every controller; and
 *   - the injected per-tick drain routes through the in-tab coordinator
 *     and records the `cadence_drain` audit only on a state-changing
 *     tick (`delivered + noOp > 0`).
 */

import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  DrainOptions,
  DrainResult,
  Phase2DrainKind,
} from "@/lib/aimer/phase2/transport.client";

interface MockController {
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  isRunning: ReturnType<typeof vi.fn>;
  forceNow: ReturnType<typeof vi.fn>;
}

interface CreatedController {
  kind: Phase2DrainKind;
  customerId: number;
  drain: (
    kind: Phase2DrainKind,
    customerId: number,
    options: DrainOptions,
  ) => Promise<DrainResult>;
  controller: MockController;
}

const created = vi.hoisted(() => [] as CreatedController[]);
const mockCreatePeriodicDrain = vi.hoisted(() => vi.fn());
const mockCoordinatedDrain = vi.hoisted(() => vi.fn());
const mockMutatingFetch = vi.hoisted(() => vi.fn());

vi.mock("@/lib/aimer/phase2/transport.client", () => ({
  createPeriodicDrain: mockCreatePeriodicDrain,
}));
vi.mock("@/lib/aimer/phase2/drain-coordinator.client", () => ({
  coordinatedDrain: mockCoordinatedDrain,
}));
vi.mock("@/lib/csrf-client", () => ({ mutatingFetch: mockMutatingFetch }));

import {
  AimerPhase2CadenceManager,
  CADENCE_CHANGED_EVENT,
} from "@/components/layout/aimer-phase2-cadence-manager";

function drainResult(delivered: number, noOp: number): DrainResult {
  return {
    totalDelivered: delivered,
    totalNoOp: noOp,
    batches: 1,
    stoppedReason: "exhausted",
  } as unknown as DrainResult;
}

/** Resolve the next `cadence-config` fetch with this enabled-customer set. */
function stubConfig(...customerIds: number[]): void {
  (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
    new Response(
      JSON.stringify({
        customers: customerIds.map((id) => ({
          customer_id: id,
          cadence_enabled: true,
        })),
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
}

function controllersFor(customerId: number): CreatedController[] {
  return created.filter((c) => c.customerId === customerId);
}

describe("AimerPhase2CadenceManager (#651)", () => {
  beforeEach(() => {
    created.length = 0;
    mockCreatePeriodicDrain
      .mockReset()
      .mockImplementation(
        (
          kind: Phase2DrainKind,
          customerId: number,
          options: { drain: CreatedController["drain"] },
        ) => {
          const controller: MockController = {
            start: vi.fn(),
            stop: vi.fn(),
            isRunning: vi.fn(() => false),
            forceNow: vi.fn(),
          };
          created.push({ kind, customerId, drain: options.drain, controller });
          return controller;
        },
      );
    mockCoordinatedDrain.mockReset().mockResolvedValue(drainResult(0, 0));
    mockMutatingFetch.mockReset().mockResolvedValue(
      new Response(null, {
        status: 204,
      }),
    );
    vi.stubGlobal("fetch", vi.fn());
    stubConfig();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("starts baseline_event + story (never policy_event) for an enabled in-scope customer", async () => {
    stubConfig(42);
    render(<AimerPhase2CadenceManager customerIds={[42]} />);

    await waitFor(() => expect(created.length).toBe(2));
    const kinds = controllersFor(42)
      .map((c) => c.kind)
      .sort();
    expect(kinds).toEqual(["baseline_event", "story"]);
    expect(created.every((c) => c.kind !== "policy_event")).toBe(true);
    for (const c of created)
      expect(c.controller.start).toHaveBeenCalledTimes(1);
  });

  it("does not start a controller for an enabled customer that is out of scope", async () => {
    // Config lists 99 as enabled, but only 42 is in the dashboard scope.
    stubConfig(42, 99);
    render(<AimerPhase2CadenceManager customerIds={[42]} />);

    await waitFor(() => expect(controllersFor(42).length).toBe(2));
    expect(controllersFor(99).length).toBe(0);
  });

  it("starts nothing when no in-scope customer has consented", async () => {
    stubConfig(); // empty enabled set
    render(<AimerPhase2CadenceManager customerIds={[42]} />);

    // Let the fetch settle, then assert no controllers were created.
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    await Promise.resolve();
    expect(created.length).toBe(0);
  });

  it("reconciles on CADENCE_CHANGED_EVENT: stops controllers when a customer opts out", async () => {
    stubConfig(42);
    render(<AimerPhase2CadenceManager customerIds={[42]} />);
    await waitFor(() => expect(controllersFor(42).length).toBe(2));
    const before = controllersFor(42);

    // Operator flips the toggle off → next config has no enabled customers.
    stubConfig();
    window.dispatchEvent(new Event(CADENCE_CHANGED_EVENT));

    await waitFor(() =>
      expect(
        before.every((c) => c.controller.stop.mock.calls.length === 1),
      ).toBe(true),
    );
  });

  it("opt-out fails closed: stops the customer's controllers even when the config refetch fails", async () => {
    stubConfig(42);
    render(<AimerPhase2CadenceManager customerIds={[42]} />);
    await waitFor(() => expect(controllersFor(42).length).toBe(2));
    const before = controllersFor(42);

    // The toggle persisted enabled=false, but the manager's config refetch
    // fails. The fail-closed event detail must still stop the controllers.
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("network down"),
    );
    window.dispatchEvent(
      new CustomEvent(CADENCE_CHANGED_EVENT, {
        detail: { customerId: 42, enabled: false },
      }),
    );

    await waitFor(() =>
      expect(
        before.every((c) => c.controller.stop.mock.calls.length === 1),
      ).toBe(true),
    );
  });

  it("reconciles on CADENCE_CHANGED_EVENT: starts a controller when a customer opts in", async () => {
    stubConfig(); // initially nobody enabled
    render(<AimerPhase2CadenceManager customerIds={[7]} />);
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1));
    expect(created.length).toBe(0);

    stubConfig(7);
    window.dispatchEvent(new Event(CADENCE_CHANGED_EVENT));

    await waitFor(() => expect(controllersFor(7).length).toBe(2));
    for (const c of controllersFor(7)) {
      expect(c.controller.start).toHaveBeenCalledTimes(1);
    }
  });

  it("stops every controller on unmount", async () => {
    stubConfig(42);
    const { unmount } = render(
      <AimerPhase2CadenceManager customerIds={[42]} />,
    );
    await waitFor(() => expect(controllersFor(42).length).toBe(2));
    const controllers = controllersFor(42);

    unmount();

    for (const c of controllers) {
      expect(c.controller.stop).toHaveBeenCalledTimes(1);
    }
  });

  describe("injected per-tick drain", () => {
    it("records the cadence_drain audit on a state-changing tick", async () => {
      stubConfig(42);
      render(<AimerPhase2CadenceManager customerIds={[42]} />);
      await waitFor(() => expect(controllersFor(42).length).toBe(2));

      const { kind, drain } = controllersFor(42)[0];
      mockCoordinatedDrain.mockResolvedValueOnce(drainResult(3, 0));
      const result = await drain(kind, 42, {});

      expect(mockCoordinatedDrain).toHaveBeenCalledWith(kind, 42, {});
      expect(result.totalDelivered).toBe(3);
      await waitFor(() =>
        expect(mockMutatingFetch).toHaveBeenCalledWith(
          "/api/aimer/phase2/cadence-drain",
          expect.objectContaining({ method: "POST" }),
        ),
      );
      const body = JSON.parse(
        mockMutatingFetch.mock.calls[0][1].body as string,
      );
      expect(body).toMatchObject({
        customer_id: 42,
        kind,
        delivered: 3,
        no_op: 0,
      });
    });

    it("records the audit for a successful no-op ack (delivered=0, noOp>0)", async () => {
      stubConfig(42);
      render(<AimerPhase2CadenceManager customerIds={[42]} />);
      await waitFor(() => expect(controllersFor(42).length).toBe(2));

      const { kind, drain } = controllersFor(42)[0];
      mockCoordinatedDrain.mockResolvedValueOnce(drainResult(0, 2));
      await drain(kind, 42, {});

      await waitFor(() => expect(mockMutatingFetch).toHaveBeenCalledTimes(1));
    });

    it("does NOT record the audit on a bare no-op tick (delivered=0, noOp=0)", async () => {
      stubConfig(42);
      render(<AimerPhase2CadenceManager customerIds={[42]} />);
      await waitFor(() => expect(controllersFor(42).length).toBe(2));

      const { kind, drain } = controllersFor(42)[0];
      mockCoordinatedDrain.mockResolvedValueOnce(drainResult(0, 0));
      await drain(kind, 42, {});

      // Give the best-effort audit POST a chance to fire, then assert silence.
      await Promise.resolve();
      expect(mockMutatingFetch).not.toHaveBeenCalled();
    });
  });
});
