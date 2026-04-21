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

describe("getAllCustomerIds", () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it("returns every registered customer ID in ascending order", async () => {
    mockQuery.mockResolvedValue({
      rows: [{ id: 1 }, { id: 4 }, { id: 9 }],
    });

    const { getAllCustomerIds } = await import("@/lib/auth/customer-scope");
    const result = await getAllCustomerIds();

    expect(result).toEqual([1, 4, 9]);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringMatching(/SELECT id FROM customers ORDER BY id/i),
    );
  });

  it("returns an empty array when no customers are registered", async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    const { getAllCustomerIds } = await import("@/lib/auth/customer-scope");
    const result = await getAllCustomerIds();

    expect(result).toEqual([]);
  });
});

describe("resolveEffectiveCustomerIds", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockHasPermission.mockReset();
  });

  it("materializes every registered customer ID when account has customers:access-all", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockQuery.mockResolvedValue({
      rows: [{ id: 1 }, { id: 2 }, { id: 3 }],
    });

    const { resolveEffectiveCustomerIds } = await import(
      "@/lib/auth/customer-scope"
    );
    const result = await resolveEffectiveCustomerIds("account-1", [
      "System Administrator",
    ]);

    // Access-all is resolved to the explicit list of every customer —
    // the consumer (REview) applies scope from an explicit claim set,
    // not from an omitted claim.
    expect(result).toEqual([1, 2, 3]);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringMatching(/SELECT id FROM customers ORDER BY id/i),
    );
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
