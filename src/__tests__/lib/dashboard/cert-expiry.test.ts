import { X509Certificate } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RSA_CERT } from "../fixtures";

// ── Mock node:fs ──────────────────────────────────────────────────

const fileStore: Record<string, string> = {};

vi.mock("node:fs", () => ({
  readFileSync: vi.fn((filePath: string) => {
    if (filePath in fileStore) return fileStore[filePath];
    throw new Error(`ENOENT: no such file ${filePath}`);
  }),
}));

// ── Mock server-only (no-op in tests) ─────────────────────────────

vi.mock("server-only", () => ({}));

// ── Helpers ───────────────────────────────────────────────────────

function setCertEnv(certPem: string) {
  process.env.MTLS_CERT_PATH = "/tmp/test-cert.pem";
  for (const key of Object.keys(fileStore)) delete fileStore[key];
  fileStore["/tmp/test-cert.pem"] = certPem;
}

function clearEnv() {
  delete process.env.MTLS_CERT_PATH;
  for (const key of Object.keys(fileStore)) delete fileStore[key];
}

// ── Tests ─────────────────────────────────────────────────────────

describe("getCertStatus", () => {
  beforeEach(() => {
    clearEnv();
    vi.resetModules();
  });

  afterEach(() => {
    clearEnv();
    vi.restoreAllMocks();
  });

  it("returns configured: false when MTLS_CERT_PATH is not set", async () => {
    const { getCertStatus } = await import("@/lib/dashboard/cert-expiry");
    const result = getCertStatus();

    expect(result).toEqual({ configured: false });
  });

  it("returns configured: false when cert file does not exist", async () => {
    process.env.MTLS_CERT_PATH = "/tmp/nonexistent.pem";

    const { getCertStatus } = await import("@/lib/dashboard/cert-expiry");
    const result = getCertStatus();

    expect(result).toEqual({ configured: false });
  });

  it('returns severity "ok" for a cert expiring far in the future', async () => {
    // RSA_CERT expires in 2036 (>30 days from now)
    setCertEnv(RSA_CERT);

    const { getCertStatus } = await import("@/lib/dashboard/cert-expiry");
    const result = getCertStatus();

    expect(result.configured).toBe(true);
    expect(result.severity).toBe("ok");
    expect(result.daysRemaining).toBeGreaterThan(30);
    expect(result.subject).toBeTruthy();
    expect(result.issuer).toBeTruthy();
    expect(result.validFrom).toBeTruthy();
    expect(result.validTo).toBeTruthy();
  });

  it('returns severity "warning" for a cert expiring in 7-30 days', async () => {
    // Mock Date to make the RSA_CERT appear to expire in ~15 days
    const cert = new X509Certificate(RSA_CERT);
    const validTo = new Date(cert.validTo);
    const fifteenDaysBefore = new Date(
      validTo.getTime() - 15 * 24 * 60 * 60 * 1000,
    );

    vi.useFakeTimers();
    vi.setSystemTime(fifteenDaysBefore);

    setCertEnv(RSA_CERT);

    const { getCertStatus } = await import("@/lib/dashboard/cert-expiry");
    const result = getCertStatus();

    expect(result.configured).toBe(true);
    expect(result.severity).toBe("warning");
    expect(result.daysRemaining).toBeGreaterThanOrEqual(14);
    expect(result.daysRemaining).toBeLessThanOrEqual(15);

    vi.useRealTimers();
  });

  it('returns severity "critical" for a cert expiring in less than 7 days', async () => {
    // Mock Date to make the RSA_CERT appear to expire in ~3 days
    const cert = new X509Certificate(RSA_CERT);
    const validTo = new Date(cert.validTo);
    const threeDaysBefore = new Date(
      validTo.getTime() - 3 * 24 * 60 * 60 * 1000,
    );

    vi.useFakeTimers();
    vi.setSystemTime(threeDaysBefore);

    setCertEnv(RSA_CERT);

    const { getCertStatus } = await import("@/lib/dashboard/cert-expiry");
    const result = getCertStatus();

    expect(result.configured).toBe(true);
    expect(result.severity).toBe("critical");
    expect(result.daysRemaining).toBeGreaterThanOrEqual(2);
    expect(result.daysRemaining).toBeLessThanOrEqual(3);

    vi.useRealTimers();
  });

  it('returns severity "critical" for an already-expired cert', async () => {
    // Mock Date to be after the cert's validTo
    const cert = new X509Certificate(RSA_CERT);
    const validTo = new Date(cert.validTo);
    const afterExpiry = new Date(validTo.getTime() + 10 * 24 * 60 * 60 * 1000);

    vi.useFakeTimers();
    vi.setSystemTime(afterExpiry);

    setCertEnv(RSA_CERT);

    const { getCertStatus } = await import("@/lib/dashboard/cert-expiry");
    const result = getCertStatus();

    expect(result.configured).toBe(true);
    expect(result.severity).toBe("critical");
    expect(result.daysRemaining).toBeLessThan(0);

    vi.useRealTimers();
  });

  it('returns severity "warning" at exactly 29 days remaining (boundary)', async () => {
    const cert = new X509Certificate(RSA_CERT);
    const validTo = new Date(cert.validTo);
    // Place "now" at exactly 29 days before expiry
    const twentyNineDaysBefore = new Date(
      validTo.getTime() - 29 * 24 * 60 * 60 * 1000,
    );

    vi.useFakeTimers();
    vi.setSystemTime(twentyNineDaysBefore);

    setCertEnv(RSA_CERT);

    const { getCertStatus } = await import("@/lib/dashboard/cert-expiry");
    const result = getCertStatus();

    expect(result.severity).toBe("warning");

    vi.useRealTimers();
  });

  it('returns severity "ok" at exactly 30 days remaining (boundary)', async () => {
    const cert = new X509Certificate(RSA_CERT);
    const validTo = new Date(cert.validTo);
    // Place "now" at exactly 31 days before expiry so floor = 30
    const thirtyOneDaysBefore = new Date(
      validTo.getTime() - 31 * 24 * 60 * 60 * 1000,
    );

    vi.useFakeTimers();
    vi.setSystemTime(thirtyOneDaysBefore);

    setCertEnv(RSA_CERT);

    const { getCertStatus } = await import("@/lib/dashboard/cert-expiry");
    const result = getCertStatus();

    expect(result.severity).toBe("ok");

    vi.useRealTimers();
  });

  it('returns severity "critical" at exactly 6 days remaining (boundary)', async () => {
    const cert = new X509Certificate(RSA_CERT);
    const validTo = new Date(cert.validTo);
    const sixDaysBefore = new Date(validTo.getTime() - 6 * 24 * 60 * 60 * 1000);

    vi.useFakeTimers();
    vi.setSystemTime(sixDaysBefore);

    setCertEnv(RSA_CERT);

    const { getCertStatus } = await import("@/lib/dashboard/cert-expiry");
    const result = getCertStatus();

    expect(result.severity).toBe("critical");

    vi.useRealTimers();
  });

  it('returns severity "warning" at exactly 7 days remaining (boundary)', async () => {
    const cert = new X509Certificate(RSA_CERT);
    const validTo = new Date(cert.validTo);
    // Place "now" at exactly 8 days before expiry so floor = 7
    const eightDaysBefore = new Date(
      validTo.getTime() - 8 * 24 * 60 * 60 * 1000,
    );

    vi.useFakeTimers();
    vi.setSystemTime(eightDaysBefore);

    setCertEnv(RSA_CERT);

    const { getCertStatus } = await import("@/lib/dashboard/cert-expiry");
    const result = getCertStatus();

    expect(result.severity).toBe("warning");

    vi.useRealTimers();
  });

  it("parses subject and issuer from the certificate", async () => {
    setCertEnv(RSA_CERT);

    const { getCertStatus } = await import("@/lib/dashboard/cert-expiry");
    const result = getCertStatus();

    // RSA_CERT has CN=test-rsa
    expect(result.subject).toContain("test-rsa");
    expect(result.issuer).toContain("test-rsa");
  });
});
