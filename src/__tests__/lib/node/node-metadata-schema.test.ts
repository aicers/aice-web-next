import { describe, expect, it } from "vitest";

import { nodeMetadataSchema } from "@/lib/node/node-metadata-schema";

const baseValid = {
  name: "node-alpha",
  customerId: "1",
  description: "first node",
  hostname: "alpha.local",
};

describe("nodeMetadataSchema", () => {
  it("accepts a fully valid payload", () => {
    expect(nodeMetadataSchema.safeParse(baseValid).success).toBe(true);
  });

  describe("name", () => {
    it("rejects empty", () => {
      expect(
        nodeMetadataSchema.safeParse({ ...baseValid, name: "" }).success,
      ).toBe(false);
    });
    it("rejects more than 32 characters", () => {
      expect(
        nodeMetadataSchema.safeParse({ ...baseValid, name: "x".repeat(33) })
          .success,
      ).toBe(false);
    });
    it("accepts exactly 32 characters", () => {
      expect(
        nodeMetadataSchema.safeParse({ ...baseValid, name: "x".repeat(32) })
          .success,
      ).toBe(true);
    });
    it("rejects XSS characters", () => {
      expect(
        nodeMetadataSchema.safeParse({ ...baseValid, name: "<script>" })
          .success,
      ).toBe(false);
    });
    it("rejects leading whitespace", () => {
      expect(
        nodeMetadataSchema.safeParse({ ...baseValid, name: " alpha" }).success,
      ).toBe(false);
    });
    it("rejects trailing whitespace", () => {
      expect(
        nodeMetadataSchema.safeParse({ ...baseValid, name: "alpha " }).success,
      ).toBe(false);
    });
  });

  describe("customerId", () => {
    it("rejects empty", () => {
      expect(
        nodeMetadataSchema.safeParse({ ...baseValid, customerId: "" }).success,
      ).toBe(false);
    });
  });

  describe("description", () => {
    it("accepts empty", () => {
      expect(
        nodeMetadataSchema.safeParse({ ...baseValid, description: "" }).success,
      ).toBe(true);
    });
    it("rejects more than 64 characters", () => {
      expect(
        nodeMetadataSchema.safeParse({
          ...baseValid,
          description: "x".repeat(65),
        }).success,
      ).toBe(false);
    });
    it("rejects XSS characters", () => {
      expect(
        nodeMetadataSchema.safeParse({
          ...baseValid,
          description: "evil(",
        }).success,
      ).toBe(false);
    });
  });

  describe("hostname", () => {
    it("rejects empty", () => {
      expect(
        nodeMetadataSchema.safeParse({ ...baseValid, hostname: "" }).success,
      ).toBe(false);
    });
    it("rejects more than 64 characters", () => {
      expect(
        nodeMetadataSchema.safeParse({
          ...baseValid,
          hostname: `${"x".repeat(64)}a`,
        }).success,
      ).toBe(false);
    });
    it("rejects uppercase characters", () => {
      expect(
        nodeMetadataSchema.safeParse({ ...baseValid, hostname: "Alpha.local" })
          .success,
      ).toBe(false);
    });
    it("rejects leading dot", () => {
      expect(
        nodeMetadataSchema.safeParse({ ...baseValid, hostname: ".alpha" })
          .success,
      ).toBe(false);
    });
    it("rejects trailing dash", () => {
      expect(
        nodeMetadataSchema.safeParse({ ...baseValid, hostname: "alpha-" })
          .success,
      ).toBe(false);
    });
    it("rejects consecutive specials", () => {
      expect(
        nodeMetadataSchema.safeParse({ ...baseValid, hostname: "alpha..local" })
          .success,
      ).toBe(false);
    });
    it("accepts a hyphen in the middle", () => {
      expect(
        nodeMetadataSchema.safeParse({ ...baseValid, hostname: "node-1.local" })
          .success,
      ).toBe(true);
    });
  });
});
