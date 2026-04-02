import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("server-only", () => ({}));

import {
  ADMIN_USERNAME,
  type AuthSession,
  authGet,
  signIn,
} from "../helpers/auth";
import {
  createTestAccount,
  deleteRecoveryCodes,
  deleteTestAccount,
  deleteTotpCredential,
  deleteWebAuthnCredentials,
  enrollAndVerifyTotp,
} from "../helpers/setup-db";

/**
 * These tests exercise the `emergencyMfaReset()` function directly,
 * because the break-glass mechanism runs at server startup and cannot
 * be triggered via HTTP.
 */

const TEST_USER = "emergency-reset-target";
const TEST_PASSWORD = "EmergencyTest1234!";
const MONITOR_ROLE = "Security Monitor";

function getDataDir(): string {
  if (process.env.DATA_DIR) return resolve(process.env.DATA_DIR);
  try {
    const envFile = readFileSync(resolve(".env.local"), "utf8");
    const match = envFile.match(/^DATA_DIR=(.+)$/m);
    if (match) return resolve(match[1].trim());
  } catch {
    /* empty */
  }
  return resolve("data-integration");
}

function markerPath(username: string): string {
  return resolve(getDataDir(), `.emergency_mfa_reset_consumed_${username}`);
}

function cleanupMarker(username: string): void {
  const p = markerPath(username);
  if (existsSync(p)) rmSync(p);
}

describe("Emergency MFA Reset (break-glass)", () => {
  let adminSession: AuthSession;

  beforeAll(async () => {
    await createTestAccount(TEST_USER, TEST_PASSWORD, MONITOR_ROLE);
    adminSession = await signIn(ADMIN_USERNAME);
  });

  afterAll(async () => {
    cleanupMarker(TEST_USER);
    await deleteTotpCredential(TEST_USER);
    await deleteWebAuthnCredentials(TEST_USER);
    await deleteRecoveryCodes(TEST_USER);
    await deleteTestAccount(TEST_USER);
  });

  afterEach(() => {
    cleanupMarker(TEST_USER);
    // Restore env
    delete process.env.EMERGENCY_MFA_RESET;
  });

  it("clears MFA credentials and creates marker file", async () => {
    await enrollAndVerifyTotp(TEST_USER);

    // Import the function directly
    // Note: we must set env before importing, but the module reads it lazily
    process.env.EMERGENCY_MFA_RESET = TEST_USER;

    const { emergencyMfaReset } = await import(
      "@/lib/auth/emergency-mfa-reset"
    );
    await emergencyMfaReset();

    // Verify MFA cleared
    const accounts = await authGet(
      adminSession,
      `/api/accounts?search=${TEST_USER}`,
    );
    const body = await accounts.json();
    const target = body.data.find(
      (a: { username: string }) => a.username === TEST_USER,
    );
    expect(target.has_mfa).toBe(false);

    // Verify marker file exists
    expect(existsSync(markerPath(TEST_USER))).toBe(true);
  });

  it("does not re-execute when marker file exists", async () => {
    await enrollAndVerifyTotp(TEST_USER);

    process.env.EMERGENCY_MFA_RESET = TEST_USER;

    const { emergencyMfaReset } = await import(
      "@/lib/auth/emergency-mfa-reset"
    );

    // First run
    await emergencyMfaReset();
    expect(existsSync(markerPath(TEST_USER))).toBe(true);

    // Re-enroll TOTP after first reset
    await enrollAndVerifyTotp(TEST_USER);

    // Second run should not clear MFA (marker exists)
    await emergencyMfaReset();

    // Verify TOTP still exists (not reset again)
    const accounts = await authGet(
      adminSession,
      `/api/accounts?search=${TEST_USER}`,
    );
    const body = await accounts.json();
    const target = body.data.find(
      (a: { username: string }) => a.username === TEST_USER,
    );
    expect(target.has_mfa).toBe(true);
  });

  it("records audit event with actor 'system'", async () => {
    await enrollAndVerifyTotp(TEST_USER);
    process.env.EMERGENCY_MFA_RESET = TEST_USER;

    const { emergencyMfaReset } = await import(
      "@/lib/auth/emergency-mfa-reset"
    );
    await emergencyMfaReset();

    const auditRes = await authGet(
      adminSession,
      "/api/audit-logs?action=mfa.emergency.reset&pageSize=1",
    );
    expect(auditRes.status).toBe(200);
    const auditBody = await auditRes.json();
    expect(auditBody.data.length).toBeGreaterThan(0);
    expect(auditBody.data[0].action).toBe("mfa.emergency.reset");
    expect(auditBody.data[0].actor_id).toBe("system");
  });

  it("handles non-existent username gracefully", async () => {
    process.env.EMERGENCY_MFA_RESET = "nonexistent-user-xyz";

    const { emergencyMfaReset } = await import(
      "@/lib/auth/emergency-mfa-reset"
    );

    // Should not throw
    await emergencyMfaReset();

    // Marker should not be created for non-existent user
    expect(existsSync(markerPath("nonexistent-user-xyz"))).toBe(false);
  });

  it("does nothing when env var is not set", async () => {
    delete process.env.EMERGENCY_MFA_RESET;

    const { emergencyMfaReset } = await import(
      "@/lib/auth/emergency-mfa-reset"
    );

    // Should not throw
    await emergencyMfaReset();
  });
});
