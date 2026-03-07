import { beforeEach, describe, expect, it, vi } from "vitest";

const mockQuery = vi.hoisted(() => vi.fn());
const mockLoadPasswordPolicy = vi.hoisted(() => vi.fn());
const mockIsBlocklisted = vi.hoisted(() => vi.fn());
const mockVerifyPassword = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db/client", () => ({
  query: mockQuery,
}));

vi.mock("@/lib/auth/password-policy", () => ({
  loadPasswordPolicy: mockLoadPasswordPolicy,
}));

vi.mock("@/lib/auth/password-blocklist", () => ({
  isBlocklisted: mockIsBlocklisted,
}));

vi.mock("@/lib/auth/password", () => ({
  verifyPassword: mockVerifyPassword,
}));

vi.mock("server-only", () => ({}));

describe("password-validator", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockLoadPasswordPolicy.mockReset();
    mockIsBlocklisted.mockReset().mockReturnValue(false);
    mockVerifyPassword.mockReset().mockResolvedValue(false);

    // Default policy
    mockLoadPasswordPolicy.mockResolvedValue({
      minLength: 12,
      maxLength: 128,
      complexityEnabled: false,
      reuseBanCount: 5,
    });

    // Default: no password history
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it("rejects password shorter than minimum length", async () => {
    const { validatePassword } = await import("@/lib/auth/password-validator");
    const result = await validatePassword("short", "account-1");

    expect(result.valid).toBe(false);
    expect(result.errors).toContain("TOO_SHORT");
  });

  it("rejects password longer than maximum length", async () => {
    const { validatePassword } = await import("@/lib/auth/password-validator");
    const longPassword = "a".repeat(200);
    const result = await validatePassword(longPassword, "account-1");

    expect(result.valid).toBe(false);
    expect(result.errors).toContain("TOO_LONG");
  });

  it("rejects blocklisted password", async () => {
    mockIsBlocklisted.mockReturnValue(true);

    const { validatePassword } = await import("@/lib/auth/password-validator");
    const result = await validatePassword("a".repeat(12), "account-1");

    expect(result.valid).toBe(false);
    expect(result.errors).toContain("BLOCKLISTED");
  });

  it("rejects recently used password", async () => {
    mockQuery.mockResolvedValue({
      rows: [{ password_hash: "$argon2id$hash1" }],
      rowCount: 1,
    });
    mockVerifyPassword.mockResolvedValue(true);

    const { validatePassword } = await import("@/lib/auth/password-validator");
    const result = await validatePassword("ValidPassword123!", "account-1");

    expect(result.valid).toBe(false);
    expect(result.errors).toContain("RECENTLY_USED");
  });

  it("checks complexity when enabled", async () => {
    mockLoadPasswordPolicy.mockResolvedValue({
      minLength: 8,
      maxLength: 128,
      complexityEnabled: true,
      reuseBanCount: 0,
    });

    const { validatePassword } = await import("@/lib/auth/password-validator");

    // Missing uppercase, digit, special
    const result = await validatePassword("alllowercase", "account-1");
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("MISSING_UPPERCASE");
    expect(result.errors).toContain("MISSING_DIGIT");
    expect(result.errors).toContain("MISSING_SPECIAL");
    expect(result.errors).not.toContain("MISSING_LOWERCASE");
  });

  it("accepts a valid password", async () => {
    const { validatePassword } = await import("@/lib/auth/password-validator");
    const result = await validatePassword("ValidPassword123!", "account-1");

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("skips reuse check when skipReuse is true", async () => {
    const { validatePassword } = await import("@/lib/auth/password-validator");
    await validatePassword("ValidPassword123!", "account-1", true);

    // Should not query password_history
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("queries password_history with correct reuseBanCount limit", async () => {
    const { validatePassword } = await import("@/lib/auth/password-validator");
    await validatePassword("ValidPassword123!", "account-1");

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("LIMIT $2"),
      ["account-1", 5],
    );
  });

  it("skips reuse check when reuseBanCount is 0", async () => {
    mockLoadPasswordPolicy.mockResolvedValue({
      minLength: 12,
      maxLength: 128,
      complexityEnabled: false,
      reuseBanCount: 0,
    });

    const { validatePassword } = await import("@/lib/auth/password-validator");
    await validatePassword("ValidPassword123!", "account-1");

    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("accepts password not matching any history entry", async () => {
    mockQuery.mockResolvedValue({
      rows: [
        { password_hash: "$argon2id$hash1" },
        { password_hash: "$argon2id$hash2" },
        { password_hash: "$argon2id$hash3" },
      ],
      rowCount: 3,
    });
    // None of the hashes match
    mockVerifyPassword.mockResolvedValue(false);

    const { validatePassword } = await import("@/lib/auth/password-validator");
    const result = await validatePassword("ValidPassword123!", "account-1");

    expect(result.valid).toBe(true);
    expect(mockVerifyPassword).toHaveBeenCalledTimes(3);
  });

  it("skips reuse check when earlier validations already failed", async () => {
    // Password is too short — reuse check should be skipped
    const { validatePassword } = await import("@/lib/auth/password-validator");
    await validatePassword("short", "account-1");

    expect(mockQuery).not.toHaveBeenCalled();
  });
});
