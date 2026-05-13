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
  ApplyAttemptClientRow,
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
      kind: "MANAGER_DB",
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
  status: ApplyAttemptClientRow["status"],
): ApplyAttemptClientRow {
  return {
    attemptId,
    nodeId: "node-1",
    draftFingerprint: "deadbeef",
    plannedDispatches: dispatches,
    createdBy: "user",
    createdAt: new Date().toISOString(),
    expiresAt: "2099-12-31T23:59:59.999Z",
    executingLock: null,
    claimStartedAt: null,
    status,
    customerId: 5,
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
    await screen.findByText("Manager DB (applyNodeDraft)");
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
    await screen.findByText("Manager DB (applyNodeDraft)");
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
        kind: "MANAGER_DB",
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

  // A Rebuild click whose `createApplyAttempt` promise is still in
  // flight when the modal is closed (and then reopened) MUST NOT
  // overwrite the freshly-opened attempt when it eventually resolves.
  // The open-time effect and the buildPlan callback share a generation
  // counter so a stale resolution from a previous open cycle is dropped
  // instead of writing into the new cycle's state.
  it("a Rebuild from a previous open cycle does not overwrite a fresh attempt after close+reopen", async () => {
    const reopenedAttemptId = makeAttemptId("3");
    const reopenedResult = makePlanResult(reopenedAttemptId);
    const stalePlan = makePlanResult(makeAttemptId("9"));
    let resolveStaleRebuild:
      | ((value: CreateApplyAttemptResult) => void)
      | undefined;
    const create = vi
      .fn<(args: { nodeId: string }) => Promise<CreateApplyAttemptResult>>()
      .mockRejectedValueOnce(new Error("initial failure"))
      .mockImplementationOnce(
        () =>
          new Promise<CreateApplyAttemptResult>((resolve) => {
            resolveStaleRebuild = resolve;
          }),
      )
      .mockResolvedValueOnce(reopenedResult);
    const succeededDispatches = makeDispatches().map((d) => ({
      ...d,
      state: "succeeded" as const,
    }));
    const confirm = vi
      .fn()
      .mockResolvedValue(
        makeRow(reopenedAttemptId, succeededDispatches, "succeeded"),
      );
    function ReopenHarness() {
      const [open, setOpen] = useState(true);
      return (
        <NextIntlClientProvider locale="en" messages={enMessages}>
          <button
            type="button"
            data-testid="reopen"
            onClick={() => setOpen(true)}
          >
            reopen
          </button>
          <ApplyPreviewModal
            open={open}
            onOpenChange={setOpen}
            nodeId="node-1"
            actions={{
              createApplyAttempt: create,
              confirmApplyAttempt: confirm,
              retryDispatch: vi.fn(),
            }}
          />
        </NextIntlClientProvider>
      );
    }
    render(<ReopenHarness />);
    // (1) Initial open: hits the error path because the first create
    // call rejects. The error footer surfaces a Rebuild button.
    await screen.findByTestId("apply-preview-plan-error");
    const rebuildButton = screen.getAllByRole("button", { name: /Rebuild/ })[0];
    // (2) Click Rebuild: starts the second create call, which we hold
    // open by capturing its resolver above.
    await act(async () => {
      fireEvent.click(rebuildButton);
    });
    expect(create).toHaveBeenCalledTimes(2);
    // (3) While the Rebuild promise is still pending the modal is in
    // the loading phase; its footer renders a Cancel button. Clicking
    // it closes the modal — exactly the race the reviewer described.
    const cancelButton = await screen.findByRole("button", { name: /Cancel/ });
    await act(async () => {
      fireEvent.click(cancelButton);
    });
    // (4) Reopen the modal. The open-time effect fires the third
    // create call, which resolves immediately to `reopenedResult`.
    await act(async () => {
      fireEvent.click(screen.getByTestId("reopen"));
    });
    await screen.findByText("Manager DB (applyNodeDraft)");
    expect(create).toHaveBeenCalledTimes(3);
    // (5) Now resolve the stale Rebuild promise. If the generation
    // guard is missing, this would call `setPhase` with `stalePlan`
    // and overwrite the reopen's attempt. With the guard, it is
    // dropped.
    await act(async () => {
      resolveStaleRebuild?.(stalePlan);
    });
    // The reopen's plan must still be the active one. We prove the
    // active attemptId by clicking Apply and asserting confirm is
    // called with the reopen's attemptId, not the stale one.
    const applyButton = await screen.findByTestId("apply-preview-apply");
    await act(async () => {
      fireEvent.click(applyButton);
    });
    expect(confirm).toHaveBeenCalledWith({ attemptId: reopenedAttemptId });
    expect(confirm).not.toHaveBeenCalledWith({
      attemptId: makeAttemptId("9"),
    });
  });

  // A `confirmApplyAttempt` (or `retryDispatch`) call whose promise is
  // still in flight when the modal is force-closed by the parent — and
  // then reopened — MUST NOT overwrite the freshly-opened attempt when
  // it eventually resolves. The modal's own Escape/outside-click guard
  // suppresses dismiss attempts while executing, but a controlled
  // parent that sets `open={false}` directly bypasses that guard, so
  // the generation counter has to cover the confirm and retry paths
  // too — not just plan-building.
  it("a confirmApplyAttempt from a previous open cycle does not overwrite a fresh attempt after force-close + reopen", async () => {
    const initialAttemptId = makeAttemptId("1");
    const reopenedAttemptId = makeAttemptId("2");
    const create = vi
      .fn<(args: { nodeId: string }) => Promise<CreateApplyAttemptResult>>()
      .mockResolvedValueOnce(makePlanResult(initialAttemptId))
      .mockResolvedValueOnce(makePlanResult(reopenedAttemptId));
    let resolveStaleConfirm: ((row: ApplyAttemptClientRow) => void) | undefined;
    const staleSucceeded = makeDispatches().map((d) => ({
      ...d,
      state: "succeeded" as const,
    }));
    const confirm = vi
      .fn<(args: { attemptId: string }) => Promise<ApplyAttemptClientRow>>()
      .mockImplementationOnce(
        () =>
          new Promise<ApplyAttemptClientRow>((resolve) => {
            resolveStaleConfirm = resolve;
          }),
      )
      .mockResolvedValue(
        makeRow(reopenedAttemptId, staleSucceeded, "succeeded"),
      );
    function ForceCloseHarness() {
      const [open, setOpen] = useState(true);
      return (
        <NextIntlClientProvider locale="en" messages={enMessages}>
          <button
            type="button"
            data-testid="force-close"
            onClick={() => setOpen(false)}
          >
            close
          </button>
          <button
            type="button"
            data-testid="reopen"
            onClick={() => setOpen(true)}
          >
            reopen
          </button>
          <ApplyPreviewModal
            open={open}
            onOpenChange={setOpen}
            nodeId="node-1"
            actions={{
              createApplyAttempt: create,
              confirmApplyAttempt: confirm,
              retryDispatch: vi.fn(),
            }}
          />
        </NextIntlClientProvider>
      );
    }
    render(<ForceCloseHarness />);
    // (1) Initial open: plan loads with `initialAttemptId`.
    await screen.findByText("Manager DB (applyNodeDraft)");
    // (2) Click Apply: stale confirm is held by capturing its resolver.
    const applyButton = await screen.findByTestId("apply-preview-apply");
    await act(async () => {
      fireEvent.click(applyButton);
    });
    expect(confirm).toHaveBeenCalledWith({ attemptId: initialAttemptId });
    await screen.findByTestId("apply-preview-applying");
    // (3) Parent force-closes mid-flight (bypassing the modal's own
    // Escape guard, which the controlled `open` prop allows).
    await act(async () => {
      fireEvent.click(screen.getByTestId("force-close"));
    });
    // (4) Reopen — open-time effect runs and resolves to the new plan.
    await act(async () => {
      fireEvent.click(screen.getByTestId("reopen"));
    });
    await screen.findByText("Manager DB (applyNodeDraft)");
    expect(create).toHaveBeenCalledTimes(2);
    // (5) Resolve the stale confirm last. Without the generation guard
    // on the confirm path, this would call setPhase with the stale
    // executed state and replace the reopen's planned rows.
    await act(async () => {
      resolveStaleConfirm?.(
        makeRow(initialAttemptId, staleSucceeded, "succeeded"),
      );
    });
    // The reopen's planned phase must still be active. Apply is still
    // visible (executed phase would have surfaced the Done button), and
    // clicking it issues a confirm against the reopen's attemptId.
    const applyAgain = await screen.findByTestId("apply-preview-apply");
    await act(async () => {
      fireEvent.click(applyAgain);
    });
    expect(confirm).toHaveBeenLastCalledWith({
      attemptId: reopenedAttemptId,
    });
  });

  it("a retryDispatch from a previous open cycle does not overwrite a fresh attempt after force-close + reopen", async () => {
    const initialAttemptId = makeAttemptId("1");
    const reopenedAttemptId = makeAttemptId("2");
    const create = vi
      .fn<(args: { nodeId: string }) => Promise<CreateApplyAttemptResult>>()
      .mockResolvedValueOnce(makePlanResult(initialAttemptId))
      .mockResolvedValueOnce(makePlanResult(reopenedAttemptId));
    const failedDispatches = makeDispatches();
    failedDispatches[0] = { ...failedDispatches[0], state: "succeeded" };
    failedDispatches[1] = {
      ...failedDispatches[1],
      state: "failed_retryable",
      lastError: "transient",
    };
    const confirm = vi
      .fn()
      .mockResolvedValue(
        makeRow(initialAttemptId, failedDispatches, "failed_retryable"),
      );
    let resolveStaleRetry: ((row: ApplyAttemptClientRow) => void) | undefined;
    const staleSucceeded = makeDispatches().map((d) => ({
      ...d,
      state: "succeeded" as const,
    }));
    const retry = vi.fn().mockImplementation(
      () =>
        new Promise<ApplyAttemptClientRow>((resolve) => {
          resolveStaleRetry = resolve;
        }),
    );
    function ForceCloseHarness() {
      const [open, setOpen] = useState(true);
      return (
        <NextIntlClientProvider locale="en" messages={enMessages}>
          <button
            type="button"
            data-testid="force-close"
            onClick={() => setOpen(false)}
          >
            close
          </button>
          <button
            type="button"
            data-testid="reopen"
            onClick={() => setOpen(true)}
          >
            reopen
          </button>
          <ApplyPreviewModal
            open={open}
            onOpenChange={setOpen}
            nodeId="node-1"
            actions={{
              createApplyAttempt: create,
              confirmApplyAttempt: confirm,
              retryDispatch: retry,
            }}
          />
        </NextIntlClientProvider>
      );
    }
    render(<ForceCloseHarness />);
    // (1) Initial open + Apply settles to failed_retryable.
    const applyButton = await screen.findByTestId("apply-preview-apply");
    await act(async () => {
      fireEvent.click(applyButton);
    });
    const retryButton = await screen.findByTestId(
      "apply-preview-retry-d-data-store",
    );
    // (2) Click Retry: stale retry held by capturing its resolver.
    await act(async () => {
      fireEvent.click(retryButton);
    });
    await screen.findByTestId("apply-preview-applying");
    expect(retry).toHaveBeenCalledWith({
      attemptId: initialAttemptId,
      dispatchId: "d-data-store",
    });
    // (3) Force-close, then (4) reopen.
    await act(async () => {
      fireEvent.click(screen.getByTestId("force-close"));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("reopen"));
    });
    await screen.findByText("Manager DB (applyNodeDraft)");
    expect(create).toHaveBeenCalledTimes(2);
    // (5) Resolve the stale retry last — must be dropped.
    await act(async () => {
      resolveStaleRetry?.(
        makeRow(initialAttemptId, staleSucceeded, "succeeded"),
      );
    });
    // Reopen's planned phase still active: Apply is shown, and the
    // executed-phase "succeeded" header from the stale retry is not.
    expect(screen.queryByText(/All dispatches succeeded/)).toBeNull();
    const applyAgain = await screen.findByTestId("apply-preview-apply");
    await act(async () => {
      fireEvent.click(applyAgain);
    });
    expect(confirm).toHaveBeenLastCalledWith({
      attemptId: reopenedAttemptId,
    });
  });

  // On close, the modal must synchronously reset its phase to
  // `loading` so a subsequent reopen does not flash the previous
  // attempt's planned/executed rows before the new open-time effect
  // runs createApplyAttempt and replaces them.
  it("clears phase on close so reopen does not flash the previous attempt's rows", async () => {
    const create = vi
      .fn<(args: { nodeId: string }) => Promise<CreateApplyAttemptResult>>()
      .mockResolvedValueOnce(makePlanResult(makeAttemptId("1")));
    let resolveSecond: ((value: CreateApplyAttemptResult) => void) | undefined;
    create.mockImplementationOnce(
      () =>
        new Promise<CreateApplyAttemptResult>((resolve) => {
          resolveSecond = resolve;
        }),
    );
    function ReopenHarness() {
      const [open, setOpen] = useState(true);
      return (
        <NextIntlClientProvider locale="en" messages={enMessages}>
          <button
            type="button"
            data-testid="force-close"
            onClick={() => setOpen(false)}
          >
            close
          </button>
          <button
            type="button"
            data-testid="reopen"
            onClick={() => setOpen(true)}
          >
            reopen
          </button>
          <ApplyPreviewModal
            open={open}
            onOpenChange={setOpen}
            nodeId="node-1"
            actions={{
              createApplyAttempt: create,
              confirmApplyAttempt: vi.fn(),
              retryDispatch: vi.fn(),
            }}
          />
        </NextIntlClientProvider>
      );
    }
    render(<ReopenHarness />);
    await screen.findByText("Manager DB (applyNodeDraft)");
    await act(async () => {
      fireEvent.click(screen.getByTestId("force-close"));
    });
    // Reopen and hold the second create call open. The modal must be
    // in the loading phase — NOT briefly showing the previous plan.
    await act(async () => {
      fireEvent.click(screen.getByTestId("reopen"));
    });
    expect(screen.getByTestId("apply-preview-loading")).toBeTruthy();
    expect(screen.queryByText("Manager DB (applyNodeDraft)")).toBeNull();
    await act(async () => {
      resolveSecond?.(makePlanResult(makeAttemptId("2")));
    });
    await screen.findByText("Manager DB (applyNodeDraft)");
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

    it("promotes only the first queued dispatch to in_flight while confirmApplyAttempt is pending", async () => {
      const attemptId = makeAttemptId("c");
      const create = vi.fn().mockResolvedValue(makePlanResult(attemptId));
      let resolveConfirm: ((row: ApplyAttemptClientRow) => void) | undefined;
      const succeededDispatches = makeDispatches().map((d) => ({
        ...d,
        state: "succeeded" as const,
      }));
      const confirm = vi.fn().mockImplementation(
        () =>
          new Promise<ApplyAttemptClientRow>((resolve) => {
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
      // Mid-flight: only the first queued row promotes to `in_flight`,
      // mirroring the BFF's sequential-advance rule (`advanceForClaim`
      // in `apply-attempt-lifecycle.ts`). Marking every row in flight
      // would imply parallel execution the state machine does not
      // perform — and would mislead the user when an early failure
      // halts the sequence with later rows never started.
      await screen.findByTestId("apply-preview-applying");
      const managerRow = screen.getByTestId("apply-preview-dispatch-d-manager");
      const dataStoreRow = screen.getByTestId(
        "apply-preview-dispatch-d-data-store",
      );
      const tivanRow = screen.getByTestId("apply-preview-dispatch-d-tivan");
      expect(managerRow.getAttribute("data-state")).toBe("in_flight");
      expect(dataStoreRow.getAttribute("data-state")).toBe("queued");
      expect(tivanRow.getAttribute("data-state")).toBe("queued");
      expect(
        screen.getByTestId("apply-preview-dispatch-state-d-manager")
          .textContent,
      ).toMatch(/In flight/);
      expect(
        screen.getByTestId("apply-preview-dispatch-state-d-data-store")
          .textContent,
      ).toMatch(/Queued/);
      // Settle: the resolved row's settled states replace the synthetic
      // in_flight projection.
      await act(async () => {
        resolveConfirm?.(makeRow(attemptId, succeededDispatches, "succeeded"));
      });
      await screen.findByText(/All dispatches succeeded/);
      expect(
        screen
          .getByTestId("apply-preview-dispatch-d-manager")
          .getAttribute("data-state"),
      ).toBe("succeeded");
    });

    it("marks only the retried dispatch as in_flight while retryDispatch is pending", async () => {
      const attemptId = makeAttemptId("d");
      const create = vi.fn().mockResolvedValue(makePlanResult(attemptId));
      const failedDispatches = makeDispatches();
      failedDispatches[0] = { ...failedDispatches[0], state: "succeeded" };
      failedDispatches[1] = {
        ...failedDispatches[1],
        state: "failed_retryable",
        lastError: "transient",
      };
      // failedDispatches[2] stays queued — sequential-advance invariant.
      const confirm = vi
        .fn()
        .mockResolvedValue(
          makeRow(attemptId, failedDispatches, "failed_retryable"),
        );
      let resolveRetry: ((row: ApplyAttemptClientRow) => void) | undefined;
      const retry = vi.fn().mockImplementation(
        () =>
          new Promise<ApplyAttemptClientRow>((resolve) => {
            resolveRetry = resolve;
          }),
      );
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
      // Only the retried dispatch flips to in_flight; the manager row
      // stays succeeded and the queued tivan row stays queued (the
      // resume rule will only advance it after the retried row settles).
      await screen.findByTestId("apply-preview-applying");
      expect(
        screen
          .getByTestId("apply-preview-dispatch-d-manager")
          .getAttribute("data-state"),
      ).toBe("succeeded");
      expect(
        screen
          .getByTestId("apply-preview-dispatch-d-data-store")
          .getAttribute("data-state"),
      ).toBe("in_flight");
      expect(
        screen
          .getByTestId("apply-preview-dispatch-d-tivan")
          .getAttribute("data-state"),
      ).toBe("queued");
      // Prior failure error is cleared on the retried row while running
      // so the failure badge does not visually shadow the in-flight
      // state.
      expect(
        screen.queryByTestId("apply-preview-dispatch-error-d-data-store"),
      ).toBeNull();
      const succeededAll = makeDispatches().map((d) => ({
        ...d,
        state: "succeeded" as const,
      }));
      await act(async () => {
        resolveRetry?.(makeRow(attemptId, succeededAll, "succeeded"));
      });
      await screen.findByText(/All dispatches succeeded/);
    });

    it("Escape during execution does not close the modal; Escape after settling does", async () => {
      const attemptId = makeAttemptId("b");
      const create = vi.fn().mockResolvedValue(makePlanResult(attemptId));
      let resolveConfirm: ((row: ApplyAttemptClientRow) => void) | undefined;
      const succeededDispatches = makeDispatches().map((d) => ({
        ...d,
        state: "succeeded" as const,
      }));
      const confirm = vi.fn().mockImplementation(
        () =>
          new Promise<ApplyAttemptClientRow>((resolve) => {
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
