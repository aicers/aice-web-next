/**
 * Focused tests for `resolveCustomerExternalKey`
 * (`src/lib/aimer/analysis/customer-external-key.ts`).
 *
 * This is where the empty / blank `external_key` case called out under
 * #646 "Upstream URL composition edge tests" is actually decided: a
 * blank stored DB value collapses to `null` here, before signing /
 * fetch / URL composition ever runs, so `composeUpstreamUrl` is never
 * reached with a blank key. The report-route tests only mock this
 * resolver returning `null`; this suite proves blank stored values
 * really do collapse.
 */

import { describe, expect, it, vi } from "vitest";

const mockQuery = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db/client", () => ({
  query: vi.fn((...args: unknown[]) => mockQuery(...args)),
}));

import { resolveCustomerExternalKey } from "@/lib/aimer/analysis/customer-external-key";

describe("resolveCustomerExternalKey", () => {
  it("returns the trimmed key for a populated value", async () => {
    mockQuery.mockResolvedValue({ rows: [{ external_key: "  acme  " }] });
    await expect(resolveCustomerExternalKey(1)).resolves.toBe("acme");
  });

  it("returns null when the customer row is missing", async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await expect(resolveCustomerExternalKey(1)).resolves.toBeNull();
  });

  it("collapses a NULL external_key to null", async () => {
    mockQuery.mockResolvedValue({ rows: [{ external_key: null }] });
    await expect(resolveCustomerExternalKey(1)).resolves.toBeNull();
  });

  it("collapses an empty-string external_key to null", async () => {
    mockQuery.mockResolvedValue({ rows: [{ external_key: "" }] });
    await expect(resolveCustomerExternalKey(1)).resolves.toBeNull();
  });

  it("collapses a whitespace-only external_key to null", async () => {
    mockQuery.mockResolvedValue({ rows: [{ external_key: "  \t \n " }] });
    await expect(resolveCustomerExternalKey(1)).resolves.toBeNull();
  });
});
