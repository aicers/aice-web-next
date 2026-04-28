import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { act, useState } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  type ApplyPreviewActions,
  ApplyPreviewModal,
} from "@/components/node/apply-preview-modal";
import enMessages from "@/i18n/messages/en.json";
import type {
  ApplyAttemptRow,
  CreateApplyAttemptResult,
  PlannedDispatch,
} from "@/lib/node/apply-attempt-types";

function makeAttemptId(suffix = "1"): string {
  return `00000000-0000-0000-0000-00000000000${suffix.slice(-1)}`;
}

function makeDispatches(): PlannedDispatch[] {
  return [
    {
      dispatchId: "d-manager",
      kind: "MANAGER",
      state: "queued",
      attemptCount: 0,
      lastError: null,
    },
    {
      dispatchId: "d-data-store",
      kind: "DATA_STORE",
      state: "queued",
      attemptCount: 0,
      lastError: null,
      new: 'ingest_srv_addr = "10.0.0.1:38370"\n',
    },
    {
      dispatchId: "d-tivan",
      kind: "TI_CONTAINER",
      state: "queued",
      attemptCount: 0,
      lastError: null,
      new: 'graphql_srv_addr = "10.0.0.1:8444"\n',
    },
  ];
}

function makePlanResult(attemptId: string): CreateApplyAttemptResult {
  return {
    attemptId,
    plannedDispatches: makeDispatches(),
    draftFingerprint: "deadbeef",
    expiresAt: "2099-12-31T23:59:59.999Z",
  };
}

function makeRow(
  attemptId: string,
  dispatches: PlannedDispatch[],
  status: ApplyAttemptRow["status"],
): ApplyAttemptRow {
  return {
    attemptId,
    nodeId: "node-1",
    draftFingerprint: Buffer.from("deadbeef", "hex"),
    plannedDispatches: dispatches,
    createdBy: "user",
    createdAt: new Date(),
    expiresAt: new Date("2099-12-31T23:59:59.999Z"),
    executingLock: null,
    claimStartedAt: null,
    status,
  };
}

function Harness({ actions }: { actions: ApplyPreviewActions }) {
  const [open, setOpen] = useState(true);
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ApplyPreviewModal
        open={open}
        onOpenChange={setOpen}
        nodeId="node-1"
        actions={actions}
      />
    </NextIntlClientProvider>
  );
}

function renderModal(actions: ApplyPreviewActions) {
  return render(<Harness actions={actions} />);
}

describe("ApplyPreviewModal", () => {
  it("calls createApplyAttempt on open and lists planned dispatches", async () => {
    const attemptId = makeAttemptId("1");
    const create = vi.fn().mockResolvedValue(makePlanResult(attemptId));
    const actions: ApplyPreviewActions = {
      createApplyAttempt: create,
      confirmApplyAttempt: vi.fn(),
      retryDispatch: vi.fn(),
    };
    renderModal(actions);
    await waitFor(() => {
      expect(create).toHaveBeenCalledWith({ nodeId: "node-1" });
    });
    expect(create).toHaveBeenCalledTimes(1);
    await screen.findByText("Manager (applyNode)");
    expect(screen.getByText("Data Store (updateConfig)")).toBeTruthy();
    expect(screen.getByText("TI Container (updateConfig)")).toBeTruthy();
    // Plan view: no per-row state badges yet, no Retry buttons.
    expect(
      screen.queryByTestId("apply-preview-dispatch-state-d-manager"),
    ).toBeNull();
    expect(screen.queryByTestId("apply-preview-retry-d-manager")).toBeNull();
  });

  it("clicking Apply confirms and surfaces all-succeeded status", async () => {
    const attemptId = makeAttemptId("1");
    const create = vi.fn().mockResolvedValue(makePlanResult(attemptId));
    const succeededDispatches = makeDispatches().map((d) => ({
      ...d,
      state: "succeeded" as const,
    }));
    const confirm = vi
      .fn()
      .mockResolvedValue(makeRow(attemptId, succeededDispatches, "succeeded"));
    renderModal({
      createApplyAttempt: create,
      confirmApplyAttempt: confirm,
      retryDispatch: vi.fn(),
    });
    const applyButton = await screen.findByTestId("apply-preview-apply");
    await act(async () => {
      fireEvent.click(applyButton);
    });
    expect(confirm).toHaveBeenCalledWith({ attemptId });
    await screen.findByText(/All dispatches succeeded/);
    expect(screen.queryByTestId("apply-preview-retry-d-data-store")).toBeNull();
  });

  it("shows exactly one Retry button on a failed_retryable dispatch", async () => {
    const attemptId = makeAttemptId("2");
    const create = vi.fn().mockResolvedValue(makePlanResult(attemptId));
    const dispatches = makeDispatches();
    dispatches[0] = { ...dispatches[0], state: "succeeded" };
    dispatches[1] = {
      ...dispatches[1],
      state: "failed_retryable",
      lastError: "boom",
    };
    // dispatches[2] stays queued — sequential-advance invariant.
    const confirm = vi
      .fn()
      .mockResolvedValue(makeRow(attemptId, dispatches, "failed_retryable"));
    renderModal({
      createApplyAttempt: create,
      confirmApplyAttempt: confirm,
      retryDispatch: vi.fn(),
    });
    const applyButton = await screen.findByTestId("apply-preview-apply");
    await act(async () => {
      fireEvent.click(applyButton);
    });
    await screen.findByTestId("apply-preview-retry-d-data-store");
    // Manager (succeeded) and Tivan (queued) must NOT show retry.
    expect(screen.queryByTestId("apply-preview-retry-d-manager")).toBeNull();
    expect(screen.queryByTestId("apply-preview-retry-d-tivan")).toBeNull();
    // Per-row error visible.
    expect(
      screen.getByTestId("apply-preview-dispatch-error-d-data-store")
        .textContent,
    ).toMatch(/boom/);
  });

  it("retry calls retryDispatch with attemptId + dispatchId and advances on success", async () => {
    const attemptId = makeAttemptId("3");
    const create = vi.fn().mockResolvedValue(makePlanResult(attemptId));
    const failedDispatches = makeDispatches();
    failedDispatches[0] = { ...failedDispatches[0], state: "succeeded" };
    failedDispatches[1] = {
      ...failedDispatches[1],
      state: "failed_retryable",
      lastError: "transient",
    };
    const succeededDispatches = makeDispatches().map((d) => ({
      ...d,
      state: "succeeded" as const,
    }));
    const confirm = vi
      .fn()
      .mockResolvedValue(
        makeRow(attemptId, failedDispatches, "failed_retryable"),
      );
    const retry = vi
      .fn()
      .mockResolvedValue(makeRow(attemptId, succeededDispatches, "succeeded"));
    renderModal({
      createApplyAttempt: create,
      confirmApplyAttempt: confirm,
      retryDispatch: retry,
    });
    const applyButton = await screen.findByTestId("apply-preview-apply");
    await act(async () => {
      fireEvent.click(applyButton);
    });
    const retryButton = await screen.findByTestId(
      "apply-preview-retry-d-data-store",
    );
    await act(async () => {
      fireEvent.click(retryButton);
    });
    expect(retry).toHaveBeenCalledWith({
      attemptId,
      dispatchId: "d-data-store",
    });
    await screen.findByText(/All dispatches succeeded/);
  });

  it("failed_terminal hides Retry on every row and renders Rebuild guidance", async () => {
    const attemptId = makeAttemptId("4");
    const create = vi.fn().mockResolvedValue(makePlanResult(attemptId));
    const dispatches = makeDispatches();
    dispatches[0] = { ...dispatches[0], state: "succeeded" };
    dispatches[1] = {
      ...dispatches[1],
      state: "failed_terminal",
      lastError: "cap reached",
    };
    dispatches[2] = {
      ...dispatches[2],
      state: "failed_terminal",
      lastError: "cap reached",
    };
    const confirm = vi
      .fn()
      .mockResolvedValue(makeRow(attemptId, dispatches, "failed_terminal"));
    renderModal({
      createApplyAttempt: create,
      confirmApplyAttempt: confirm,
      retryDispatch: vi.fn(),
    });
    const applyButton = await screen.findByTestId("apply-preview-apply");
    await act(async () => {
      fireEvent.click(applyButton);
    });
    await screen.findByTestId("apply-preview-terminal-guidance");
    expect(screen.queryByTestId("apply-preview-retry-d-data-store")).toBeNull();
    expect(screen.queryByTestId("apply-preview-retry-d-tivan")).toBeNull();
    // Rebuild action is offered.
    expect(screen.getByTestId("apply-preview-terminal-rebuild")).toBeTruthy();
  });

  it("Rebuild discards the attemptId and re-runs createApplyAttempt", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(makePlanResult(makeAttemptId("1")))
      .mockResolvedValueOnce(makePlanResult(makeAttemptId("2")));
    const dispatches = makeDispatches();
    dispatches[0] = { ...dispatches[0], state: "succeeded" };
    dispatches[1] = {
      ...dispatches[1],
      state: "failed_terminal",
      lastError: "stale",
    };
    dispatches[2] = {
      ...dispatches[2],
      state: "failed_terminal",
      lastError: "stale",
    };
    const confirm = vi
      .fn()
      .mockResolvedValue(
        makeRow(makeAttemptId("1"), dispatches, "failed_terminal"),
      );
    renderModal({
      createApplyAttempt: create,
      confirmApplyAttempt: confirm,
      retryDispatch: vi.fn(),
    });
    const applyButton = await screen.findByTestId("apply-preview-apply");
    await act(async () => {
      fireEvent.click(applyButton);
    });
    const rebuild = await screen.findByTestId("apply-preview-terminal-rebuild");
    await act(async () => {
      fireEvent.click(rebuild);
    });
    await waitFor(() => {
      expect(create).toHaveBeenCalledTimes(2);
    });
    // Second call also uses { nodeId } only — never carries the
    // frozen `new` from the first attempt.
    expect(create.mock.calls[1][0]).toEqual({ nodeId: "node-1" });
  });

  it("renders an alert when createApplyAttempt rejects (StalePlanError-like)", async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(new Error("stale plan"))
      .mockResolvedValueOnce(makePlanResult(makeAttemptId("9")));
    renderModal({
      createApplyAttempt: create,
      confirmApplyAttempt: vi.fn(),
      retryDispatch: vi.fn(),
    });
    await screen.findByTestId("apply-preview-plan-error");
    // Error path offers a Rebuild button.
    const rebuild = screen.getAllByRole("button", { name: /Rebuild/ })[0];
    await act(async () => {
      fireEvent.click(rebuild);
    });
    await waitFor(() => {
      expect(create).toHaveBeenCalledTimes(2);
    });
  });

  it("does not carry frozen 'new' payloads in the rendered DOM", async () => {
    const create = vi
      .fn()
      .mockResolvedValue(makePlanResult(makeAttemptId("1")));
    const { container } = renderModal({
      createApplyAttempt: create,
      confirmApplyAttempt: vi.fn(),
      retryDispatch: vi.fn(),
    });
    await screen.findByText("Manager (applyNode)");
    expect(container.textContent).not.toContain("ingest_srv_addr");
    expect(container.textContent).not.toContain("graphql_srv_addr");
  });

  // The frozen `new` / `old` payloads must not enter React state at
  // all — not just be hidden from the DOM. We use unique sentinel
  // strings on the wire payload and assert that they never appear
  // anywhere in the rendered subtree (DOM text, attributes, hidden
  // inputs, data-*) across the full Apply → Retry interaction. The
  // strict view-model boundary in `toDispatchView` is what makes this
  // hold; widening the view model to include `new` / `old` would
  // surface the sentinel via data-* attributes the assertion below
  // sweeps.
  it("strips frozen 'new' / 'old' payloads at the state boundary", async () => {
    const attemptId = makeAttemptId("1");
    const sentinelNew = "__SENTINEL_NEW_PAYLOAD__bfca9e";
    const sentinelOld = "__SENTINEL_OLD_PAYLOAD__bfca9e";
    const planned: PlannedDispatch[] = [
      {
        dispatchId: "d-manager",
        kind: "MANAGER",
        state: "queued",
        attemptCount: 0,
        lastError: null,
      },
      {
        dispatchId: "d-data-store",
        kind: "DATA_STORE",
        state: "queued",
        attemptCount: 0,
        lastError: null,
        new: sentinelNew,
        old: sentinelOld,
      },
    ];
    const create = vi.fn().mockResolvedValue({
      attemptId,
      plannedDispatches: planned,
      draftFingerprint: "deadbeef",
      expiresAt: "2099-12-31T23:59:59.999Z",
    });
    const failedExternal = planned.map((d, i) =>
      i === 1
        ? { ...d, state: "failed_retryable" as const, lastError: "boom" }
        : { ...d, state: "succeeded" as const },
    );
    const confirm = vi
      .fn()
      .mockResolvedValue(
        makeRow(attemptId, failedExternal, "failed_retryable"),
      );
    const { container } = renderModal({
      createApplyAttempt: create,
      confirmApplyAttempt: confirm,
      retryDispatch: vi.fn(),
    });
    const applyButton = await screen.findByTestId("apply-preview-apply");
    expect(container.outerHTML).not.toContain(sentinelNew);
    expect(container.outerHTML).not.toContain(sentinelOld);
    await act(async () => {
      fireEvent.click(applyButton);
    });
    await screen.findByTestId("apply-preview-retry-d-data-store");
    // After Apply settles to failed_retryable the dispatch row, the
    // state-bearing parent, the executing-phase scratch state, and any
    // captured props are all in scope. None may surface the sentinel.
    expect(container.outerHTML).not.toContain(sentinelNew);
    expect(container.outerHTML).not.toContain(sentinelOld);
  });

  // A common parent will pass `actions={{ create..., confirm..., retry... }}`
  // inline, allocating a fresh object every render. That must not
  // retrigger the open-time `createApplyAttempt` — doing so would
  // discard the live attemptId and create a duplicate plan on the
  // BFF on every parent re-render.
  it("does not re-create the attempt when the parent re-renders with a new actions object", async () => {
    const attemptId = makeAttemptId("1");
    const create = vi.fn().mockResolvedValue(makePlanResult(attemptId));
    function ReRenderingHarness() {
      const [tick, setTick] = useState(0);
      // Build a fresh `actions` object on every render, mirroring the
      // common inline-prop pattern in real call sites.
      const actions: ApplyPreviewActions = {
        createApplyAttempt: create,
        confirmApplyAttempt: vi.fn(),
        retryDispatch: vi.fn(),
      };
      return (
        <NextIntlClientProvider locale="en" messages={enMessages}>
          <button
            type="button"
            data-testid="parent-rerender"
            onClick={() => setTick((value) => value + 1)}
          >
            tick {tick}
          </button>
          <ApplyPreviewModal
            open={true}
            onOpenChange={() => {}}
            nodeId="node-1"
            actions={actions}
          />
        </NextIntlClientProvider>
      );
    }
    render(<ReRenderingHarness />);
    await waitFor(() => {
      expect(create).toHaveBeenCalledTimes(1);
    });
    // Force several parent re-renders. A naive effect keyed on
    // `actions` would call create again on every tick.
    for (let i = 0; i < 3; i += 1) {
      const button = screen.getByTestId("parent-rerender");
      await act(async () => {
        fireEvent.click(button);
      });
    }
    // No additional create calls.
    expect(create).toHaveBeenCalledTimes(1);
  });

  // Accessibility checks — equivalent to axe-core's role / aria-modal /
  // labelled-by rules plus the Escape-during-executing assertion the
  // issue calls out. The modal wraps Radix Dialog, which provides a
  // focus trap via FocusScope; we assert the externally-observable
  // contract (role + aria + Escape suppression) here.
  describe("accessibility", () => {
    it("renders role='dialog' with a labelled title and description", async () => {
      const create = vi
        .fn()
        .mockResolvedValue(makePlanResult(makeAttemptId("1")));
      renderModal({
        createApplyAttempt: create,
        confirmApplyAttempt: vi.fn(),
        retryDispatch: vi.fn(),
      });
      const dialog = await screen.findByRole("dialog");
      const labelledBy = dialog.getAttribute("aria-labelledby") ?? "";
      const describedBy = dialog.getAttribute("aria-describedby") ?? "";
      expect(labelledBy).not.toBe("");
      expect(describedBy).not.toBe("");
      expect(document.getElementById(labelledBy)?.textContent).toBeTruthy();
      expect(document.getElementById(describedBy)?.textContent).toBeTruthy();
    });

    it("retry buttons carry an accessible name naming the dispatch kind", async () => {
      const attemptId = makeAttemptId("a");
      const create = vi.fn().mockResolvedValue(makePlanResult(attemptId));
      const dispatches = makeDispatches();
      dispatches[0] = { ...dispatches[0], state: "succeeded" };
      dispatches[1] = {
        ...dispatches[1],
        state: "failed_retryable",
        lastError: "boom",
      };
      const confirm = vi
        .fn()
        .mockResolvedValue(makeRow(attemptId, dispatches, "failed_retryable"));
      renderModal({
        createApplyAttempt: create,
        confirmApplyAttempt: confirm,
        retryDispatch: vi.fn(),
      });
      const applyButton = await screen.findByTestId("apply-preview-apply");
      await act(async () => {
        fireEvent.click(applyButton);
      });
      const retryButton = await screen.findByRole("button", {
        name: /Retry – Data Store \(updateConfig\)/,
      });
      expect(retryButton).toBeTruthy();
    });

    it("Escape during execution does not close the modal; Escape after settling does", async () => {
      const attemptId = makeAttemptId("b");
      const create = vi.fn().mockResolvedValue(makePlanResult(attemptId));
      let resolveConfirm: ((row: ApplyAttemptRow) => void) | undefined;
      const succeededDispatches = makeDispatches().map((d) => ({
        ...d,
        state: "succeeded" as const,
      }));
      const confirm = vi.fn().mockImplementation(
        () =>
          new Promise<ApplyAttemptRow>((resolve) => {
            resolveConfirm = resolve;
          }),
      );
      renderModal({
        createApplyAttempt: create,
        confirmApplyAttempt: confirm,
        retryDispatch: vi.fn(),
      });
      const applyButton = await screen.findByTestId("apply-preview-apply");
      await act(async () => {
        fireEvent.click(applyButton);
      });
      // Mid-flight: dialog must stay open on Escape.
      await screen.findByTestId("apply-preview-applying");
      const dialog = screen.getByRole("dialog");
      fireEvent.keyDown(dialog, { key: "Escape" });
      expect(screen.queryByRole("dialog")).toBeTruthy();
      // Settle the call; Escape now closes.
      await act(async () => {
        resolveConfirm?.(makeRow(attemptId, succeededDispatches, "succeeded"));
      });
      await screen.findByTestId("apply-preview-done");
      fireEvent.keyDown(document.body, { key: "Escape" });
      await waitFor(() => {
        expect(screen.queryByRole("dialog")).toBeNull();
      });
    });
  });
});
