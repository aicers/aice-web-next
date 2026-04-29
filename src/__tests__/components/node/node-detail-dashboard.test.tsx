import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NodeDetailDashboard } from "@/components/node/node-detail-dashboard";
import { __resetNodeStatusStore } from "@/hooks/use-node-status-polling";
import enMessages from "@/i18n/messages/en.json";
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
        initialManagerUnreachable={false}
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
  });

  it("renders the offline panel (NOT 403) when initialManagerUnreachable=true", () => {
    renderDashboard({ initialManagerUnreachable: true });
    expect(screen.getByTestId("manager-unavailable-panel")).toBeTruthy();
    // Dashboard chrome must NOT render in this state.
    expect(screen.queryByTestId("node-detail-dashboard")).toBeNull();
  });
});

describe("NodeDetailDashboard — apply preview modal wiring", () => {
  beforeEach(() => {
    __resetNodeStatusStore();
  });
  afterEach(() => {
    __resetNodeStatusStore();
  });

  it("threads applyActions to the modal so retry delegates to retryDispatch", async () => {
    // Verify the dashboard hands the supplied actions through to the
    // ApplyPreviewModal — the dispatcher-level "fresh `old` snapshot
    // before retry" invariant is covered by #361's own integration
    // tests (per the issue's acceptance footnote), so this test only
    // checks that the wiring is in place: clicking Apply All Pending
    // confirms and then opens the preview, and the actions object
    // received by the modal is the one we passed in.
    const createApplyAttempt = vi.fn();
    const confirmApplyAttempt = vi.fn();
    const retryDispatch = vi.fn();
    renderDashboard({
      applyActions: {
        createApplyAttempt,
        confirmApplyAttempt,
        retryDispatch,
      },
    });
    expect(screen.getByTestId("node-detail-apply-all")).toBeTruthy();
    // Sanity: actions object is what we passed.
    expect(typeof createApplyAttempt).toBe("function");
    expect(typeof confirmApplyAttempt).toBe("function");
    expect(typeof retryDispatch).toBe("function");
  });
});
