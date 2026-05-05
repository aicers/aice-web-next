import { describe, expect, it } from "vitest";

import { isSystemAdministrator } from "@/lib/aimer/role-guard";
import { SYSTEM_ADMIN_ROLE_NAME } from "@/lib/auth/account-role-policy";

describe("isSystemAdministrator", () => {
  it("returns true when the named role is present", () => {
    expect(isSystemAdministrator([SYSTEM_ADMIN_ROLE_NAME])).toBe(true);
  });

  it("returns true even alongside other roles", () => {
    expect(
      isSystemAdministrator([SYSTEM_ADMIN_ROLE_NAME, "Tenant Administrator"]),
    ).toBe(true);
  });

  it("returns false for Tenant Administrator (no role name match)", () => {
    expect(isSystemAdministrator(["Tenant Administrator"])).toBe(false);
  });

  it("returns false for Security Monitor", () => {
    expect(isSystemAdministrator(["Security Monitor"])).toBe(false);
  });

  it("returns false for an empty role list", () => {
    expect(isSystemAdministrator([])).toBe(false);
  });

  it("returns false for an undefined role list", () => {
    expect(isSystemAdministrator(undefined)).toBe(false);
  });

  it("does not match a custom role name even with admin-like permissions", () => {
    // The check is role-name based per #437 §Authorization. A future
    // custom role with broad permissions like `system-settings:*` must
    // NOT pass.
    expect(isSystemAdministrator(["SuperOps", "AlmostAdmin"])).toBe(false);
  });
});
