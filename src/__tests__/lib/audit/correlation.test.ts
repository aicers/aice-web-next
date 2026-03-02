import { describe, expect, it } from "vitest";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("correlation", () => {
  let correlation: typeof import("@/lib/audit/correlation");

  // Use a fresh import so module-level AsyncLocalStorage is available
  it("module loads", async () => {
    correlation = await import("@/lib/audit/correlation");
    expect(correlation).toBeDefined();
  });

  // ── generateCorrelationId ─────────────────────────────────────

  describe("generateCorrelationId", () => {
    it("returns a valid UUID v4", async () => {
      correlation = await import("@/lib/audit/correlation");
      const id = correlation.generateCorrelationId();
      expect(id).toMatch(UUID_REGEX);
    });

    it("returns unique values on each call", async () => {
      correlation = await import("@/lib/audit/correlation");
      const ids = new Set(
        Array.from({ length: 100 }, () => correlation.generateCorrelationId()),
      );
      expect(ids.size).toBe(100);
    });
  });

  // ── getCorrelationId ──────────────────────────────────────────

  describe("getCorrelationId", () => {
    it("returns undefined outside context", async () => {
      correlation = await import("@/lib/audit/correlation");
      expect(correlation.getCorrelationId()).toBeUndefined();
    });
  });

  // ── withCorrelationId ─────────────────────────────────────────

  describe("withCorrelationId", () => {
    it("makes ID available via getCorrelationId", async () => {
      correlation = await import("@/lib/audit/correlation");
      const id = "test-id-1234";

      correlation.withCorrelationId(id, () => {
        expect(correlation.getCorrelationId()).toBe(id);
      });
    });

    it("restores context after completion", async () => {
      correlation = await import("@/lib/audit/correlation");

      correlation.withCorrelationId("inner-id", () => {
        // ID is available inside
        expect(correlation.getCorrelationId()).toBe("inner-id");
      });

      // ID is gone outside
      expect(correlation.getCorrelationId()).toBeUndefined();
    });

    it("supports nested contexts (innermost wins)", async () => {
      correlation = await import("@/lib/audit/correlation");

      correlation.withCorrelationId("outer", () => {
        expect(correlation.getCorrelationId()).toBe("outer");

        correlation.withCorrelationId("inner", () => {
          expect(correlation.getCorrelationId()).toBe("inner");
        });

        // Outer is restored after inner completes
        expect(correlation.getCorrelationId()).toBe("outer");
      });
    });

    it("preserves ID across async operations", async () => {
      correlation = await import("@/lib/audit/correlation");
      const id = "async-test-id";

      await correlation.withCorrelationId(id, async () => {
        // Simulate async work
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(correlation.getCorrelationId()).toBe(id);

        // Another async hop
        await Promise.resolve();
        expect(correlation.getCorrelationId()).toBe(id);
      });
    });

    it("returns the value from the wrapped function", async () => {
      correlation = await import("@/lib/audit/correlation");

      const result = correlation.withCorrelationId("id", () => 42);
      expect(result).toBe(42);
    });

    it("returns the promise from an async wrapped function", async () => {
      correlation = await import("@/lib/audit/correlation");

      const result = await correlation.withCorrelationId(
        "id",
        async () => "async-result",
      );
      expect(result).toBe("async-result");
    });
  });
});
