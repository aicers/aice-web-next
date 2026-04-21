import { decodeProtectedHeader } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("mtls test-only bypass", () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.MTLS_CERT_PATH;
    delete process.env.MTLS_KEY_PATH;
    delete process.env.MTLS_CA_PATH;
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("TEST_ALLOW_PLAIN_GRAPHQL", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns a plain Agent when both env gates are set", async () => {
    vi.stubEnv("TEST_ALLOW_PLAIN_GRAPHQL", "1");
    const mtls = await import("@/lib/mtls");
    const agent = await mtls.getAgent();
    expect(agent).toBeDefined();
  });

  it("signs an ephemeral ES256 JWT in bypass mode", async () => {
    vi.stubEnv("TEST_ALLOW_PLAIN_GRAPHQL", "1");
    const mtls = await import("@/lib/mtls");
    const token = await mtls.signContextJwt("System Administrator");
    const header = decodeProtectedHeader(token);
    expect(header.alg).toBe("ES256");
  });

  it("falls through to mTLS path when TEST_ALLOW_PLAIN_GRAPHQL is unset", async () => {
    const mtls = await import("@/lib/mtls");
    await expect(mtls.getAgent()).rejects.toThrow(
      /Missing environment variable: MTLS_CERT_PATH/,
    );
  });

  it("falls through to mTLS path when NODE_ENV is not test", async () => {
    vi.stubEnv("TEST_ALLOW_PLAIN_GRAPHQL", "1");
    vi.stubEnv("NODE_ENV", "production");
    const mtls = await import("@/lib/mtls");
    await expect(mtls.getAgent()).rejects.toThrow(
      /Missing environment variable: MTLS_CERT_PATH/,
    );
  });
});
