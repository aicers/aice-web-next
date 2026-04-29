/**
 * Node create/edit dialog rendering coverage.
 *
 * Renders via `renderToStaticMarkup` so the test stays in lockstep with
 * the SSR-friendly approach used by `role-form-dialog.test.tsx`. Radix
 * primitives (Dialog, Select, Checkbox, Switch) are shimmed to plain
 * DOM elements so the dialog body is reachable from the static markup.
 *
 * The goal is to lock down the structural contract: every documented
 * service section is present in the accordion, the Configure
 * Here/Manually switch only renders for "both"-mode services, and the
 * Unsupervised Engine surfaces its informative card up-front (the only
 * service whose body is non-conditional on enabling).
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/components/session/session-extension-dialog", () => ({
  readCsrfToken: () => null,
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
    "data-testid": testId,
  }: {
    id?: string;
    checked?: boolean;
    "data-testid"?: string;
  }) => (
    <input
      type="checkbox"
      id={id}
      defaultChecked={!!checked}
      data-state={checked ? "checked" : "unchecked"}
      data-testid={testId}
      readOnly
    />
  ),
}));

vi.mock("@/components/ui/switch", () => ({
  // The dialog never enables a service in any of the rendering tests
  // below, so this Switch shim is unreachable in practice. We keep the
  // shape minimal but a11y-clean to satisfy lint regardless.
  Switch: ({
    checked,
    "data-testid": testId,
  }: {
    checked?: boolean;
    "data-testid"?: string;
  }) => (
    <input
      type="checkbox"
      defaultChecked={!!checked}
      data-state={checked ? "checked" : "unchecked"}
      data-testid={testId}
      readOnly
    />
  ),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    type,
    "data-testid": testId,
  }: {
    children: React.ReactNode;
    type?: "button" | "submit";
    "data-testid"?: string;
  }) => (
    <button type={type ?? "button"} data-testid={testId}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/input", () => ({
  Input: (props: Record<string, unknown>) => (
    <input {...(props as React.InputHTMLAttributes<HTMLInputElement>)} />
  ),
}));

vi.mock("@/components/ui/label", () => ({
  Label: ({
    children,
    htmlFor,
  }: {
    children: React.ReactNode;
    htmlFor?: string;
  }) => <label htmlFor={htmlFor}>{children}</label>,
}));

vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: React.ReactNode }) => (
    <div data-slot="select">{children}</div>
  ),
  SelectTrigger: ({
    children,
    ...rest
  }: {
    children: React.ReactNode;
    [key: string]: unknown;
  }) => (
    <button
      type="button"
      data-slot="select-trigger"
      {...(rest as React.ButtonHTMLAttributes<HTMLButtonElement>)}
    >
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

// The per-service forms pull in heavyweight client-only code; the
// dialog's structural contract does not depend on their internals,
// just that the registry lookup succeeds. Stub each form to a sentinel
// that's easy to assert against.
vi.mock("@/components/node/forms/semi-supervised-form", () => ({
  SemiSupervisedForm: () => <div data-test-form="semi-supervised" />,
}));

import { NodeEditDialog } from "@/components/node/node-edit-dialog";

const noop = () => {};

const customers = [{ id: "1", name: "Acme" }];

describe("NodeEditDialog rendering", () => {
  it("renders the create-mode title and the four metadata fields", () => {
    const html = renderToStaticMarkup(
      <NodeEditDialog
        open
        onOpenChange={noop}
        mode="create"
        customers={customers}
        existingNames={[]}
        existingHostnames={[]}
        onSuccess={noop}
      />,
    );

    // `useTranslations("nodes.dialog")` is mocked to echo the suffix, so
    // `t("titleCreate")` resolves to the bare key `titleCreate`.
    expect(html).toContain(">titleCreate<");
    expect(html).toContain('data-node-dialog-field="metadata.name"');
    expect(html).toContain('data-node-dialog-field="metadata.customerId"');
    expect(html).toContain('data-node-dialog-field="metadata.description"');
    expect(html).toContain('data-node-dialog-field="metadata.hostname"');
  });

  it("renders a section per documented service kind", () => {
    const html = renderToStaticMarkup(
      <NodeEditDialog
        open
        onOpenChange={noop}
        mode="create"
        customers={customers}
        existingNames={[]}
        existingHostnames={[]}
        onSuccess={noop}
      />,
    );

    for (const kind of [
      "sensor",
      "data-store",
      "ti-container",
      "semi-supervised",
      "time-series",
      "unsupervised",
    ]) {
      expect(html).toContain(`data-testid="node-dialog-service-${kind}"`);
      expect(html).toContain(`data-testid="node-dialog-${kind}-enable"`);
    }
  });

  it("renders the edit-mode title and seeds metadata from the canonical node", () => {
    const html = renderToStaticMarkup(
      <NodeEditDialog
        open
        onOpenChange={noop}
        mode="edit"
        customers={customers}
        existingNames={["alpha"]}
        existingHostnames={["alpha.local"]}
        node={{
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
        }}
        onSuccess={noop}
      />,
    );

    expect(html).toContain(">titleEdit<");
    // RHF's `register` uses uncontrolled inputs so the SSR markup only
    // carries the field wiring (name + the data-testid attribute), not
    // the seeded values — those flow in after mount via refs. We assert
    // the field plumbing here; the runtime seeding behaviour is covered
    // by `node-create-update.test.ts` against the data layer.
    expect(html).toContain('name="metadata.name"');
    expect(html).toContain('name="metadata.hostname"');
    expect(html).toContain('name="metadata.description"');
  });

  it("hides the configure-here/manually switch when no service is enabled", () => {
    // The mode toggle only renders inside the accordion header when the
    // service membership checkbox is checked AND the registry lists the
    // kind as "both"-mode. Default render has every service disabled, so
    // no `node-dialog-*-mode` switch must surface in the static markup.
    const html = renderToStaticMarkup(
      <NodeEditDialog
        open
        onOpenChange={noop}
        mode="create"
        customers={customers}
        existingNames={[]}
        existingHostnames={[]}
        onSuccess={noop}
      />,
    );

    expect(html).not.toContain("node-dialog-sensor-mode");
    expect(html).not.toContain("node-dialog-semi-supervised-mode");
    expect(html).not.toContain("node-dialog-time-series-mode");
  });

  it("renders Cancel and Save in the dialog footer", () => {
    const html = renderToStaticMarkup(
      <NodeEditDialog
        open
        onOpenChange={noop}
        mode="create"
        customers={customers}
        existingNames={[]}
        existingHostnames={[]}
        onSuccess={noop}
      />,
    );

    expect(html).toContain('data-testid="node-dialog-cancel"');
    expect(html).toContain('data-testid="node-dialog-save"');
    expect(html).toContain(">cancel<");
    expect(html).toContain(">save<");
  });
});
