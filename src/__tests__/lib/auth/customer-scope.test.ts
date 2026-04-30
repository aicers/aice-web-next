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

describe("getEffectiveCustomerScope", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockHasPermission.mockReset();
  });

  it("returns admin scope with every customer name when access-all is granted", async () => {
    mockHasPermission.mockResolvedValue(true);
    // First call: getAllCustomerIds (id list)
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 1 }, { id: 2 }, { id: 3 }],
    });
    // Second call: name JOIN
    mockQuery.mockResolvedValueOnce({
      rows: [
        { id: 1, name: "ACME" },
        { id: 2, name: "Beta" },
        { id: 3, name: "Gamma" },
      ],
    });

    const { getEffectiveCustomerScope } = await import(
      "@/lib/auth/customer-scope"
    );
    const result = await getEffectiveCustomerScope({
      accountId: "account-1",
      roles: ["System Administrator"],
    });

    expect(result.kind).toBe("admin");
    expect(result.customers).toEqual([
      { id: 1, name: "ACME" },
      { id: 2, name: "Beta" },
      { id: 3, name: "Gamma" },
    ]);
  });

  it("returns assigned scope with names when account has account_customer rows", async () => {
    mockHasPermission.mockResolvedValue(false);
    // First call: getAccountCustomerIds
    mockQuery.mockResolvedValueOnce({
      rows: [{ customer_id: 3 }, { customer_id: 7 }],
    });
    // Second call: name JOIN
    mockQuery.mockResolvedValueOnce({
      rows: [
        { id: 3, name: "ACME" },
        { id: 7, name: "Beta" },
      ],
    });

    const { getEffectiveCustomerScope } = await import(
      "@/lib/auth/customer-scope"
    );
    const result = await getEffectiveCustomerScope({
      accountId: "account-1",
      roles: ["Tenant Administrator"],
    });

    expect(result.kind).toBe("assigned");
    expect(result.customers).toEqual([
      { id: 3, name: "ACME" },
      { id: 7, name: "Beta" },
    ]);
  });

  it("flags assigned-to-everything (without admin) as kind: 'assigned'", async () => {
    // A non-admin who happens to be assigned to every customer is
    // *still* kind: 'assigned' — the indicator's admin badge surfaces
    // the source of the scope, not its size.
    mockHasPermission.mockResolvedValue(false);
    mockQuery.mockResolvedValueOnce({
      rows: [{ customer_id: 1 }, { customer_id: 2 }, { customer_id: 3 }],
    });
    mockQuery.mockResolvedValueOnce({
      rows: [
        { id: 1, name: "ACME" },
        { id: 2, name: "Beta" },
        { id: 3, name: "Gamma" },
      ],
    });

    const { getEffectiveCustomerScope } = await import(
      "@/lib/auth/customer-scope"
    );
    const result = await getEffectiveCustomerScope({
      accountId: "account-1",
      roles: ["Tenant Administrator"],
    });

    expect(result.kind).toBe("assigned");
    expect(result.customers).toHaveLength(3);
  });

  it("returns admin scope even when no customers are registered", async () => {
    // Admin source is preserved regardless of whether any customers
    // exist yet — the indicator still differentiates admin from
    // empty assignment.
    mockHasPermission.mockResolvedValue(true);
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const { getEffectiveCustomerScope } = await import(
      "@/lib/auth/customer-scope"
    );
    const result = await getEffectiveCustomerScope({
      accountId: "account-1",
      roles: ["System Administrator"],
    });

    expect(result.kind).toBe("admin");
    expect(result.customers).toEqual([]);
  });

  it("returns empty scope when no rows and not admin", async () => {
    mockHasPermission.mockResolvedValue(false);
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const { getEffectiveCustomerScope } = await import(
      "@/lib/auth/customer-scope"
    );
    const result = await getEffectiveCustomerScope({
      accountId: "account-1",
      roles: ["Operator"],
    });

    expect(result.kind).toBe("empty");
    expect(result.customers).toEqual([]);
  });
});
