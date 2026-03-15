import { beforeEach, describe, expect, it, vi } from "vitest";

const mockQuery = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db/client", () => ({
  query: mockQuery,
}));

vi.mock("server-only", () => ({}));

describe("lockout-policy", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    vi.resetModules();
  });

  it("returns defaults when DB has no row", async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    const { loadLockoutPolicy } = await import("@/lib/auth/lockout-policy");
    const policy = await loadLockoutPolicy();

    expect(policy).toEqual({
      stage1Threshold: 5,
      stage1DurationMinutes: 30,
    });
  });

  it("merges DB values over defaults", async () => {
    mockQuery.mockResolvedValue({
      rows: [
        {
          value: {
            stage1_threshold: 3,
            stage1_duration_minutes: 15,
          },
        },
      ],
      rowCount: 1,
    });

    const { loadLockoutPolicy } = await import("@/lib/auth/lockout-policy");
    const policy = await loadLockoutPolicy();

    expect(policy).toEqual({
      stage1Threshold: 3,
      stage1DurationMinutes: 15,
    });
  });

  it("cache hit skips DB query on second call", async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    const { loadLockoutPolicy } = await import("@/lib/auth/lockout-policy");
    await loadLockoutPolicy();
    await loadLockoutPolicy();

    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it("returns defaults when DB throws", async () => {
    mockQuery.mockRejectedValue(new Error("DB down"));

    const { loadLockoutPolicy } = await import("@/lib/auth/lockout-policy");
    const policy = await loadLockoutPolicy();

    expect(policy).toEqual({
      stage1Threshold: 5,
      stage1DurationMinutes: 30,
    });
  });

  it("invalidate forces re-query", async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    const { loadLockoutPolicy, invalidateLockoutPolicy } = await import(
      "@/lib/auth/lockout-policy"
    );
    await loadLockoutPolicy();
    invalidateLockoutPolicy();
    await loadLockoutPolicy();

    expect(mockQuery).toHaveBeenCalledTimes(2);
  });
});
