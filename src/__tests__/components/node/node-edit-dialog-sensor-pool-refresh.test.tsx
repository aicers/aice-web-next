/**
 * Reviewer Round 18: the stale-conflict refresh path must re-fetch
 * the sensor pool that Hog's `active_sensors` checklist serialises
 * against.
 *
 * Concrete failure path the reviewer flagged: dialog opens with pool
 * `[sensor-a, sensor-b]`; another writer adds `sensor-c` elsewhere
 * and also edits this node so Save trips a stale-conflict. Choose
 * Keep editing, then Save again. With the bug, the dialog's serialise
 * step still sees pool `[sensor-a, sensor-b]` and `serialiseSemiSupervised`
 * collapses an `[a, b]` selection to `active_sensors = None` (set
 * equality with the stale pool); the manager-side deserialise reads
 * that as the *current* pool `[a, b, c]`, silently selecting a sensor
 * the user never saw.
 *
 * The fix is to surface the fresh sensor pool from the BFF's GET
 * /api/nodes/[id] response and route it through the dialog's
 * `liveSensorOptions` state so both the form re-render and the next
 * serialise see the updated pool.
 *
 * This test asserts the wire-up by mounting the real dialog with
 * `pool = [{id:"1"}]`, mocking the PATCH → 409 → GET sequence the
 * reconciliation prompt drives, and confirming the
 * `SemiSupervisedForm` receives the refreshed pool from the response
 * (`[{id:"1"}, {id:"2"}, {id:"3"}]`).
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/components/session/session-extension-dialog", () => ({
  readCsrfToken: () => "test-csrf",
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({
    children,
    open,
  }: {
    children: React.ReactNode;
    open?: boolean;
  }) => (open ? <div data-slot="dialog">{children}</div> : null),
  DialogClose: ({ children }: { children: React.ReactNode }) => (
    <span data-slot="dialog-close">{children}</span>
  ),
  DialogContent: ({ children }: { children: React.ReactNode }) => (
    <div data-slot="dialog-content">{children}</div>
  ),
  DialogFooter: ({ children }: { children: React.ReactNode }) => (
    <div data-slot="dialog-footer">{children}</div>
  ),
  DialogHeader: ({ children }: { children: React.ReactNode }) => (
    <div data-slot="dialog-header">{children}</div>
  ),
  DialogTitle: ({ children }: { children: React.ReactNode }) => (
    <h2 data-slot="dialog-title">{children}</h2>
  ),
}));

vi.mock("@/components/ui/checkbox", () => ({
  Checkbox: ({
    id,
    checked,
    onCheckedChange,
    "data-testid": testId,
  }: {
    id?: string;
    checked?: boolean;
    onCheckedChange?: (v: boolean) => void;
    "data-testid"?: string;
  }) => (
    <input
      type="checkbox"
      id={id}
      data-testid={testId}
      checked={!!checked}
      onChange={(event) => onCheckedChange?.(event.target.checked)}
    />
  ),
}));

vi.mock("@/components/ui/switch", () => ({
  Switch: ({ checked }: { checked?: boolean }) => (
    <input type="checkbox" defaultChecked={!!checked} readOnly />
  ),
}));

vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: React.ReactNode }) => (
    <div data-slot="select">{children}</div>
  ),
  SelectTrigger: ({ children }: { children: React.ReactNode }) => (
    <button type="button" data-slot="select-trigger">
      {children}
    </button>
  ),
  SelectValue: ({ placeholder }: { placeholder?: string }) => (
    <span data-slot="select-value">{placeholder}</span>
  ),
  SelectContent: ({ children }: { children: React.ReactNode }) => (
    <div data-slot="select-content">{children}</div>
  ),
  SelectItem: ({
    children,
    value,
  }: {
    children: React.ReactNode;
    value: string;
  }) => (
    <div data-slot="select-item" data-value={value}>
      {children}
    </div>
  ),
}));

// The stub records the live `sensorOptions` prop value as a JSON
// string on a data attribute so the test can assert pool drift across
// the refresh cycle without depending on the real Hog form internals.
vi.mock("@/components/node/forms/semi-supervised-form", () => ({
  SemiSupervisedForm: ({
    sensorOptions,
  }: {
    sensorOptions: readonly { id: string; name: string }[];
  }) => (
    <div
      data-testid="semi-supervised-stub"
      data-sensor-ids={sensorOptions.map((s) => s.id).join(",")}
    />
  ),
}));

import { NodeEditDialog } from "@/components/node/node-edit-dialog";
import type { SensorNodeOption } from "@/lib/node/sensor-list";
import type { Node as ManagerNode } from "@/lib/node/types";

const customers = [{ id: "1", name: "Acme" }];

const editNode: ManagerNode = {
  id: "42",
  name: "alpha",
  nameDraft: null,
  profile: {
    customerId: "1",
    description: "primary",
    hostname: "alpha.local",
  },
  profileDraft: null,
  agents: [],
  externalServices: [],
};

const refreshedNode: ManagerNode = {
  ...editNode,
  // Mirror the canonical fixture shape; nothing about the node itself
  // changes for this test — only the sensor pool drifts.
};

const initialPool: readonly SensorNodeOption[] = [
  { id: "1", name: "alpha-sensor", hostname: "alpha.local" },
];

const refreshedPool: readonly SensorNodeOption[] = [
  { id: "1", name: "alpha-sensor", hostname: "alpha.local" },
  { id: "2", name: "beta-sensor", hostname: "beta.local" },
  { id: "3", name: "gamma-sensor", hostname: "gamma.local" },
];

function Harness() {
  const [open, setOpen] = useState(true);
  return (
    <NodeEditDialog
      open={open}
      onOpenChange={setOpen}
      mode="edit"
      customers={customers}
      existingNames={[]}
      existingHostnames={[]}
      sensorOptions={initialPool}
      node={editNode}
      onSuccess={() => {}}
    />
  );
}

describe("NodeEditDialog stale-conflict refresh updates the sensor pool", () => {
  it("rebuilds Hog's sensorOptions from the BFF GET response", async () => {
    const fetchMock = vi
      .fn()
      // First call: PATCH triggered by Save → 409 with `field: null`
      // surfaces the reconciliation prompt.
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: "stale conflict on retry", field: null }),
          { status: 409, headers: { "Content-Type": "application/json" } },
        ),
      )
      // Second call: GET refresh kicked off by Keep editing returns
      // the refreshed canonical node alongside a drifted sensor pool.
      // The dialog must surface the new pool to the SemiSupervisedForm
      // so a future Hog serialise compares set-equality against the
      // *current* pool, not the snapshot the SSR page seeded with.
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            node: refreshedNode,
            appliedExternalDrafts: {},
            sensorOptions: refreshedPool,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    try {
      render(<Harness />);

      // Save → PATCH → 409 surfaces the prompt.
      fireEvent.click(screen.getByTestId("node-dialog-save"));
      await screen.findByTestId("node-dialog-stale-conflict");

      // Keep editing → GET refresh; the dialog state swaps in the
      // refreshed pool before the prompt is dismissed.
      fireEvent.click(screen.getByTestId("node-dialog-stale-keep"));
      await new Promise((resolve) => setTimeout(resolve, 0));
      // Wait for the prompt to clear (refresh completed).
      const prompt = screen.queryByTestId("node-dialog-stale-conflict");
      // Some test envs may need a tick; poll briefly.
      if (prompt) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      // Toggle on the SEMI_SUPERVISED membership so the accordion
      // expands, ConfigureHereBody renders, and the SemiSupervisedForm
      // stub records the live `sensorOptions` prop value. Without the
      // refresh-path wiring this would still read the original
      // single-id pool and the assertion below would fail.
      fireEvent.click(screen.getByTestId("node-dialog-semi-supervised-enable"));

      const form = await screen.findByTestId("semi-supervised-stub");
      expect(form.getAttribute("data-sensor-ids")).toBe("1,2,3");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
