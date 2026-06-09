import { describe, expect, it } from "vitest";

import {
  deriveAccountRolePolicy,
  summarizeAccountRolePolicy,
} from "@/lib/auth/account-role-policy";

describe("account-role-policy", () => {
  it("treats global-access roles as not requiring customer assignment", () => {
    const policy = deriveAccountRolePolicy({
      id: 1,
      name: "Custom Global Admin",
      permissions: ["accounts:read", "customers:access-all"],
    });

    expect(policy.requiresCustomerAssignment).toBe(false);
    expect(policy.maxCustomerAssignments).toBeNull();
    expect(policy.tenantManageable).toBe(false);
  });

  it("treats zero-permission roles as Security Monitor-equivalent", () => {
    const policy = deriveAccountRolePolicy({
      id: 2,
      name: "Custom Monitor",
      permissions: [],
    });

    expect(policy.isSecurityMonitorEquivalent).toBe(true);
    expect(policy.requiresCustomerAssignment).toBe(true);
    expect(policy.maxCustomerAssignments).toBe(1);
    expect(policy.tenantManageable).toBe(true);
  });

  it("treats read-only data permissions as Security Monitor-equivalent", () => {
    const policy = deriveAccountRolePolicy({
      id: 5,
      name: "Security Monitor",
      permissions: ["detection:read"],
    });

    expect(policy.isSecurityMonitorEquivalent).toBe(true);
    expect(policy.requiresCustomerAssignment).toBe(true);
    expect(policy.maxCustomerAssignments).toBe(1);
    expect(policy.tenantManageable).toBe(true);
  });

  it("treats the full Security Monitor read-only permission set as equivalent", () => {
    const policy = deriveAccountRolePolicy({
      id: 6,
      name: "Security Monitor Clone",
      permissions: ["audit-logs:read", "dashboard:read", "detection:read"],
    });

    expect(policy.isSecurityMonitorEquivalent).toBe(true);
    expect(policy.tenantManageable).toBe(true);
    expect(policy.maxCustomerAssignments).toBe(1);
  });

  it("treats the built-in Security Monitor permission set after #307 as equivalent", () => {
    // The built-in Security Monitor role gains `nodes:read` and
    // `services:read` from migration 0022 (#307). Without these in the
    // allow-list, Security Monitor accounts would silently lose
    // `tenantManageable: true` after the migration runs and Tenant
    // Administrators could no longer create or manage them.
    const policy = deriveAccountRolePolicy({
      id: 9,
      name: "Security Monitor",
      permissions: [
        "audit-logs:read",
        "dashboard:read",
        "detection:read",
        "nodes:read",
        "services:read",
      ],
    });

    expect(policy.isSecurityMonitorEquivalent).toBe(true);
    expect(policy.tenantManageable).toBe(true);
    expect(policy.maxCustomerAssignments).toBe(1);
  });

  it("treats triage:read as Security Monitor-equivalent", () => {
    // Migration 0030 (#454) seeds `triage:read` onto Security Monitor.
    // Without this in the allow-list, Security Monitor accounts would
    // silently lose `tenantManageable: true` after the migration runs
    // and Tenant Administrators could no longer create or manage them.
    const policy = deriveAccountRolePolicy({
      id: 12,
      name: "Security Monitor",
      permissions: [
        "audit-logs:read",
        "dashboard:read",
        "detection:read",
        "nodes:read",
        "services:read",
        "triage:read",
      ],
    });

    expect(policy.isSecurityMonitorEquivalent).toBe(true);
    expect(policy.tenantManageable).toBe(true);
    expect(policy.maxCustomerAssignments).toBe(1);
  });

  it("treats event:read as Security Monitor-equivalent", () => {
    // Migration 0035 (#724) seeds `event:read` onto Security Monitor.
    // Without this in the allow-list, Security Monitor accounts would
    // silently lose `tenantManageable: true` after the migration runs
    // and Tenant Administrators could no longer create or manage them.
    const policy = deriveAccountRolePolicy({
      id: 14,
      name: "Security Monitor",
      permissions: [
        "audit-logs:read",
        "dashboard:read",
        "detection:read",
        "event:read",
        "nodes:read",
        "services:read",
        "triage:read",
      ],
    });

    expect(policy.isSecurityMonitorEquivalent).toBe(true);
    expect(policy.tenantManageable).toBe(true);
    expect(policy.maxCustomerAssignments).toBe(1);
  });

  it("does not treat triage:policy:write as Security Monitor-equivalent", () => {
    // The three `triage:*:write` permissions are placeholders in
    // Phase 1.A but are intentionally NOT in the allow-list — granting
    // any of them must disqualify the role from monitor equivalence.
    const policy = deriveAccountRolePolicy({
      id: 13,
      name: "Custom Triage Editor",
      permissions: ["triage:read", "triage:policy:write"],
    });

    expect(policy.isSecurityMonitorEquivalent).toBe(false);
    expect(policy.tenantManageable).toBe(false);
  });

  it("does not treat nodes:write as Security Monitor-equivalent", () => {
    const policy = deriveAccountRolePolicy({
      id: 10,
      name: "Custom Node Operator",
      permissions: ["nodes:read", "nodes:write"],
    });

    expect(policy.isSecurityMonitorEquivalent).toBe(false);
    expect(policy.tenantManageable).toBe(false);
  });

  it("does not treat services:write as Security Monitor-equivalent", () => {
    const policy = deriveAccountRolePolicy({
      id: 11,
      name: "Custom Service Editor",
      permissions: ["services:read", "services:write"],
    });

    expect(policy.isSecurityMonitorEquivalent).toBe(false);
    expect(policy.tenantManageable).toBe(false);
  });

  it("does not treat dashboard:write as Security Monitor-equivalent", () => {
    // dashboard:write is not read-only — it gates session revocation
    // (src/app/api/dashboard/sessions/[sid]/revoke/route.ts). A custom
    // role that holds it must not be tenant-manageable as a Security
    // Monitor clone.
    const policy = deriveAccountRolePolicy({
      id: 7,
      name: "Dashboard Operator",
      permissions: ["dashboard:read", "dashboard:write"],
    });

    expect(policy.isSecurityMonitorEquivalent).toBe(false);
    expect(policy.tenantManageable).toBe(false);
    expect(policy.maxCustomerAssignments).toBeNull();
  });

  it("does not treat system-settings:read as Security Monitor-equivalent", () => {
    const policy = deriveAccountRolePolicy({
      id: 8,
      name: "Settings Viewer",
      permissions: ["system-settings:read"],
    });

    expect(policy.isSecurityMonitorEquivalent).toBe(false);
    expect(policy.tenantManageable).toBe(false);
  });

  it("treats customer-scoped roles with permissions as non-monitor accounts", () => {
    const policy = deriveAccountRolePolicy({
      id: 3,
      name: "Custom Tenant Operator",
      permissions: ["accounts:read", "customers:read"],
    });

    expect(policy.isSecurityMonitorEquivalent).toBe(false);
    expect(policy.requiresCustomerAssignment).toBe(true);
    expect(policy.maxCustomerAssignments).toBeNull();
    expect(policy.tenantManageable).toBe(false);
  });

  it("summarizes the policy for API consumers", () => {
    const summary = summarizeAccountRolePolicy({
      requiresCustomerAssignment: true,
      maxCustomerAssignments: 1,
      tenantManageable: true,
    });

    expect(summary).toEqual({
      requires_customer_assignment: true,
      max_customer_assignments: 1,
      tenant_manageable: true,
    });
  });
});
