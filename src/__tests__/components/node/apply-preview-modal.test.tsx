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
});
