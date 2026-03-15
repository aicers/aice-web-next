import { beforeEach, describe, expect, it, vi } from "vitest";

const mockQuery = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db/client", () => ({
  query: mockQuery,
}));

vi.mock("server-only", () => ({}));

describe("mfa-policy", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    vi.resetModules();
  });

  it("returns defaults when DB has no row", async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    const { loadMfaPolicy } = await import("@/lib/auth/mfa-policy");
    const policy = await loadMfaPolicy();

    expect(policy).toEqual({
      allowedMethods: ["webauthn", "totp"],
    });
  });

  it("reads configured methods from DB", async () => {
    mockQuery.mockResolvedValue({
      rows: [
        {
          value: { allowed_methods: ["totp"] },
        },
      ],
      rowCount: 1,
    });

    const { loadMfaPolicy } = await import("@/lib/auth/mfa-policy");
    const policy = await loadMfaPolicy();

    expect(policy.allowedMethods).toEqual(["totp"]);
  });

  it("filters out invalid MFA methods", async () => {
    mockQuery.mockResolvedValue({
      rows: [
        {
          value: { allowed_methods: ["totp", "sms", "webauthn", "email"] },
        },
      ],
      rowCount: 1,
    });

    const { loadMfaPolicy } = await import("@/lib/auth/mfa-policy");
    const policy = await loadMfaPolicy();

    expect(policy.allowedMethods).toEqual(["totp", "webauthn"]);
  });

  it("cache hit skips DB query on second call", async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    const { loadMfaPolicy } = await import("@/lib/auth/mfa-policy");
    await loadMfaPolicy();
    await loadMfaPolicy();

    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it("returns defaults when DB throws", async () => {
    mockQuery.mockRejectedValue(new Error("DB down"));

    const { loadMfaPolicy } = await import("@/lib/auth/mfa-policy");
    const policy = await loadMfaPolicy();

    expect(policy.allowedMethods).toEqual(["webauthn", "totp"]);
  });
});
