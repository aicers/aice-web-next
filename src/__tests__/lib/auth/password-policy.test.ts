import { beforeEach, describe, expect, it, vi } from "vitest";

const mockQuery = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db/client", () => ({
  query: mockQuery,
}));

vi.mock("server-only", () => ({}));

describe("password-policy", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    vi.resetModules();
  });

  it("returns defaults when DB has no row", async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    const { loadPasswordPolicy } = await import("@/lib/auth/password-policy");
    const policy = await loadPasswordPolicy();

    expect(policy).toEqual({
      minLength: 12,
      maxLength: 128,
      complexityEnabled: false,
      reuseBanCount: 5,
    });
  });

  it("merges DB values over defaults", async () => {
    mockQuery.mockResolvedValue({
      rows: [
        {
          value: {
            min_length: 16,
            max_length: 64,
            complexity_enabled: true,
            reuse_ban_count: 10,
          },
        },
      ],
      rowCount: 1,
    });

    const { loadPasswordPolicy } = await import("@/lib/auth/password-policy");
    const policy = await loadPasswordPolicy();

    expect(policy).toEqual({
      minLength: 16,
      maxLength: 64,
      complexityEnabled: true,
      reuseBanCount: 10,
    });
  });

  it("cache hit skips DB query on second call", async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    const { loadPasswordPolicy } = await import("@/lib/auth/password-policy");
    await loadPasswordPolicy();
    await loadPasswordPolicy();

    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it("returns defaults when DB throws", async () => {
    mockQuery.mockRejectedValue(new Error("DB down"));

    const { loadPasswordPolicy } = await import("@/lib/auth/password-policy");
    const policy = await loadPasswordPolicy();

    expect(policy).toEqual({
      minLength: 12,
      maxLength: 128,
      complexityEnabled: false,
      reuseBanCount: 5,
    });
  });
});
