import { beforeEach, describe, expect, it, vi } from "vitest";

const mockQuery = vi.hoisted(() => vi.fn());
const mockWithTransaction = vi.hoisted(() => vi.fn());
const mockArgon2Hash = vi.hoisted(() => vi.fn());
const mockArgon2Verify = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db/client", () => ({
  query: mockQuery,
  withTransaction: mockWithTransaction,
}));

vi.mock("argon2", () => ({
  default: {
    hash: mockArgon2Hash,
    verify: mockArgon2Verify,
    argon2id: 2,
  },
}));

vi.mock("server-only", () => ({}));

describe("recovery-codes", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockWithTransaction.mockReset();
    mockArgon2Hash.mockReset();
    mockArgon2Verify.mockReset();
    vi.resetModules();
  });

  // ── generateRecoveryCodes ──────────────────────────────────────

  describe("generateRecoveryCodes", () => {
    it("returns exactly 10 codes", async () => {
      mockArgon2Hash.mockResolvedValue("$argon2id$hashed");
      mockWithTransaction.mockImplementation(
        async (fn: (client: unknown) => Promise<void>) => {
          const mockClient = { query: vi.fn().mockResolvedValue({}) };
          await fn(mockClient);
        },
      );

      const { generateRecoveryCodes } = await import(
        "@/lib/auth/recovery-codes"
      );
      const codes = await generateRecoveryCodes("acc-1");

      expect(codes).toHaveLength(10);
    });

    it("returns codes in XXXX-XXXX format", async () => {
      mockArgon2Hash.mockResolvedValue("$argon2id$hashed");
      mockWithTransaction.mockImplementation(
        async (fn: (client: unknown) => Promise<void>) => {
          const mockClient = { query: vi.fn().mockResolvedValue({}) };
          await fn(mockClient);
        },
      );

      const { generateRecoveryCodes } = await import(
        "@/lib/auth/recovery-codes"
      );
      const codes = await generateRecoveryCodes("acc-1");

      for (const code of codes) {
        expect(code).toMatch(/^[A-F0-9]{4}-[A-F0-9]{4}$/);
      }
    });

    it("deletes existing codes before inserting new ones", async () => {
      mockArgon2Hash.mockResolvedValue("$argon2id$hashed");

      const mockClient = { query: vi.fn().mockResolvedValue({}) };
      mockWithTransaction.mockImplementation(
        async (fn: (client: unknown) => Promise<void>) => {
          await fn(mockClient);
        },
      );

      const { generateRecoveryCodes } = await import(
        "@/lib/auth/recovery-codes"
      );
      await generateRecoveryCodes("acc-1");

      // First call should be DELETE
      expect(mockClient.query).toHaveBeenCalledWith(
        "DELETE FROM recovery_codes WHERE account_id = $1",
        ["acc-1"],
      );
    });

    it("inserts 10 hashed codes into the database", async () => {
      mockArgon2Hash.mockResolvedValue("$argon2id$hashed");

      const mockClient = { query: vi.fn().mockResolvedValue({}) };
      mockWithTransaction.mockImplementation(
        async (fn: (client: unknown) => Promise<void>) => {
          await fn(mockClient);
        },
      );

      const { generateRecoveryCodes } = await import(
        "@/lib/auth/recovery-codes"
      );
      await generateRecoveryCodes("acc-1");

      // 1 DELETE + 10 INSERTs = 11 calls
      expect(mockClient.query).toHaveBeenCalledTimes(11);
    });

    it("hashes codes using argon2id", async () => {
      mockArgon2Hash.mockResolvedValue("$argon2id$hashed");
      mockWithTransaction.mockImplementation(
        async (fn: (client: unknown) => Promise<void>) => {
          const mockClient = { query: vi.fn().mockResolvedValue({}) };
          await fn(mockClient);
        },
      );

      const { generateRecoveryCodes } = await import(
        "@/lib/auth/recovery-codes"
      );
      await generateRecoveryCodes("acc-1");

      expect(mockArgon2Hash).toHaveBeenCalledTimes(10);
      expect(mockArgon2Hash).toHaveBeenCalledWith(expect.any(String), {
        type: 2, // argon2id
      });
    });
  });

  // ── verifyRecoveryCode ─────────────────────────────────────────

  describe("verifyRecoveryCode", () => {
    it("returns true and marks code as used when valid", async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [{ id: "code-1", code_hash: "$argon2id$hash1" }],
        })
        .mockResolvedValueOnce({ rows: [] }); // UPDATE
      mockArgon2Verify.mockResolvedValue(true);

      const { verifyRecoveryCode } = await import("@/lib/auth/recovery-codes");
      const result = await verifyRecoveryCode("acc-1", "A1B2-C3D4");

      expect(result).toBe(true);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE recovery_codes SET used = true"),
        ["code-1"],
      );
    });

    it("returns false when no codes match", async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: "code-1", code_hash: "$argon2id$hash1" }],
      });
      mockArgon2Verify.mockResolvedValue(false);

      const { verifyRecoveryCode } = await import("@/lib/auth/recovery-codes");
      const result = await verifyRecoveryCode("acc-1", "XXXX-YYYY");

      expect(result).toBe(false);
    });

    it("returns false when no unused codes exist", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const { verifyRecoveryCode } = await import("@/lib/auth/recovery-codes");
      const result = await verifyRecoveryCode("acc-1", "A1B2-C3D4");

      expect(result).toBe(false);
    });

    it("normalizes code by stripping dashes and uppercasing", async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: "code-1", code_hash: "$argon2id$hash1" }],
      });
      mockArgon2Verify.mockResolvedValue(true);
      mockQuery.mockResolvedValueOnce({ rows: [] }); // UPDATE

      const { verifyRecoveryCode } = await import("@/lib/auth/recovery-codes");
      await verifyRecoveryCode("acc-1", "a1b2-c3d4");

      // argon2.verify should be called with normalized (no dash, uppercase) code
      expect(mockArgon2Verify).toHaveBeenCalledWith(
        "$argon2id$hash1",
        "A1B2C3D4",
      );
    });

    it("tries multiple codes until a match is found", async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          { id: "code-1", code_hash: "$argon2id$hash1" },
          { id: "code-2", code_hash: "$argon2id$hash2" },
        ],
      });
      mockArgon2Verify
        .mockResolvedValueOnce(false) // first code doesn't match
        .mockResolvedValueOnce(true); // second code matches
      mockQuery.mockResolvedValueOnce({ rows: [] }); // UPDATE

      const { verifyRecoveryCode } = await import("@/lib/auth/recovery-codes");
      const result = await verifyRecoveryCode("acc-1", "A1B2-C3D4");

      expect(result).toBe(true);
      expect(mockArgon2Verify).toHaveBeenCalledTimes(2);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE recovery_codes SET used = true"),
        ["code-2"],
      );
    });
  });

  // ── getRecoveryCodeCount ───────────────────────────────────────

  describe("getRecoveryCodeCount", () => {
    it("returns remaining and total counts", async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ remaining: "8", total: "10" }],
      });

      const { getRecoveryCodeCount } = await import(
        "@/lib/auth/recovery-codes"
      );
      const result = await getRecoveryCodeCount("acc-1");

      expect(result).toEqual({ remaining: 8, total: 10 });
    });

    it("converts string counts to numbers", async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ remaining: "0", total: "10" }],
      });

      const { getRecoveryCodeCount } = await import(
        "@/lib/auth/recovery-codes"
      );
      const result = await getRecoveryCodeCount("acc-1");

      expect(typeof result.remaining).toBe("number");
      expect(typeof result.total).toBe("number");
      expect(result.remaining).toBe(0);
    });

    it("passes accountId to the query", async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ remaining: "5", total: "10" }],
      });

      const { getRecoveryCodeCount } = await import(
        "@/lib/auth/recovery-codes"
      );
      await getRecoveryCodeCount("acc-99");

      expect(mockQuery).toHaveBeenCalledWith(expect.any(String), ["acc-99"]);
    });
  });
});
