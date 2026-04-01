import { beforeEach, describe, expect, it, vi } from "vitest";

const mockQuery = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db/client", () => ({
  query: mockQuery,
}));

vi.mock("server-only", () => ({}));

describe("mfa-enforcement", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    vi.resetModules();
  });

  // ── getMfaRequirement ──────────────────────────────────────────

  describe("getMfaRequirement", () => {
    it('returns "exempt" when account override is "exempt"', async () => {
      const { getMfaRequirement } = await import("@/lib/auth/mfa-enforcement");
      expect(getMfaRequirement("exempt", true)).toBe("exempt");
    });

    it('returns "exempt" even when role does not require MFA', async () => {
      const { getMfaRequirement } = await import("@/lib/auth/mfa-enforcement");
      expect(getMfaRequirement("exempt", false)).toBe("exempt");
    });

    it('returns "required" when account override is "required"', async () => {
      const { getMfaRequirement } = await import("@/lib/auth/mfa-enforcement");
      expect(getMfaRequirement("required", false)).toBe("required");
    });

    it('returns "required" when role requires MFA and no override', async () => {
      const { getMfaRequirement } = await import("@/lib/auth/mfa-enforcement");
      expect(getMfaRequirement(null, true)).toBe("required");
    });

    it('returns "none" when no override and role does not require MFA', async () => {
      const { getMfaRequirement } = await import("@/lib/auth/mfa-enforcement");
      expect(getMfaRequirement(null, false)).toBe("none");
    });

    it("account-level override takes priority over role setting", async () => {
      const { getMfaRequirement } = await import("@/lib/auth/mfa-enforcement");
      // "exempt" override should win even if role requires MFA
      expect(getMfaRequirement("exempt", true)).toBe("exempt");
      // "required" override should win even if role does not require MFA
      expect(getMfaRequirement("required", false)).toBe("required");
    });

    it('returns "none" for unknown override values', async () => {
      const { getMfaRequirement } = await import("@/lib/auth/mfa-enforcement");
      expect(getMfaRequirement("unknown", false)).toBe("none");
    });
  });

  // ── isUserMfaEnrolled ──────────────────────────────────────────

  describe("isUserMfaEnrolled", () => {
    it("returns true when user has enrolled MFA", async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ enrolled: true }],
      });

      const { isUserMfaEnrolled } = await import("@/lib/auth/mfa-enforcement");
      const result = await isUserMfaEnrolled("acc-1");

      expect(result).toBe(true);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("SELECT EXISTS"),
        ["acc-1"],
      );
    });

    it("returns false when user has no MFA methods", async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ enrolled: false }],
      });

      const { isUserMfaEnrolled } = await import("@/lib/auth/mfa-enforcement");
      const result = await isUserMfaEnrolled("acc-2");

      expect(result).toBe(false);
    });

    it("passes accountId to the query", async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ enrolled: false }],
      });

      const { isUserMfaEnrolled } = await import("@/lib/auth/mfa-enforcement");
      await isUserMfaEnrolled("acc-42");

      expect(mockQuery).toHaveBeenCalledWith(expect.any(String), ["acc-42"]);
    });

    it("checks both totp_credentials and webauthn_credentials", async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ enrolled: true }],
      });

      const { isUserMfaEnrolled } = await import("@/lib/auth/mfa-enforcement");
      await isUserMfaEnrolled("acc-1");

      const sql = mockQuery.mock.calls[0][0] as string;
      expect(sql).toContain("totp_credentials");
      expect(sql).toContain("webauthn_credentials");
    });
  });
});
