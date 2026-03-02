import { describe, expect, it } from "vitest";

import { hashPassword, verifyPassword } from "@/lib/auth/password";

describe("password", () => {
  describe("hashPassword", () => {
    it("returns an Argon2id PHC string", async () => {
      const hash = await hashPassword("test-password");

      expect(hash).toMatch(/^\$argon2id\$/);
    });

    it("produces different hashes for the same input (random salt)", async () => {
      const hash1 = await hashPassword("same-password");
      const hash2 = await hashPassword("same-password");

      expect(hash1).not.toBe(hash2);
    });
  });

  describe("verifyPassword", () => {
    it("returns true for a matching password", async () => {
      const hash = await hashPassword("correct-password");

      const result = await verifyPassword(hash, "correct-password");

      expect(result).toBe(true);
    });

    it("returns false for a non-matching password", async () => {
      const hash = await hashPassword("correct-password");

      const result = await verifyPassword(hash, "wrong-password");

      expect(result).toBe(false);
    });
  });
});
