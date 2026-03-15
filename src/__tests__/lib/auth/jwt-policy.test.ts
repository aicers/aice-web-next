import { beforeEach, describe, expect, it, vi } from "vitest";

const mockQuery = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db/client", () => ({
  query: mockQuery,
}));

vi.mock("server-only", () => ({}));

describe("jwt-policy", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    vi.resetModules();
  });

  it("returns defaults when DB has no row", async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    const { loadJwtPolicy } = await import("@/lib/auth/jwt-policy");
    const policy = await loadJwtPolicy();

    expect(policy).toEqual({
      accessTokenExpirationMinutes: 15,
    });
  });

  it("reads configured expiration from DB", async () => {
    mockQuery.mockResolvedValue({
      rows: [
        {
          value: { access_token_expiration_minutes: 30 },
        },
      ],
      rowCount: 1,
    });

    const { loadJwtPolicy } = await import("@/lib/auth/jwt-policy");
    const policy = await loadJwtPolicy();

    expect(policy.accessTokenExpirationMinutes).toBe(30);
  });

  it("cache hit skips DB query on second call", async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    const { loadJwtPolicy } = await import("@/lib/auth/jwt-policy");
    await loadJwtPolicy();
    await loadJwtPolicy();

    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it("returns defaults when DB throws", async () => {
    mockQuery.mockRejectedValue(new Error("DB down"));

    const { loadJwtPolicy } = await import("@/lib/auth/jwt-policy");
    const policy = await loadJwtPolicy();

    expect(policy.accessTokenExpirationMinutes).toBe(15);
  });

  it("invalidate forces re-query", async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    const { loadJwtPolicy, invalidateJwtPolicy } = await import(
      "@/lib/auth/jwt-policy"
    );
    await loadJwtPolicy();
    invalidateJwtPolicy();
    await loadJwtPolicy();

    expect(mockQuery).toHaveBeenCalledTimes(2);
  });
});
