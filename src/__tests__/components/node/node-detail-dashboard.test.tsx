import { fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { act } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NodeDetailDashboard } from "@/components/node/node-detail-dashboard";
import {
  __pushNodeStatusSample,
  __resetNodeStatusStore,
  __setNodeStatusManagerUnreachable,
} from "@/hooks/use-node-status-polling";
import enMessages from "@/i18n/messages/en.json";
import type {
  ApplyAttemptRow,
  CreateApplyAttemptResult,
  PlannedDispatch,
} from "@/lib/node/apply-attempt-types";
import type { Node as ManagerNode, NodeStatus } from "@/lib/node/types";

vi.mock("@/i18n/navigation", () => ({
  Link: ({
    children,
    ...rest
  }: { children: React.ReactNode } & Record<string, unknown>) => (
    <a {...rest}>{children}</a>
  ),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/nodes/node-1",
}));

vi.mock("@/components/session/session-extension-dialog", () => ({
  readCsrfToken: () => "test-csrf",
}));

const NOOP_APPLY_ACTIONS = {
  createApplyAttempt: vi.fn(),
  confirmApplyAttempt: vi.fn(),
  retryDispatch: vi.fn(),
};

function makeNode(overrides: Partial<ManagerNode> = {}): ManagerNode {
  return {
    id: "node-1",
    name: "alpha",
    nameDraft: null,
    profile: {
      customerId: "5",
      hostname: "alpha.local",
      description: "Alpha node",
    },
    profileDraft: null,
    agents: [],
    externalServices: [],
    ...overrides,
  };
}

function renderDashboard(
  props: Partial<Parameters<typeof NodeDetailDashboard>[0]> = {},
) {
  const node = props.node ?? makeNode();
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <NodeDetailDashboard
        node={node}
        customers={[{ id: "5", name: "ACME" }]}
        canEdit={true}
        canDelete={true}
        canControl={true}
        canApply={true}
        initialNodeStatus={null}
        initialCapturedAt={null}
        initialEdges={[]}
        lastAppliedAt={null}
        externalConfigSnapshot={{}}
        applyActions={NOOP_APPLY_ACTIONS}
        {...props}
      />
    </NextIntlClientProvider>,
  );
}

describe("NodeDetailDashboard — sections", () => {
  beforeEach(() => {
    __resetNodeStatusStore();
  });
  afterEach(() => {
    __resetNodeStatusStore();
  });

  it("renders metadata fields, ping badge, and three resource sparklines", () => {
    renderDashboard();
    expect(screen.getByTestId("node-detail-dashboard")).toBeTruthy();
    expect(screen.getByTestId("node-detail-meta-name").textContent).toBe(
      "alpha",
    );
    expect(screen.getByTestId("node-detail-meta-hostname").textContent).toBe(
      "alpha.local",
    );
    expect(screen.getByTestId("node-detail-meta-customer").textContent).toBe(
      "ACME",
    );
    expect(screen.getByTestId("node-detail-meta-description").textContent).toBe(
      "Alpha node",
    );
    expect(screen.getByTestId("node-detail-ping")).toBeTruthy();
    expect(screen.getByTestId("node-detail-sparkline-cpu")).toBeTruthy();
    expect(screen.getByTestId("node-detail-sparkline-memory")).toBeTruthy();
    expect(screen.getByTestId("node-detail-sparkline-disk")).toBeTruthy();
  });

  it("shows pending-change indicator when the node carries any draft", () => {
    const node = makeNode({
      nameDraft: "alpha-renamed",
    });
    renderDashboard({ node });
    expect(screen.getByTestId("node-detail-pending-badge")).toBeTruthy();
  });

  it("shows the no-pending-changes label when no drafts exist", () => {
    renderDashboard();
    expect(screen.getByTestId("node-detail-no-pending")).toBeTruthy();
    expect(screen.queryByTestId("node-detail-pending-badge")).toBeNull();
  });

  it("renders the unknown-state badge and disables Apply when an external is unavailable (#551)", () => {
    const node = makeNode({
      externalServices: [
        {
          node: 1,
          key: "k1",
          kind: "DATA_STORE",
          status: "ENABLED",
          draft: 'ingest_srv_addr = "x"\n',
        },
      ],
    });
    renderDashboard({
      node,
      externalConfigSnapshot: { DATA_STORE: "unavailable" },
    });
    expect(
      screen.getByTestId("node-detail-pending-unknown-badge"),
    ).toBeTruthy();
    expect(screen.queryByTestId("node-detail-pending-badge")).toBeNull();
    const applyButton = screen.getByTestId("node-detail-apply-all");
    expect((applyButton as HTMLButtonElement).disabled).toBe(true);
  });

  it("treats a steady-state external (draft structurally equals applied) as not pending", () => {
    const node = makeNode({
      externalServices: [
        {
          node: 1,
          key: "k1",
          kind: "DATA_STORE",
          status: "ENABLED",
          draft: 'ingest_srv_addr = "x"\n',
        },
      ],
    });
    renderDashboard({
      node,
      externalConfigSnapshot: { DATA_STORE: 'ingest_srv_addr = "x"\n' },
    });
    expect(screen.getByTestId("node-detail-no-pending")).toBeTruthy();
    expect(screen.queryByTestId("node-detail-pending-badge")).toBeNull();
  });

  it("treats an external with manager.draft != endpoint.config as pending", () => {
    const node = makeNode({
      externalServices: [
        {
          node: 1,
          key: "k1",
          kind: "DATA_STORE",
          status: "ENABLED",
          draft: 'ingest_srv_addr = "new"\n',
        },
      ],
    });
    renderDashboard({
      node,
      externalConfigSnapshot: { DATA_STORE: 'ingest_srv_addr = "old"\n' },
    });
    expect(screen.getByTestId("node-detail-pending-badge")).toBeTruthy();
  });

  it("uses ping=null (initialNodeStatus.ping=null) to render the dead badge", () => {
    const status: NodeStatus = {
      id: "node-1",
      name: "alpha",
      nameDraft: null,
      profile: {
        customerId: "5",
        hostname: "alpha.local",
        description: "Alpha node",
      },
      profileDraft: null,
      cpuUsage: null,
      totalMemory: null,
      usedMemory: null,
      totalDiskSpace: null,
      usedDiskSpace: null,
      manager: false,
      agents: [],
      externalServices: [],
      ping: null,
    };
    renderDashboard({ initialNodeStatus: status });
    const badge = screen.getByTestId("node-detail-ping");
    expect(badge.getAttribute("data-ping")).toBe("dead");
  });
});

describe("NodeDetailDashboard — permission gating", () => {
  beforeEach(() => {
    __resetNodeStatusStore();
  });
  afterEach(() => {
    __resetNodeStatusStore();
  });

  it("shows every write affordance when all permissions granted", () => {
    renderDashboard();
    expect(screen.getByTestId("node-detail-edit")).toBeTruthy();
    expect(screen.getByTestId("node-detail-restart")).toBeTruthy();
    expect(screen.getByTestId("node-detail-shutdown")).toBeTruthy();
    expect(screen.getByTestId("node-detail-apply-all")).toBeTruthy();
    expect(screen.getByTestId("node-detail-delete")).toBeTruthy();
  });

  it("hides Edit when canEdit=false", () => {
    renderDashboard({ canEdit: false });
    expect(screen.queryByTestId("node-detail-edit")).toBeNull();
  });

  it("hides Restart and Shutdown when canControl=false", () => {
    renderDashboard({ canControl: false });
    expect(screen.queryByTestId("node-detail-restart")).toBeNull();
    expect(screen.queryByTestId("node-detail-shutdown")).toBeNull();
  });

  it("hides Apply All Pending when canApply=false", () => {
    renderDashboard({ canApply: false });
    expect(screen.queryByTestId("node-detail-apply-all")).toBeNull();
  });

  it("hides Delete when canDelete=false", () => {
    renderDashboard({ canDelete: false });
    expect(screen.queryByTestId("node-detail-delete")).toBeNull();
  });

  it("hides every write affordance for a Security Monitor (read-only) caller", () => {
    renderDashboard({
      canEdit: false,
      canControl: false,
      canApply: false,
      canDelete: false,
    });
    expect(screen.queryByTestId("node-detail-edit")).toBeNull();
    expect(screen.queryByTestId("node-detail-restart")).toBeNull();
    expect(screen.queryByTestId("node-detail-shutdown")).toBeNull();
    expect(screen.queryByTestId("node-detail-apply-all")).toBeNull();
    expect(screen.queryByTestId("node-detail-delete")).toBeNull();
    // Read content still renders.
    expect(screen.getByTestId("node-detail-meta-name")).toBeTruthy();
  });
});

describe("NodeDetailDashboard — manager offline", () => {
  beforeEach(() => {
    __resetNodeStatusStore();
  });
  afterEach(() => {
    __resetNodeStatusStore();
    __setNodeStatusManagerUnreachable(false);
  });

  it("renders the offline panel when the live polling buffer flips isManagerUnreachable", () => {
    __setNodeStatusManagerUnreachable(true);
    renderDashboard();
    expect(screen.getByTestId("manager-unavailable-panel")).toBeTruthy();
    // Dashboard chrome must NOT render in this mid-session offline state.
    expect(screen.queryByTestId("node-detail-dashboard")).toBeNull();
  });

  it("keeps the dashboard rendered when only the SSR seed path failed", () => {
    // The seed-path failure is non-fatal: `getNode()` already
    // succeeded, so metadata + service grid stay rendered, and the
    // sparklines fall back to their empty state until the next poll
    // recovers. The polling buffer's `isManagerUnreachable` flag is
    // the only signal that swaps to the offline panel.
    renderDashboard();
    expect(screen.queryByTestId("manager-unavailable-panel")).toBeNull();
    expect(screen.getByTestId("node-detail-dashboard")).toBeTruthy();
  });
});

describe("NodeDetailDashboard — last applied + ping last seen", () => {
  beforeEach(() => {
    __resetNodeStatusStore();
  });
  afterEach(() => {
    __resetNodeStatusStore();
  });

  it("renders the lastApplied metadata field with the supplied ISO timestamp", () => {
    const iso = "2026-04-29T08:30:00.000Z";
    renderDashboard({ lastAppliedAt: iso });
    const cell = screen.getByTestId("node-detail-meta-last-applied");
    expect(cell.getAttribute("data-iso")).toBe(iso);
    // The cell must surface a real timestamp value — never the
    // "Never applied" fallback when the server already has the ISO.
    const text = cell.textContent ?? "";
    expect(text).not.toBe(enMessages.nodes.detail.metadata.neverApplied);
    expect(text.length).toBeGreaterThan(0);
    // Must contain at least one digit from the timestamp (the year).
    expect(text).toMatch(/\d/);
  });

  it("falls back to the never-applied copy when lastAppliedAt is null", () => {
    renderDashboard({ lastAppliedAt: null });
    const cell = screen.getByTestId("node-detail-meta-last-applied");
    expect(cell.textContent).toBe(
      enMessages.nodes.detail.metadata.neverApplied,
    );
  });

  it("renders the timestamp of the last successful ping (not RTT) when alive", () => {
    const status: NodeStatus = {
      id: "node-1",
      name: "alpha",
      nameDraft: null,
      profile: {
        customerId: "5",
        hostname: "alpha.local",
        description: "Alpha node",
      },
      profileDraft: null,
      cpuUsage: 12,
      totalMemory: "16000000000",
      usedMemory: "8000000000",
      totalDiskSpace: "1000000000000",
      usedDiskSpace: "500000000000",
      manager: true,
      agents: [],
      externalServices: [],
      ping: 0.05,
    };
    const capturedAt = new Date("2026-04-29T08:00:00.000Z");
    __pushNodeStatusSample(capturedAt, [status]);
    renderDashboard({ initialNodeStatus: status });
    const lastSeen = screen.getByTestId("node-detail-ping-last-seen");
    // Locale formatting varies, but the badge must render the
    // capturedAt clock time — never the RTT in milliseconds.
    expect(lastSeen.textContent ?? "").not.toMatch(/\dms/);
    expect(lastSeen.textContent ?? "").toMatch(/\d/);
  });

  it("renders the dead badge when the node disappears from a later snapshot", () => {
    // The polling layer marks `latest === null` when this node is
    // absent from the most recent snapshot but preserves sample
    // history. The dashboard must surface that absence (alive=false)
    // rather than collapsing back to the SSR `initialNodeStatus`,
    // which would render an alive badge on a node that is no longer
    // reporting.
    const aliveSample: NodeStatus = {
      id: "node-1",
      name: "alpha",
      nameDraft: null,
      profile: null,
      profileDraft: null,
      cpuUsage: null,
      totalMemory: null,
      usedMemory: null,
      totalDiskSpace: null,
      usedDiskSpace: null,
      manager: true,
      agents: [],
      externalServices: [],
      ping: 0.04,
    };
    __pushNodeStatusSample(new Date("2026-04-29T08:00:00.000Z"), [aliveSample]);
    // Subsequent poll omits node-1: buffer survives, `latest` flips
    // to null.
    __pushNodeStatusSample(new Date("2026-04-29T08:00:10.000Z"), []);
    renderDashboard({ initialNodeStatus: aliveSample });
    const badge = screen.getByTestId("node-detail-ping");
    expect(badge.getAttribute("data-ping")).toBe("dead");
    // The "Last seen" line still walks back through the buffered
    // samples to surface the most recent successful ping.
    expect(screen.getByTestId("node-detail-ping-last-seen")).toBeTruthy();
  });

  it("renders the dead badge with the most recent successful-ping timestamp", () => {
    const aliveSample: NodeStatus = {
      id: "node-1",
      name: "alpha",
      nameDraft: null,
      profile: null,
      profileDraft: null,
      cpuUsage: null,
      totalMemory: null,
      usedMemory: null,
      totalDiskSpace: null,
      usedDiskSpace: null,
      manager: true,
      agents: [],
      externalServices: [],
      ping: 0.04,
    };
    const deadSample: NodeStatus = { ...aliveSample, ping: null };
    __pushNodeStatusSample(new Date("2026-04-29T08:00:00.000Z"), [aliveSample]);
    __pushNodeStatusSample(new Date("2026-04-29T08:00:10.000Z"), [deadSample]);
    renderDashboard({ initialNodeStatus: deadSample });
    const badge = screen.getByTestId("node-detail-ping");
    expect(badge.getAttribute("data-ping")).toBe("dead");
    // Even though the latest sample has ping=null, the badge surfaces
    // when the node was last seen via the prior alive sample.
    expect(screen.getByTestId("node-detail-ping-last-seen")).toBeTruthy();
  });
});

describe("NodeDetailDashboard — resource progress bars", () => {
  beforeEach(() => {
    __resetNodeStatusStore();
  });
  afterEach(() => {
    __resetNodeStatusStore();
  });

  it("renders a progress bar with a numeric label below each sparkline", () => {
    const status: NodeStatus = {
      id: "node-1",
      name: "alpha",
      nameDraft: null,
      profile: null,
      profileDraft: null,
      cpuUsage: 42.5,
      totalMemory: "16000000000",
      usedMemory: "8000000000",
      totalDiskSpace: "1000000000000",
      usedDiskSpace: "400000000000",
      manager: true,
      agents: [],
      externalServices: [],
      ping: 0.04,
    };
    __pushNodeStatusSample(new Date("2026-04-29T08:00:00.000Z"), [status]);
    renderDashboard({ initialNodeStatus: status });
    const cpuBar = screen.getByTestId("node-detail-sparkline-progress-cpu");
    expect(cpuBar.textContent ?? "").toContain("42.5%");
    expect(
      screen.getByTestId("node-detail-sparkline-progress-memory"),
    ).toBeTruthy();
    expect(
      screen.getByTestId("node-detail-sparkline-progress-disk"),
    ).toBeTruthy();
  });
});

describe("NodeDetailDashboard — SSR sparkline seed", () => {
  beforeEach(() => {
    __resetNodeStatusStore();
  });
  afterEach(() => {
    __resetNodeStatusStore();
  });

  it("renders progress bars on the SSR pass before the seed effect runs", () => {
    // The polling buffer is seeded from the SSR snapshot in a
    // useEffect that does not run on the server. To satisfy the
    // "first paint already carries one point on the sparkline"
    // contract the dashboard must synthesize one sample from the
    // SSR payload during render — proven here by checking the SSR
    // markup directly (renderToString runs the synchronous render
    // only; effects never fire).
    const status: NodeStatus = {
      id: "node-1",
      name: "alpha",
      nameDraft: null,
      profile: null,
      profileDraft: null,
      cpuUsage: 33.3,
      totalMemory: "16000000000",
      usedMemory: "8000000000",
      totalDiskSpace: "1000000000000",
      usedDiskSpace: "400000000000",
      manager: true,
      agents: [],
      externalServices: [],
      ping: 0.04,
    };
    const html = renderToString(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <NodeDetailDashboard
          node={makeNode()}
          customers={[{ id: "5", name: "ACME" }]}
          canEdit={true}
          canDelete={true}
          canControl={true}
          canApply={true}
          initialNodeStatus={status}
          initialCapturedAt="2026-04-29T08:00:00.000Z"
          initialEdges={[status]}
          lastAppliedAt={null}
          externalConfigSnapshot={{}}
          applyActions={NOOP_APPLY_ACTIONS}
        />
      </NextIntlClientProvider>,
    );
    expect(html).toContain("node-detail-sparkline-progress-cpu");
    expect(html).toContain("33.3%");
    expect(html).toContain("node-detail-sparkline-progress-memory");
    expect(html).toContain("node-detail-sparkline-progress-disk");
  });
});

describe("NodeDetailDashboard — apply preview modal wiring", () => {
  beforeEach(() => {
    __resetNodeStatusStore();
  });
  afterEach(() => {
    __resetNodeStatusStore();
  });

  it("retry on a failed external dispatch delegates to retryDispatch with the right inputs", async () => {
    // Drive the full Apply All flow as the operator would: open the
    // confirm dialog from the dashboard, confirm to mount the preview
    // modal, walk through createApplyAttempt + confirmApplyAttempt, and
    // finally click the per-row Retry button to verify retryDispatch
    // is invoked with the attemptId/dispatchId pair the modal exposed.
    //
    // The dispatcher-level "fresh `old` snapshot before retry"
    // invariant is covered by #361's own integration tests (per the
    // issue's acceptance footnote), so this test stops at the call
    // boundary — it just asserts the wiring delivers the user's click
    // to retryDispatch with the right payload.
    const attemptId = "00000000-0000-0000-0000-000000000001";
    const dispatchId = "d-data-store";
    const planned: PlannedDispatch[] = [
      {
        dispatchId: "d-manager",
        kind: "MANAGER_DB",
        state: "queued",
        attemptCount: 0,
        lastError: null,
      },
      {
        dispatchId,
        kind: "DATA_STORE",
        state: "queued",
        attemptCount: 0,
        lastError: null,
        new: 'ingest_srv_addr = "10.0.0.1:38370"\n',
      },
    ];
    const planResult: CreateApplyAttemptResult = {
      attemptId,
      plannedDispatches: planned,
      draftFingerprint: "deadbeef",
      expiresAt: "2099-12-31T23:59:59.999Z",
    };
    const failedRow: ApplyAttemptRow = {
      attemptId,
      nodeId: "node-1",
      draftFingerprint: Buffer.from("deadbeef", "hex"),
      plannedDispatches: [
        { ...planned[0], state: "succeeded" },
        {
          ...planned[1],
          state: "failed_retryable",
          lastError: "transient",
        },
      ],
      createdBy: "user",
      createdAt: new Date(),
      expiresAt: new Date("2099-12-31T23:59:59.999Z"),
      executingLock: null,
      claimStartedAt: null,
      status: "failed_retryable",
      customerId: 5,
    };
    const succeededRow: ApplyAttemptRow = {
      ...failedRow,
      plannedDispatches: planned.map((d) => ({
        ...d,
        state: "succeeded" as const,
      })),
      status: "succeeded",
    };

    const createApplyAttempt = vi.fn().mockResolvedValue(planResult);
    const confirmApplyAttempt = vi.fn().mockResolvedValue(failedRow);
    const retryDispatch = vi.fn().mockResolvedValue(succeededRow);

    renderDashboard({
      applyActions: {
        createApplyAttempt,
        confirmApplyAttempt,
        retryDispatch,
      },
    });

    // 1. Click Apply All Pending → opens the confirm dialog.
    fireEvent.click(screen.getByTestId("node-detail-apply-all"));

    // 2. Confirm → closes dialog, opens the ApplyPreviewModal which
    //    fires createApplyAttempt on mount.
    await act(async () => {
      fireEvent.click(
        screen.getByTestId("node-detail-apply-all-confirm-button"),
      );
    });
    expect(createApplyAttempt).toHaveBeenCalledWith({ nodeId: "node-1" });

    // 3. Apply → fires confirmApplyAttempt, settles to failed_retryable
    //    so the per-row Retry button renders.
    const applyButton = await screen.findByTestId("apply-preview-apply");
    await act(async () => {
      fireEvent.click(applyButton);
    });
    expect(confirmApplyAttempt).toHaveBeenCalledWith({ attemptId });

    // 4. Retry the failed external dispatch → must reach retryDispatch
    //    with the exposed attemptId + dispatchId.
    const retryButton = await screen.findByTestId(
      `apply-preview-retry-${dispatchId}`,
    );
    await act(async () => {
      fireEvent.click(retryButton);
    });
    expect(retryDispatch).toHaveBeenCalledWith({ attemptId, dispatchId });
  });
});
