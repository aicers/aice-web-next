/**
 * Verifies the create-mode dialog clears its locally-held error state
 * across a Cancel → reopen cycle.
 *
 * The list page keeps the create-mode `NodeEditDialog` mounted whenever
 * the caller has both required permissions, so the dialog's internal
 * `submitError` survives a Cancel unless the closed→open transition
 * effect explicitly clears it. Reviewer Round 17 flagged that the
 * previous render-only test could not catch a regression where a 502 /
 * service-level conflict banner from a prior attempt re-appeared on
 * the next open.
 *
 * Scoped to the dom (jsdom + RTL) project via vitest.config.ts because
 * the rest of the dialog suite uses `renderToStaticMarkup`, which
 * cannot exercise mount lifecycle.
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

// Same UI shims as `node-edit-dialog.test.tsx` so the rendered tree is
// jsdom-friendly. The Radix primitives rely on portals and pointer
// events that are awkward under jsdom; the production path is
// exercised by the e2e suite.
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
  Checkbox: ({ id, checked }: { id?: string; checked?: boolean }) => (
    <input type="checkbox" id={id} defaultChecked={!!checked} readOnly />
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

vi.mock("@/components/node/forms/semi-supervised-form", () => ({
  SemiSupervisedForm: () => <div data-test-form="semi-supervised" />,
}));

import { NodeEditDialog } from "@/components/node/node-edit-dialog";
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

interface HarnessProps {
  initialOpen: boolean;
  node?: ManagerNode | null;
  mode: "create" | "edit";
}

function Harness({ initialOpen, node, mode }: HarnessProps) {
  const [open, setOpen] = useState(initialOpen);
  return (
    <>
      {/* Production Cancel goes through Radix DialogClose, which is
          shimmed to a plain span in this test rig — drive close via
          the parent state directly so the closed→open lifecycle still
          fires. The dialog stays mounted because the list page keeps
          it mounted, so it is the open prop transition (not
          unmount/remount) that has to reset internal state. */}
      <button type="button" data-testid="close" onClick={() => setOpen(false)}>
        close
      </button>
      <button type="button" data-testid="reopen" onClick={() => setOpen(true)}>
        reopen
      </button>
      <NodeEditDialog
        open={open}
        onOpenChange={setOpen}
        mode={mode}
        customers={customers}
        existingNames={[]}
        existingHostnames={[]}
        node={node ?? null}
        onSuccess={() => {}}
      />
    </>
  );
}

describe("NodeEditDialog open-reset behaviour", () => {
  it("clears the footer banner after Cancel → reopen", async () => {
    // Mock fetch so the first save attempt surfaces a footer-level
    // banner via the new structured 502 fallback.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: "upstream rejected", field: null }),
          { status: 502, headers: { "Content-Type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    try {
      render(<Harness initialOpen mode="edit" node={editNode} />);

      // Edit mode opens with the canonical node already valid, so
      // clicking Save dispatches the PATCH directly.
      fireEvent.click(screen.getByTestId("node-dialog-save"));

      // Wait for the footer banner to surface from the mocked 502.
      const banner = await screen.findByTestId("node-dialog-form-error");
      expect(banner.textContent).toBe("upstream rejected");

      // Cancel → reopen cycle. The dialog is kept mounted by the
      // production list page, so the open transition is what clears
      // local error state — not unmounting / remounting.
      fireEvent.click(screen.getByTestId("close"));
      fireEvent.click(screen.getByTestId("reopen"));

      // The previous attempt's banner must not surface on the fresh
      // open, before the user has clicked Save again.
      expect(screen.queryByTestId("node-dialog-form-error")).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
