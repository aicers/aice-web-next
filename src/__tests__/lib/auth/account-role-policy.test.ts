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
