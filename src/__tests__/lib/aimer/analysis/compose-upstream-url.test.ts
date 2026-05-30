/**
 * Focused tests for the server-side `composeUpstreamUrl` helper in
 * `src/lib/aimer/analysis/summary-route.ts` (#646 "Upstream URL
 * composition edge tests"). #646 is the second consumer of this
 * composition, so the trailing-slash handling and `external_key`
 * encoding are isolated here rather than only exercised end-to-end
 * through a route test.
 *
 * The module pulls in server-only dependencies at import time; they are
 * stubbed so the pure URL composition can be imported and called
 * without standing up the DB / signing-key machinery.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/aimer/settings", () => ({
  getAimerIntegrationSettings: vi.fn(),
}));
vi.mock("@/lib/aimer/signing-key", () => ({
  hasActiveAimerSigningKey: vi.fn(),
}));
vi.mock("@/lib/aimer/analysis/customer-external-key", () => ({
  resolveCustomerExternalKey: vi.fn(),
}));
vi.mock("@/lib/aimer/analysis/read-auth-token", () => ({
  buildReadAuthTokenPayload: vi.fn(),
  signReadAuthToken: vi.fn(),
}));

import { composeUpstreamUrl } from "@/lib/aimer/analysis/summary-route";

describe("composeUpstreamUrl", () => {
  const RESOURCE = "/analysis/report/LIVE/1970-01-01/summary";

  it("composes the customer-scoped upstream URL", () => {
    expect(
      composeUpstreamUrl("https://aimer.example.com", "acme", RESOURCE),
    ).toBe(
      "https://aimer.example.com/api/customers/acme/analysis/report/LIVE/1970-01-01/summary",
    );
  });

  it("strips a single trailing slash from the bridge URL", () => {
    expect(
      composeUpstreamUrl("https://aimer.example.com/", "acme", RESOURCE),
    ).toBe(
      "https://aimer.example.com/api/customers/acme/analysis/report/LIVE/1970-01-01/summary",
    );
  });

  it("strips multiple trailing slashes from the bridge URL", () => {
    expect(
      composeUpstreamUrl("https://aimer.example.com///", "acme", RESOURCE),
    ).toBe(
      "https://aimer.example.com/api/customers/acme/analysis/report/LIVE/1970-01-01/summary",
    );
  });

  it("percent-encodes an external_key containing reserved characters", () => {
    expect(
      composeUpstreamUrl(
        "https://aimer.example.com",
        "acme/dept space",
        RESOURCE,
      ),
    ).toBe(
      "https://aimer.example.com/api/customers/acme%2Fdept%20space/analysis/report/LIVE/1970-01-01/summary",
    );
  });

  it("encodes an external_key that is a bare slash into a single segment", () => {
    expect(composeUpstreamUrl("https://aimer.example.com", "/", RESOURCE)).toBe(
      "https://aimer.example.com/api/customers/%2F/analysis/report/LIVE/1970-01-01/summary",
    );
  });

  it("preserves a path-bearing bridge URL prefix", () => {
    expect(
      composeUpstreamUrl("https://gw.example.com/aimer", "acme", RESOURCE),
    ).toBe(
      "https://gw.example.com/aimer/api/customers/acme/analysis/report/LIVE/1970-01-01/summary",
    );
  });
});
