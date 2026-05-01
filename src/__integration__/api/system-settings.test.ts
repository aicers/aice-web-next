import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ADMIN_USERNAME,
  authGet,
  authPatch,
  resetRateLimits,
  signIn,
} from "../helpers/auth";
import {
  createTestAccount,
  createTestRole,
  deleteTestAccount,
  deleteTestRole,
  resetAccountDefaults,
} from "../helpers/setup-db";

const READER_USER = "integ-settings-reader";
const READER_PASS = "Reader1234!";
const READER_ROLE = "Integ Settings Reader";

describe("System settings API", () => {
  beforeAll(async () => {
    await resetRateLimits();
    await createTestRole(READER_ROLE, ["system-settings:read"]);
    await createTestAccount(READER_USER, READER_PASS, READER_ROLE);
  });

  beforeEach(async () => {
    await resetRateLimits();
    await resetAccountDefaults(ADMIN_USERNAME);
  });

  afterAll(async () => {
    await deleteTestAccount(READER_USER);
    await deleteTestRole(READER_ROLE);
  });

  it("GET /api/system-settings returns all settings", async () => {
    const session = await signIn(ADMIN_USERNAME);
    const res = await authGet(session, "/api/system-settings");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data).toBeDefined();
    expect(Array.isArray(body.data)).toBe(true);

    const keys = body.data.map((s: { key: string }) => s.key);
    expect(keys).toContain("password_policy");
    expect(keys).toContain("session_policy");
    expect(keys).toContain("lockout_policy");
    expect(keys).toContain("jwt_policy");
    expect(keys).toContain("mfa_policy");
  });

  it("GET /api/system-settings returns 403 without permission", async () => {
    await createTestRole("Integ No Perms", []);
    await createTestAccount("integ-noperm", "NoPerm1234!", "Integ No Perms");
    try {
      const session = await signIn("integ-noperm");
      const res = await authGet(session, "/api/system-settings");
      expect(res.status).toBe(403);
    } finally {
      await deleteTestAccount("integ-noperm");
      await deleteTestRole("Integ No Perms");
    }
  });

  it("PATCH /api/system-settings/[key] updates a setting", async () => {
    const session = await signIn(ADMIN_USERNAME);

    // Read current value first
    const getRes = await authGet(session, "/api/system-settings");
    const allSettings = await getRes.json();
    const jwtSetting = allSettings.data.find(
      (s: { key: string }) => s.key === "jwt_policy",
    );
    const originalValue = jwtSetting.value.access_token_expiration_minutes;

    const newValue = originalValue === 15 ? 20 : 15;
    try {
      const patchRes = await authPatch(
        session,
        "/api/system-settings/jwt_policy",
        { value: { access_token_expiration_minutes: newValue } },
      );
      expect(patchRes.status).toBe(200);

      // Verify the update persisted
      const verifyRes = await authGet(session, "/api/system-settings");
      const updated = await verifyRes.json();
      const updatedJwt = updated.data.find(
        (s: { key: string }) => s.key === "jwt_policy",
      );
      expect(updatedJwt.value.access_token_expiration_minutes).toBe(newValue);
    } finally {
      await authPatch(session, "/api/system-settings/jwt_policy", {
        value: { access_token_expiration_minutes: originalValue },
      });
    }
  });

  it("PATCH rejects invalid values with 400", async () => {
    const session = await signIn(ADMIN_USERNAME);

    const res = await authPatch(
      session,
      "/api/system-settings/password_policy",
      { value: { min_length: 3 } },
    );
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it("PATCH rejects unknown setting key with 400", async () => {
    const session = await signIn(ADMIN_USERNAME);

    const res = await authPatch(
      session,
      "/api/system-settings/nonexistent_key",
      { value: { foo: "bar" } },
    );
    expect(res.status).toBe(400);
  });

  it("PATCH requires system-settings:write permission", async () => {
    await resetAccountDefaults(READER_USER);
    const session = await signIn(READER_USER);

    const res = await authPatch(session, "/api/system-settings/jwt_policy", {
      value: { access_token_expiration_minutes: 10 },
    });
    expect(res.status).toBe(403);
  });

  // ── Audit verification ──────────────────────────────────────────

  it("settings update appears in audit logs", async () => {
    const session = await signIn(ADMIN_USERNAME);

    // Record newest audit log ID before change
    const beforeRes = await authGet(
      session,
      "/api/audit-logs?action=system_settings.update&targetId=lockout_policy&pageSize=1",
    );
    const beforeBody = await beforeRes.json();
    const newestIdBefore =
      beforeBody.data.length > 0 ? beforeBody.data[0].id : null;

    // Read current lockout policy and toggle a value
    const getRes = await authGet(session, "/api/system-settings");
    const allSettings = await getRes.json();
    const lockoutSetting = allSettings.data.find(
      (s: { key: string }) => s.key === "lockout_policy",
    );
    const originalValue = { ...lockoutSetting.value };
    const updatedValue = {
      ...originalValue,
      stage1_threshold: originalValue.stage1_threshold === 5 ? 6 : 5,
    };

    try {
      const patchRes = await authPatch(
        session,
        "/api/system-settings/lockout_policy",
        { value: updatedValue },
      );
      expect(patchRes.status).toBe(200);

      const afterRes = await authGet(
        session,
        "/api/audit-logs?action=system_settings.update&targetId=lockout_policy&pageSize=1",
      );
      expect(afterRes.status).toBe(200);
      const afterBody = await afterRes.json();
      expect(afterBody.data.length).toBeGreaterThan(0);

      const newest = afterBody.data[0];
      expect(newest.id).not.toBe(newestIdBefore);
      expect(newest.action).toBe("system_settings.update");
      expect(newest.target_id).toBe("lockout_policy");
    } finally {
      await authPatch(session, "/api/system-settings/lockout_policy", {
        value: originalValue,
      });
    }
  });
});
