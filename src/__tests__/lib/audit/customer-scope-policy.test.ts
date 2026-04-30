import { describe, expect, it } from "vitest";

import {
  AUDIT_ACTION_CUSTOMER_SCOPE,
  customerScopeForAction,
  listAllAuditActions,
} from "@/lib/audit/customer-scope-policy";
import type { AuditAction } from "@/lib/audit/schema";

/**
 * Guard for #387 P1 finding §3 (audit-log `customer_id` mapping).
 *
 * The audit-log viewer (#386) scopes rows by
 * `audit_logs.customer_id IN (caller's effective customer scope)`. A
 * customer-scoped action emitted with `customer_id = NULL` is invisible
 * to the tenant operator who actually owns the customer. To prevent a
 * future PR from silently introducing a customer-scoped action without
 * a `customerId` mapping, every `AuditAction` MUST be classified in
 * `AUDIT_ACTION_CUSTOMER_SCOPE` as either `customer-scoped` or
 * `customer-agnostic`. CI fails here if the schema and the policy drift.
 */
describe("AUDIT_ACTION_CUSTOMER_SCOPE — exhaustive coverage", () => {
  it("classifies every AuditAction declared in the schema", () => {
    const missing: AuditAction[] = [];
    for (const action of listAllAuditActions()) {
      if (AUDIT_ACTION_CUSTOMER_SCOPE[action] === undefined) {
        missing.push(action);
      }
    }
    expect(missing).toEqual([]);
  });

  it("does not register any action that is not in the schema", () => {
    const known = new Set<AuditAction>(listAllAuditActions());
    const stale: string[] = [];
    for (const action of Object.keys(AUDIT_ACTION_CUSTOMER_SCOPE)) {
      if (!known.has(action as AuditAction)) {
        stale.push(action);
      }
    }
    expect(stale).toEqual([]);
  });

  it("uses only the two recognised classification values", () => {
    const bad: { action: string; value: string }[] = [];
    for (const [action, value] of Object.entries(AUDIT_ACTION_CUSTOMER_SCOPE)) {
      if (value !== "customer-scoped" && value !== "customer-agnostic") {
        bad.push({ action, value });
      }
    }
    expect(bad).toEqual([]);
  });

  it("flags the customer.* and node.* / service.* actions as customer-scoped", () => {
    const expectedScoped: AuditAction[] = [
      "customer.create",
      "customer.update",
      "customer.delete",
      "customer.assign",
      "customer.unassign",
      "node.create",
      "node.update",
      "node.delete",
      "node.restart",
      "node.shutdown",
      "node.apply",
      "service.draft_save",
      "service.set_mode",
    ];
    for (const action of expectedScoped) {
      expect(customerScopeForAction(action)).toBe("customer-scoped");
    }
  });

  it("flags every non-customer / non-node / non-service action as customer-agnostic", () => {
    const scopedPrefixes = ["customer.", "node.", "service."];
    for (const action of listAllAuditActions()) {
      const isCustomerScopedPrefix = scopedPrefixes.some((p) =>
        action.startsWith(p),
      );
      if (!isCustomerScopedPrefix) {
        expect(customerScopeForAction(action)).toBe("customer-agnostic");
      }
    }
  });
});

describe("customerScopeForAction — runtime guard", () => {
  it("throws TypeError for an unregistered action string", () => {
    expect(() =>
      // Cast through unknown so the test exercises the runtime path.
      customerScopeForAction("not.a.real.action" as unknown as AuditAction),
    ).toThrow(TypeError);
  });
});
