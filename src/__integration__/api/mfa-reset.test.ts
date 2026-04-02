import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  type AuthSession,
  authGet,
  authPost,
  resetRateLimits,
  signIn,
} from "../helpers/auth";
import {
  createTestAccount,
  deleteRecoveryCodes,
  deleteTestAccount,
  deleteTotpCredential,
  deleteWebAuthnCredentials,
  enrollAndVerifyTotp,
  insertWebAuthnCredential,
} from "../helpers/setup-db";

const TEST_USER = "mfa-reset-target";
const TEST_PASSWORD = "TestUser1234!";
const MONITOR_ROLE = "Security Monitor";

describe("Admin MFA Reset", () => {
  let adminSession: AuthSession;

  beforeAll(async () => {
    await resetRateLimits();
    await createTestAccount(TEST_USER, TEST_PASSWORD, MONITOR_ROLE);
    adminSession = await signIn(ADMIN_USERNAME);
  });

  afterAll(async () => {
    await deleteTotpCredential(TEST_USER);
    await deleteWebAuthnCredentials(TEST_USER);
    await deleteRecoveryCodes(TEST_USER);
    await deleteTestAccount(TEST_USER);
  });

  beforeEach(async () => {
    await resetRateLimits();
    await deleteTotpCredential(TEST_USER);
    await deleteWebAuthnCredentials(TEST_USER);
    await deleteRecoveryCodes(TEST_USER);
    // Re-create admin session (resetAccountDefaults deletes sessions)
    adminSession = await signIn(ADMIN_USERNAME);
  });

  // ── Success cases ───────────────────────────────────────────────

  it("removes all TOTP credentials", async () => {
    await enrollAndVerifyTotp(TEST_USER);

    const accountId = await getAccountId(TEST_USER);
    const res = await authPost(
      adminSession,
      `/api/accounts/${accountId}/mfa-reset`,
      { password: ADMIN_PASSWORD },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);

    // Verify via accounts API
    const accounts = await authGet(
      adminSession,
      `/api/accounts?search=${TEST_USER}`,
    );
    const accountsBody = await accounts.json();
    const target = accountsBody.data.find(
      (a: { id: string }) => a.id === accountId,
    );
    expect(target.has_mfa).toBe(false);

    // Verify at DB level
    const totpCount = await queryCount(
      "totp_credentials",
      "account_id",
      accountId,
    );
    expect(totpCount).toBe(0);
  });

  it("removes WebAuthn credentials", async () => {
    await insertWebAuthnCredential(TEST_USER);
    const accountId = await getAccountId(TEST_USER);

    const res = await authPost(
      adminSession,
      `/api/accounts/${accountId}/mfa-reset`,
      { password: ADMIN_PASSWORD },
    );

    expect(res.status).toBe(200);

    // Verify at DB level
    const webauthnCount = await queryCount(
      "webauthn_credentials",
      "account_id",
      accountId,
    );
    expect(webauthnCount).toBe(0);
  });

  it("removes recovery codes", async () => {
    await enrollAndVerifyTotp(TEST_USER);
    const userSession = await signIn(TEST_USER);
    await authPost(userSession, "/api/auth/mfa/recovery/generate", {
      password: TEST_PASSWORD,
    });

    const accountId = await getAccountId(TEST_USER);
    const res = await authPost(
      adminSession,
      `/api/accounts/${accountId}/mfa-reset`,
      { password: ADMIN_PASSWORD },
    );

    expect(res.status).toBe(200);

    // Verify at DB level
    const codeCount = await queryCount(
      "recovery_codes",
      "account_id",
      accountId,
    );
    expect(codeCount).toBe(0);
  });

  it("removes all MFA types in a single transaction", async () => {
    // Enroll TOTP + WebAuthn + recovery codes
    await enrollAndVerifyTotp(TEST_USER);
    await insertWebAuthnCredential(TEST_USER);
    const userSession = await signIn(TEST_USER);
    await authPost(userSession, "/api/auth/mfa/recovery/generate", {
      password: TEST_PASSWORD,
    });

    const accountId = await getAccountId(TEST_USER);
    const res = await authPost(
      adminSession,
      `/api/accounts/${accountId}/mfa-reset`,
      { password: ADMIN_PASSWORD },
    );

    expect(res.status).toBe(200);

    // Verify all cleared at DB level
    const totpCount = await queryCount(
      "totp_credentials",
      "account_id",
      accountId,
    );
    const webauthnCount = await queryCount(
      "webauthn_credentials",
      "account_id",
      accountId,
    );
    const codeCount = await queryCount(
      "recovery_codes",
      "account_id",
      accountId,
    );
    expect(totpCount).toBe(0);
    expect(webauthnCount).toBe(0);
    expect(codeCount).toBe(0);
  });

  it("revokes target sessions without affecting admin session", async () => {
    await enrollAndVerifyTotp(TEST_USER);

    const userSession = await signIn(TEST_USER);
    const beforeRes = await authGet(userSession, "/api/roles");
    expect(beforeRes.status).toBe(200);

    await authPost(
      adminSession,
      `/api/accounts/${await getAccountId(TEST_USER)}/mfa-reset`,
      { password: ADMIN_PASSWORD },
    );

    // Target session is revoked
    const afterRes = await authGet(userSession, "/api/roles");
    expect(afterRes.status).toBe(401);

    // Admin session still works
    const adminRes = await authGet(adminSession, "/api/roles");
    expect(adminRes.status).toBe(200);
  });

  it("records audit event with correct fields", async () => {
    await enrollAndVerifyTotp(TEST_USER);
    const accountId = await getAccountId(TEST_USER);

    await authPost(adminSession, `/api/accounts/${accountId}/mfa-reset`, {
      password: ADMIN_PASSWORD,
    });

    const auditRes = await authGet(
      adminSession,
      "/api/audit-logs?action=mfa.admin.reset&pageSize=1",
    );
    expect(auditRes.status).toBe(200);
    const auditBody = await auditRes.json();
    expect(auditBody.data.length).toBeGreaterThan(0);

    const entry = auditBody.data[0];
    expect(entry.action).toBe("mfa.admin.reset");
    expect(entry.target_type).toBe("account");
    expect(entry.target_id).toBe(accountId);
    expect(entry.details.targetUsername).toBe(TEST_USER);
  });

  // ── Error cases ─────────────────────────────────────────────────

  it("rejects wrong password (401 INVALID_PASSWORD)", async () => {
    await enrollAndVerifyTotp(TEST_USER);

    const res = await authPost(
      adminSession,
      `/api/accounts/${await getAccountId(TEST_USER)}/mfa-reset`,
      { password: "WrongPassword1!" },
    );

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("INVALID_PASSWORD");
  });

  it("does not delete MFA on wrong password", async () => {
    await enrollAndVerifyTotp(TEST_USER);
    const accountId = await getAccountId(TEST_USER);

    await authPost(adminSession, `/api/accounts/${accountId}/mfa-reset`, {
      password: "WrongPassword1!",
    });

    // TOTP should still exist
    const totpCount = await queryCount(
      "totp_credentials",
      "account_id",
      accountId,
    );
    expect(totpCount).toBe(1);
  });

  it("rejects self-reset (400)", async () => {
    const adminId = await getAccountId(ADMIN_USERNAME);

    const res = await authPost(
      adminSession,
      `/api/accounts/${adminId}/mfa-reset`,
      { password: ADMIN_PASSWORD },
    );

    expect(res.status).toBe(400);
  });

  it("rejects reset for System Administrator (403 ROLE_HIERARCHY)", async () => {
    const sysAdmin2 = "mfa-reset-sysadmin";
    await createTestAccount(sysAdmin2, "SysAdmin1234!", "System Administrator");

    try {
      const res = await authPost(
        adminSession,
        `/api/accounts/${await getAccountId(sysAdmin2)}/mfa-reset`,
        { password: ADMIN_PASSWORD },
      );

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.code).toBe("ROLE_HIERARCHY");
    } finally {
      await deleteTestAccount(sysAdmin2);
    }
  });

  it("returns 404 for non-existent account", async () => {
    const fakeId = "00000000-0000-0000-0000-000000000000";

    const res = await authPost(
      adminSession,
      `/api/accounts/${fakeId}/mfa-reset`,
      { password: ADMIN_PASSWORD },
    );

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("ACCOUNT_NOT_FOUND");
  });

  it("rejects missing password (400)", async () => {
    const res = await authPost(
      adminSession,
      `/api/accounts/${await getAccountId(TEST_USER)}/mfa-reset`,
      {},
    );

    expect(res.status).toBe(400);
  });

  it("rejects reset for account with no MFA enrolled (409 NO_MFA)", async () => {
    // TEST_USER has no MFA (cleaned in beforeEach)
    const res = await authPost(
      adminSession,
      `/api/accounts/${await getAccountId(TEST_USER)}/mfa-reset`,
      { password: ADMIN_PASSWORD },
    );

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("NO_MFA");
  });

  it("rate-limits step-up password attempts (429)", async () => {
    await enrollAndVerifyTotp(TEST_USER);
    const accountId = await getAccountId(TEST_USER);

    // Exhaust sensitive-op rate limit (5 per 15 min)
    for (let i = 0; i < 5; i++) {
      await authPost(adminSession, `/api/accounts/${accountId}/mfa-reset`, {
        password: "WrongPassword1!",
      });
    }

    // 6th attempt should be rate-limited
    const res = await authPost(
      adminSession,
      `/api/accounts/${accountId}/mfa-reset`,
      { password: "WrongPassword1!" },
    );

    expect(res.status).toBe(429);
  });

  it("rejects invalid JSON (400)", async () => {
    const accountId = await getAccountId(TEST_USER);
    const res = await fetch(
      `${(await import("../setup")).SERVER_ORIGIN}/api/accounts/${accountId}/mfa-reset`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: adminSession.cookie,
          "X-CSRF-Token": adminSession.csrfToken,
          "User-Agent": "IntegrationTest/1.0",
          Origin: (await import("../setup")).SERVER_ORIGIN,
        },
        body: "not json",
      },
    );

    expect(res.status).toBe(400);
  });
});

// ── DB Helpers ──────────────────────────────────────────────────

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";

function getDatabaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    const envFile = readFileSync(resolve(".env.local"), "utf8");
    const match = envFile.match(/^DATABASE_URL=(.+)$/m);
    if (match) return match[1].trim();
  } catch {
    /* empty */
  }
  return "postgres://postgres:postgres@localhost:5432/auth_db";
}

async function withDb<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: getDatabaseUrl() });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function getAccountId(username: string): Promise<string> {
  return withDb(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      "SELECT id FROM accounts WHERE username = $1",
      [username],
    );
    if (rows.length === 0) throw new Error(`Account "${username}" not found`);
    return rows[0].id;
  });
}

async function queryCount(
  table: string,
  column: string,
  value: string,
): Promise<number> {
  return withDb(async (client) => {
    const { rows } = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM ${table} WHERE ${column} = $1`,
      [value],
    );
    return Number.parseInt(rows[0].count, 10);
  });
}
