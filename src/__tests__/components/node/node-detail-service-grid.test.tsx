import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NodeDetailServiceGrid } from "@/components/node/node-detail-service-grid";
import {
  __pushNodeStatusSample,
  __resetNodeStatusStore,
} from "@/hooks/use-node-status-polling";
import { __resetExternalProbeStore } from "@/hooks/use-service-status";
import enMessages from "@/i18n/messages/en.json";
import type {
  Agent,
  ExternalService,
  Node as ManagerNode,
  NodeStatus,
} from "@/lib/node/types";

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

const SENSOR_AGENT: Agent = {
  node: 1,
  key: "sensor-1",
  kind: "SENSOR",
  status: "ENABLED",
  config: 'sensor_listen_addr = "0.0.0.0:38371"\n',
  draft: 'sensor_listen_addr = "0.0.0.0:38380"\n',
};

const SENSOR_AGENT_NO_DRAFT: Agent = {
  ...SENSOR_AGENT,
  draft: null,
};

const UNSUPERVISED_AGENT: Agent = {
  node: 1,
  key: "unsup-1",
  kind: "UNSUPERVISED",
  status: "ENABLED",
  config: "",
  draft: null,
};

const SEMI_SUPERVISED_AGENT: Agent = {
  node: 1,
  key: "semi-1",
  kind: "SEMI_SUPERVISED",
  status: "ENABLED",
  config: 'graphql_srv_addr = "0.0.0.0:8443"\n',
  draft: null,
};

const DATA_STORE_SERVICE: ExternalService = {
  node: 1,
  key: "data-store-1",
  kind: "DATA_STORE",
  status: "ENABLED",
  draft: 'ingest_srv_addr = "0.0.0.0:38380"\n',
};

const DATA_STORE_SERVICE_NO_DRAFT: ExternalService = {
  ...DATA_STORE_SERVICE,
  draft: null,
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

function makeStatus(overrides: Partial<NodeStatus> = {}): NodeStatus {
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
    cpuUsage: 25,
    totalMemory: "16000000000",
    usedMemory: "8000000000",
    totalDiskSpace: "1000000000000",
    usedDiskSpace: "400000000000",
    manager: true,
    agents: [],
    externalServices: [],
    ping: 0.05,
    ...overrides,
  };
}

function renderGrid(
  props: Partial<Parameters<typeof NodeDetailServiceGrid>[0]> = {},
) {
  const node = props.node ?? makeNode();
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <NodeDetailServiceGrid
        node={node}
        canReadServices={true}
        canEditServices={true}
        initialNodeStatus={null}
        initialCapturedAt={null}
        initialEdges={[]}
        externalConfigSnapshot={{}}
        {...props}
      />
    </NextIntlClientProvider>,
  );
}

describe("NodeDetailServiceGrid — manager + unsupervised", () => {
  beforeEach(() => {
    __resetNodeStatusStore();
    __resetExternalProbeStore();
  });
  afterEach(() => {
    __resetNodeStatusStore();
    __resetExternalProbeStore();
  });

  it("renders the Manager card with running badge from NodeStatus.manager", () => {
    const status = makeStatus({ manager: true });
    renderGrid({ initialNodeStatus: status });
    const card = screen.getByTestId("node-detail-manager-card");
    expect(card.getAttribute("data-running")).toBe("true");
    expect(screen.getByTestId("node-detail-manager-badge").textContent).toBe(
      enMessages.nodes.detail.services.managerRunning,
    );
  });

  it("renders the Manager card with not-running badge when manager=false", () => {
    const status = makeStatus({ manager: false });
    renderGrid({ initialNodeStatus: status });
    const card = screen.getByTestId("node-detail-manager-card");
    expect(card.getAttribute("data-running")).toBe("false");
    expect(screen.getByTestId("node-detail-manager-badge").textContent).toBe(
      enMessages.nodes.detail.services.managerNotRunning,
    );
  });

  it("Manager card live-updates from the polling buffer when newer samples arrive", () => {
    // SSR snapshot says manager=true; a subsequent live poll surfaces
    // manager=false. The Manager card must reflect the live value
    // rather than freezing on the SSR snapshot.
    const ssrStatus = makeStatus({ manager: true });
    const liveStatus = makeStatus({ manager: false });
    __pushNodeStatusSample(new Date("2026-04-29T08:00:00.000Z"), [liveStatus]);
    renderGrid({ initialNodeStatus: ssrStatus });
    const card = screen.getByTestId("node-detail-manager-card");
    expect(card.getAttribute("data-running")).toBe("false");
    expect(screen.getByTestId("node-detail-manager-badge").textContent).toBe(
      enMessages.nodes.detail.services.managerNotRunning,
    );
  });

  it("Manager card honours latest === null when the node disappears from a later poll", () => {
    // The polling layer marks `latest === null` when this node is
    // absent from the most recent snapshot, while keeping sample
    // history intact. The Manager card must reflect that absence
    // rather than snapping back to the (now stale) SSR snapshot.
    const ssrStatus = makeStatus({ manager: true });
    const firstSample = makeStatus({ manager: true });
    __pushNodeStatusSample(new Date("2026-04-29T08:00:00.000Z"), [firstSample]);
    // Subsequent snapshot omits node-1 entirely → buffer entry stays
    // but `latest` becomes null.
    __pushNodeStatusSample(new Date("2026-04-29T08:00:10.000Z"), []);
    renderGrid({ initialNodeStatus: ssrStatus });
    const card = screen.getByTestId("node-detail-manager-card");
    expect(card.getAttribute("data-running")).toBe("false");
    expect(screen.getByTestId("node-detail-manager-badge").textContent).toBe(
      enMessages.nodes.detail.services.managerNotRunning,
    );
  });

  it("renders the Unsupervised card with the footnote and no tabs", () => {
    const node = makeNode({ agents: [UNSUPERVISED_AGENT] });
    renderGrid({ node });
    const card = screen.getByTestId("node-detail-service-card-unsupervised");
    expect(card).toBeTruthy();
    expect(
      screen.getByTestId("node-detail-service-unsupervised-note").textContent,
    ).toBe(enMessages.nodes.detail.services.unsupervisedNote);
    // Unsupervised has no tabs.
    expect(
      screen.queryByTestId("node-detail-service-unsupervised-tabs"),
    ).toBeNull();
  });
});

describe("NodeDetailServiceGrid — agent service tabs", () => {
  beforeEach(() => {
    __resetNodeStatusStore();
    __resetExternalProbeStore();
  });
  afterEach(() => {
    __resetNodeStatusStore();
    __resetExternalProbeStore();
  });

  it("renders Applied / Draft / Diff tabs for an agent service with a draft", () => {
    const node = makeNode({ agents: [SENSOR_AGENT] });
    renderGrid({ node });
    expect(
      screen.getByTestId("node-detail-service-sensor-tab-applied"),
    ).toBeTruthy();
    expect(
      screen.getByTestId("node-detail-service-sensor-tab-draft"),
    ).toBeTruthy();
    expect(
      screen.getByTestId("node-detail-service-sensor-tab-diff"),
    ).toBeTruthy();
    expect(
      screen.getByTestId("node-detail-service-sensor-pending"),
    ).toBeTruthy();
  });

  it("hides the pending badge for an agent at steady state (draft == config)", () => {
    // Comparison-based pending detection (#551): no diff vs applied
    // config => not pending. Round-tripped draft (drafts that equal the
    // applied config because the operator has not edited the field
    // since the last apply) is steady state.
    const STEADY_AGENT: Agent = { ...SENSOR_AGENT, draft: SENSOR_AGENT.config };
    const node = makeNode({ agents: [STEADY_AGENT] });
    renderGrid({ node });
    expect(
      screen.queryByTestId("node-detail-service-sensor-pending"),
    ).toBeNull();
  });

  it('hides the pending badge for an agent applied as Manually (config = "", draft = null) (#551 Round 4)', () => {
    // `decisions/node-field-catalog.md` §60-63: `config: ""`, `draft: null`
    // is the wire shape for an agent applied in manual mode with no
    // pending intent. agentPendingState must agree with the list-row
    // classifier so the service card does not flash a phantom Pending
    // badge for a steady-state manual agent.
    const APPLIED_MANUAL_AGENT: Agent = {
      ...SENSOR_AGENT,
      config: "",
      draft: null,
    };
    const node = makeNode({ agents: [APPLIED_MANUAL_AGENT] });
    renderGrid({ node });
    expect(
      screen.queryByTestId("node-detail-service-sensor-pending"),
    ).toBeNull();
  });

  it("shows the pending badge on delete intent (draft = null, config = Some)", () => {
    // Per #333 Decision 9, an agent whose applied config exists but
    // whose draft is null is queued for removal — that's pending,
    // not steady state.
    const node = makeNode({ agents: [SENSOR_AGENT_NO_DRAFT] });
    renderGrid({ node });
    expect(
      screen.getByTestId("node-detail-service-sensor-pending"),
    ).toBeTruthy();
  });

  it("renders the diff delete-marker when the agent has applied config but draft is null", async () => {
    const node = makeNode({ agents: [SEMI_SUPERVISED_AGENT] });
    renderGrid({ node });
    const user = userEvent.setup();
    await user.click(
      screen.getByTestId("node-detail-service-semiSupervised-tab-diff"),
    );
    expect(
      screen.getByTestId("node-detail-service-semiSupervised-diff-delete"),
    ).toBeTruthy();
  });

  it("renders the diff empty-state when the agent has no applied config and no draft", async () => {
    const NEW_AGENT: Agent = { ...SENSOR_AGENT, config: null, draft: null };
    const node = makeNode({ agents: [NEW_AGENT] });
    renderGrid({ node });
    const user = userEvent.setup();
    await user.click(screen.getByTestId("node-detail-service-sensor-tab-diff"));
    const empty = screen.getByTestId("node-detail-service-sensor-diff-empty");
    expect(empty.textContent).toContain("No pending changes for this service.");
  });

  it("Diff tab lists only changed fields when a draft exists", async () => {
    const node = makeNode({ agents: [SENSOR_AGENT] });
    renderGrid({ node });
    const user = userEvent.setup();
    await user.click(screen.getByTestId("node-detail-service-sensor-tab-diff"));
    // sensor_listen_addr changed from 38371 → 38380; that single field
    // should appear in the diff table.
    const row = screen.getByTestId(
      "node-detail-service-sensor-diff-row-sensor_listen_addr",
    );
    expect(row).toBeTruthy();
    expect(row.textContent).toContain("0.0.0.0:38371");
    expect(row.textContent).toContain("0.0.0.0:38380");
    // No other fields should render — the empty-state must not appear
    // when the diff has rows.
    expect(
      screen.queryByTestId("node-detail-service-sensor-diff-empty"),
    ).toBeNull();
  });

  it("renders an Edit-this-service link inside the Draft tab when canEdit=true", async () => {
    const node = makeNode({ agents: [SENSOR_AGENT] });
    renderGrid({ node, canEditServices: true });
    const user = userEvent.setup();
    await user.click(
      screen.getByTestId("node-detail-service-sensor-tab-draft"),
    );
    expect(
      screen.getByTestId("node-detail-service-sensor-edit-link"),
    ).toBeTruthy();
  });

  it("emits the registry kebab-case kind in the Edit-this-service URL so the dialog can auto-focus", async () => {
    // Round 5 reviewer: the link previously appended `#service-<key>`
    // but nothing on the settings page or dialog consumed the
    // fragment. The new contract pushes `?service=<registry-kind>` so
    // the dialog can expand + scroll the matching accordion. Assert
    // the camelCase ServiceKind (`semiSupervised`, `dataStore`,
    // `tiContainer`, `timeSeries`) is mapped to the registry's
    // kebab-case value before going on the wire.
    const TIME_SERIES_AGENT: Agent = {
      node: 1,
      key: "ts-1",
      kind: "TIME_SERIES_GENERATOR",
      status: "ENABLED",
      config: 'srv_addr = "0.0.0.0:8443"\n',
      draft: 'srv_addr = "0.0.0.0:8444"\n',
    };
    const makeExternal = (kind: ExternalService["kind"]): ExternalService => ({
      node: 1,
      key: `${kind.toLowerCase()}-1`,
      kind,
      status: "ENABLED",
      draft: 'ingest_srv_addr = "0.0.0.0:38380"\n',
    });
    const cases: Array<{
      agent?: Agent;
      external?: ExternalService;
      key: string;
      param: string;
    }> = [
      {
        agent: SEMI_SUPERVISED_AGENT,
        key: "semiSupervised",
        param: "semi-supervised",
      },
      {
        agent: TIME_SERIES_AGENT,
        key: "timeSeries",
        param: "time-series",
      },
      {
        external: makeExternal("DATA_STORE"),
        key: "dataStore",
        param: "data-store",
      },
      {
        external: makeExternal("TI_CONTAINER"),
        key: "tiContainer",
        param: "ti-container",
      },
    ];
    for (const { agent, external, key, param } of cases) {
      const node = makeNode({
        agents: agent ? [agent] : [],
        externalServices: external ? [external] : [],
      });
      const { unmount } = renderGrid({ node, canEditServices: true });
      const user = userEvent.setup();
      await user.click(
        screen.getByTestId(`node-detail-service-${key}-tab-draft`),
      );
      const link = screen.getByTestId(
        `node-detail-service-${key}-edit-link`,
      ) as HTMLAnchorElement;
      // next-intl's <Link /> may decorate the locale prefix; the
      // important invariant is that the registry kind reaches the
      // settings page as a plain `service` query param.
      expect(link.getAttribute("href")).toContain(`service=${param}`);
      expect(link.getAttribute("href")).toContain(`dialog=edit&id=${node.id}`);
      // The old fragment-based form is gone — the dialog never
      // consumed it, so emitting it would still leave the user on
      // the generic top of the dialog.
      expect(link.getAttribute("href")).not.toContain("#service-");
      unmount();
    }
  });

  it("hides the Edit-this-service link when canEdit=false", async () => {
    const node = makeNode({ agents: [SENSOR_AGENT] });
    renderGrid({ node, canEditServices: false });
    const user = userEvent.setup();
    await user.click(
      screen.getByTestId("node-detail-service-sensor-tab-draft"),
    );
    expect(
      screen.queryByTestId("node-detail-service-sensor-edit-link"),
    ).toBeNull();
  });
});

describe("NodeDetailServiceGrid — external service unreachable copy", () => {
  beforeEach(() => {
    __resetNodeStatusStore();
    __resetExternalProbeStore();
  });
  afterEach(() => {
    __resetNodeStatusStore();
    __resetExternalProbeStore();
  });

  it("renders the verbatim unreachable copy on the Applied tab when unreachable", () => {
    const node = makeNode({ externalServices: [DATA_STORE_SERVICE] });
    renderGrid({
      node,
      externalConfigSnapshot: { DATA_STORE: "unavailable" },
    });
    const applied = screen.getByTestId(
      "node-detail-service-dataStore-applied-unreachable",
    );
    expect(applied.textContent).toBe(
      "This service is currently unreachable; applied configuration cannot be read.",
    );
  });

  it("renders the verbatim unreachable copy on the Diff tab when unreachable", async () => {
    const node = makeNode({ externalServices: [DATA_STORE_SERVICE] });
    renderGrid({
      node,
      externalConfigSnapshot: { DATA_STORE: "unavailable" },
    });
    const user = userEvent.setup();
    await user.click(
      screen.getByTestId("node-detail-service-dataStore-tab-diff"),
    );
    const diff = screen.getByTestId(
      "node-detail-service-dataStore-diff-unreachable",
    );
    expect(diff.textContent).toBe(
      "Diff cannot be computed while the service is unreachable.",
    );
  });

  it("Draft tab continues to render normally when the external is unreachable", async () => {
    const node = makeNode({ externalServices: [DATA_STORE_SERVICE] });
    renderGrid({
      node,
      externalConfigSnapshot: { DATA_STORE: "unavailable" },
    });
    const user = userEvent.setup();
    await user.click(
      screen.getByTestId("node-detail-service-dataStore-tab-draft"),
    );
    const draft = screen.getByTestId("node-detail-service-dataStore-draft");
    expect(draft.textContent).toContain("ingest_srv_addr");
  });

  it("renders applied config when reachable and applied TOML is provided", () => {
    const node = makeNode({ externalServices: [DATA_STORE_SERVICE_NO_DRAFT] });
    renderGrid({
      node,
      externalConfigSnapshot: {
        DATA_STORE: 'ingest_srv_addr = "10.0.0.1:38370"\n',
      },
    });
    const applied = screen.getByTestId("node-detail-service-dataStore-applied");
    expect(applied.textContent).toContain("ingest_srv_addr");
  });
});

describe("NodeDetailServiceGrid — no per-service Apply button", () => {
  beforeEach(() => {
    __resetNodeStatusStore();
    __resetExternalProbeStore();
  });
  afterEach(() => {
    __resetNodeStatusStore();
    __resetExternalProbeStore();
  });

  it("renders no Apply button on any service card (v1 ships node-level apply only)", () => {
    const node = makeNode({
      agents: [SENSOR_AGENT, UNSUPERVISED_AGENT, SEMI_SUPERVISED_AGENT],
      externalServices: [DATA_STORE_SERVICE],
    });
    const { container } = renderGrid({
      node,
      canEditServices: true,
    });
    // Per-service Apply buttons land in Phase Node-12. Verify by an
    // exhaustive sweep — anything matching `apply` text or testid must
    // NOT appear inside a service card body.
    const cards = container.querySelectorAll(
      "[data-testid^='node-detail-service-card-']",
    );
    expect(cards.length).toBeGreaterThan(0);
    cards.forEach((card) => {
      const buttons = card.querySelectorAll("button");
      buttons.forEach((btn) => {
        const text = (btn.textContent ?? "").toLowerCase();
        expect(text.includes("apply")).toBe(false);
      });
    });
  });
});
