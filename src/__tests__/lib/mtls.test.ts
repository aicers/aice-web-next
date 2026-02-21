import { decodeJwt, decodeProtectedHeader } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  EC256_CERT,
  EC256_KEY,
  EC384_CERT,
  RSA_CERT,
  RSA_KEY,
  RSA4096_CERT,
  RSA4096_KEY,
} from "./fixtures";

const fileStore: Record<string, string> = {};

vi.mock("node:fs", () => ({
  readFileSync: vi.fn((filePath: string) => {
    if (filePath in fileStore) return fileStore[filePath];
    throw new Error(`ENOENT: no such file ${filePath}`);
  }),
}));

function setEnv(certPem: string, keyPem: string) {
  process.env.MTLS_CERT_PATH = "/tmp/cert.pem";
  process.env.MTLS_KEY_PATH = "/tmp/key.pem";
  process.env.MTLS_CA_PATH = "/tmp/ca.pem";

  for (const key of Object.keys(fileStore)) delete fileStore[key];
  Object.assign(fileStore, {
    "/tmp/cert.pem": certPem,
    "/tmp/key.pem": keyPem,
    "/tmp/ca.pem": certPem,
  });
}

describe("mtls", () => {
  let mtls: typeof import("@/lib/mtls");

  beforeEach(async () => {
    vi.resetModules();
    mtls = await import("@/lib/mtls");
  });

  afterEach(() => {
    delete process.env.MTLS_CERT_PATH;
    delete process.env.MTLS_KEY_PATH;
    delete process.env.MTLS_CA_PATH;
    for (const key of Object.keys(fileStore)) delete fileStore[key];
  });

  describe("detectAlgorithm", () => {
    it("returns RS256 for RSA 2048 certificate", () => {
      expect(mtls.detectAlgorithm(RSA_CERT)).toBe("RS256");
    });

    it("returns RS512 for RSA 4096 certificate", () => {
      expect(mtls.detectAlgorithm(RSA4096_CERT)).toBe("RS512");
    });

    it("returns ES256 for EC P-256 certificate", () => {
      expect(mtls.detectAlgorithm(EC256_CERT)).toBe("ES256");
    });

    it("returns ES384 for EC P-384 certificate", () => {
      expect(mtls.detectAlgorithm(EC384_CERT)).toBe("ES384");
    });
  });

  describe("signContextJwt", () => {
    it("includes role and customer_ids in payload", async () => {
      setEnv(EC256_CERT, EC256_KEY);
      const token = await mtls.signContextJwt("admin", [1, 2]);
      const payload = decodeJwt(token);

      expect(payload.role).toBe("admin");
      expect(payload.customer_ids).toEqual([1, 2]);
      expect(payload.exp).toBeTypeOf("number");
    });

    it("omits customer_ids when not provided", async () => {
      setEnv(EC256_CERT, EC256_KEY);
      const token = await mtls.signContextJwt("viewer");
      const payload = decodeJwt(token);

      expect(payload.role).toBe("viewer");
      expect(payload).not.toHaveProperty("customer_ids");
    });

    it("signs with RS256 for RSA 2048 key", async () => {
      setEnv(RSA_CERT, RSA_KEY);
      const token = await mtls.signContextJwt("admin");
      const header = decodeProtectedHeader(token);

      expect(header.alg).toBe("RS256");
    });

    it("signs with RS512 for RSA 4096 key", async () => {
      setEnv(RSA4096_CERT, RSA4096_KEY);
      const token = await mtls.signContextJwt("admin");
      const header = decodeProtectedHeader(token);

      expect(header.alg).toBe("RS512");
    });
  });

  describe("reload", () => {
    it("returns a different Agent instance", async () => {
      setEnv(EC256_CERT, EC256_KEY);
      const agent1 = await mtls.getAgent();
      const agent2 = await mtls.reload();

      expect(agent2).not.toBe(agent1);
    });
  });

  describe("error handling", () => {
    it("throws when MTLS_CERT_PATH is missing", async () => {
      delete process.env.MTLS_CERT_PATH;
      process.env.MTLS_KEY_PATH = "/tmp/key.pem";
      process.env.MTLS_CA_PATH = "/tmp/ca.pem";

      await expect(mtls.getAgent()).rejects.toThrow(
        "Missing environment variable: MTLS_CERT_PATH",
      );
    });

    it("throws when MTLS_KEY_PATH is missing", async () => {
      process.env.MTLS_CERT_PATH = "/tmp/cert.pem";
      delete process.env.MTLS_KEY_PATH;
      process.env.MTLS_CA_PATH = "/tmp/ca.pem";
      Object.assign(fileStore, {
        "/tmp/cert.pem": EC256_CERT,
        "/tmp/ca.pem": EC256_CERT,
      });

      await expect(mtls.getAgent()).rejects.toThrow(
        "Missing environment variable: MTLS_KEY_PATH",
      );
    });
  });
});
