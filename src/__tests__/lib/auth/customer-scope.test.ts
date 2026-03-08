import { beforeEach, describe, expect, it, vi } from "vitest";

const mockQuery = vi.hoisted(() => vi.fn());
const mockHasPermission = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db/client", () => ({
  query: vi.fn((...args: unknown[]) => mockQuery(...args)),
}));

vi.mock("@/lib/auth/permissions", () => ({
  hasPermission: mockHasPermission,
}));

describe("getAccountCustomerIds", () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it("returns assigned customer IDs in order", async () => {
    mockQuery.mockResolvedValue({
      rows: [{ customer_id: 2 }, { customer_id: 5 }, { customer_id: 10 }],
    });

    const { getAccountCustomerIds } = await import("@/lib/auth/customer-scope");
    const result = await getAccountCustomerIds("account-1");

    expect(result).toEqual([2, 5, 10]);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("account_customer"),
      ["account-1"],
    );
  });

  it("returns empty array for unassigned account", async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    const { getAccountCustomerIds } = await import("@/lib/auth/customer-scope");
    const result = await getAccountCustomerIds("account-2");

    expect(result).toEqual([]);
  });
});

describe("resolveEffectiveCustomerIds", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockHasPermission.mockReset();
  });

  it("returns undefined when account has customers:access-all", async () => {
    mockHasPermission.mockResolvedValue(true);

    const { resolveEffectiveCustomerIds } = await import(
      "@/lib/auth/customer-scope"
    );
    const result = await resolveEffectiveCustomerIds("account-1", [
      "System Administrator",
    ]);

    expect(result).toBeUndefined();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("returns customer IDs when account lacks customers:access-all", async () => {
    mockHasPermission.mockResolvedValue(false);
    mockQuery.mockResolvedValue({
      rows: [{ customer_id: 3 }, { customer_id: 7 }],
    });

    const { resolveEffectiveCustomerIds } = await import(
      "@/lib/auth/customer-scope"
    );
    const result = await resolveEffectiveCustomerIds("account-1", [
      "Tenant Administrator",
    ]);

    expect(result).toEqual([3, 7]);
  });
});
