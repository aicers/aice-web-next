/**
 * Role-form dialog rendering regression (#307).
 *
 * The dialog iterates `ALL_PERMISSIONS` to render one section per
 * permission group. When the nodes/services groups land in
 * `permission-defs.ts`, the dialog must surface them automatically —
 * without this regression, a role admin cannot grant `nodes:*` /
 * `services:*` to custom roles via the UI.
 *
 * The test renders the dialog via `renderToStaticMarkup`, swapping the
 * Radix portals (Dialog, Checkbox, Button, Input, Label) for plain DOM
 * elements so the form body is reachable from SSR. `useTranslations` is
 * stubbed to echo translation keys so we can assert on stable strings.
 *
 * Reviewer Round 1 (#354): the previous "pre-checks" case relied on
 * `useEffect` to seed `selectedPermissions` from the edited role, but
 * SSR never flushes effects so the assertion was a no-op. The dialog
 * now seeds initial state via `useState` initializers, which DO run
 * during SSR, and the live-checkbox + submit-payload contracts are
 * locked down by the hook-level tests in `role-form-dialog-hook.test.ts`.
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
  }: {
    id?: string;
    checked?: boolean;
    onCheckedChange?: () => void;
  }) => (
    <input
      type="checkbox"
      id={id}
      defaultChecked={!!checked}
      data-state={checked ? "checked" : "unchecked"}
      readOnly
    />
  ),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    type,
  }: {
    children: React.ReactNode;
    type?: "button" | "submit";
    [key: string]: unknown;
  }) => <button type={type ?? "button"}>{children}</button>,
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

import { RoleFormDialog } from "@/components/roles/role-form-dialog";

const noop = () => {};

describe("RoleFormDialog rendering", () => {
  it("renders every permission group in ALL_PERMISSIONS, including nodes and services", () => {
    const html = renderToStaticMarkup(
      <RoleFormDialog open onOpenChange={noop} onSuccess={noop} />,
    );

    // Each group renders a heading derived from the key; with translations
    // stubbed to echo, the heading text is the namespaced key.
    expect(html).toContain("permissionGroups.accounts");
    expect(html).toContain("permissionGroups.roles");
    expect(html).toContain("permissionGroups.customers");
    expect(html).toContain("permissionGroups.audit-logs");
    expect(html).toContain("permissionGroups.dashboard");
    expect(html).toContain("permissionGroups.detection");
    expect(html).toContain("permissionGroups.nodes");
    expect(html).toContain("permissionGroups.services");
    expect(html).toContain("permissionGroups.system-settings");
  });

  it("renders a checkbox for each new node/service permission with the canonical id", () => {
    const html = renderToStaticMarkup(
      <RoleFormDialog open onOpenChange={noop} onSuccess={noop} />,
    );

    for (const perm of [
      "nodes:read",
      "nodes:write",
      "nodes:delete",
      "services:read",
      "services:write",
    ]) {
      expect(html).toContain(`id="perm-${perm}"`);
    }
  });

  it("seeds initial selected permissions from the edited role on the very first render", () => {
    const role = {
      id: 99,
      name: "Custom Node Operator",
      description: null,
      permissions: ["nodes:read", "services:write"],
    };

    const html = renderToStaticMarkup(
      <RoleFormDialog open role={role} onOpenChange={noop} onSuccess={noop} />,
    );

    // The dialog now seeds `selectedPermissions` via `useState`'s
    // initializer (not a post-mount effect), so the SSR pass already
    // commits with the role's permissions checked. A regression that
    // moved the seed back into `useEffect` would flip these to
    // `data-state="unchecked"` and fail here.
    expect(html).toMatch(/id="perm-nodes:read"[^>]*data-state="checked"/);
    expect(html).toMatch(/id="perm-services:write"[^>]*data-state="checked"/);
    // The unselected new permissions stay unchecked.
    expect(html).toMatch(/id="perm-nodes:write"[^>]*data-state="unchecked"/);
    expect(html).toMatch(/id="perm-nodes:delete"[^>]*data-state="unchecked"/);
    expect(html).toMatch(/id="perm-services:read"[^>]*data-state="unchecked"/);
  });
});
