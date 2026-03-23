import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ADMIN_USERNAME,
  authDelete,
  authGet,
  authPatch,
  authPost,
  resetRateLimits,
  signIn,
} from "../helpers/auth";
import {
  createTestAccount,
  createTestRole,
  deleteRolesByPrefix,
  deleteTestAccount,
  deleteTestRole,
  resetAccountDefaults,
  revokeAllSessions,
} from "../helpers/setup-db";

const TEST_PREFIX = "integ-role-";

describe("Role management API", () => {
  beforeAll(async () => {
    await resetRateLimits();
    await resetAccountDefaults(ADMIN_USERNAME);
    await deleteTestAccount(`${TEST_PREFIX}secmon`);
    await deleteRolesByPrefix(TEST_PREFIX);
  });

  beforeEach(async () => {
    await resetRateLimits();
    await revokeAllSessions(ADMIN_USERNAME);
  });

  afterAll(async () => {
    await deleteTestAccount(`${TEST_PREFIX}secmon`);
    await deleteRolesByPrefix(TEST_PREFIX);
  });

  // ── CRUD ──────────────────────────────────────────────────────

  it("GET /api/roles returns all roles", async () => {
    const session = await signIn(ADMIN_USERNAME);

    const response = await authGet(session, "/api/roles");
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.data.length).toBeGreaterThanOrEqual(3);

    const names = body.data.map((r: { name: string }) => r.name);
    expect(names).toContain("System Administrator");
    expect(names).toContain("Tenant Administrator");
    expect(names).toContain("Security Monitor");
  });

  it("POST /api/roles creates a custom role", async () => {
    await deleteTestRole(`${TEST_PREFIX}api-create`);
    const session = await signIn(ADMIN_USERNAME);

    const response = await authPost(session, "/api/roles", {
      name: `${TEST_PREFIX}api-create`,
      description: "Integration test role",
      permissions: ["accounts:read", "customers:read"],
    });

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.data.name).toBe(`${TEST_PREFIX}api-create`);
    expect(body.data.permissions).toContain("accounts:read");
    expect(body.data.permissions).toContain("customers:read");
  });

  it("PATCH /api/roles/[id] updates a custom role", async () => {
    const roleId = await createTestRole(
      `${TEST_PREFIX}api-update`,
      ["accounts:read"],
      "before update",
    );

    const session = await signIn(ADMIN_USERNAME);

    const response = await authPatch(session, `/api/roles/${roleId}`, {
      name: `${TEST_PREFIX}api-update`,
      permissions: ["accounts:read", "accounts:write", "roles:read"],
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.permissions).toHaveLength(3);
    expect(body.data.permissions).toContain("accounts:write");
  });

  it("PATCH /api/roles/[id] rejects built-in role modification", async () => {
    const session = await signIn(ADMIN_USERNAME);

    const response = await authPatch(session, "/api/roles/1", {
      name: "Hacked",
      permissions: [],
    });

    expect(response.status).toBe(403);
  });

  it("DELETE /api/roles/[id] deletes a custom role", async () => {
    const roleId = await createTestRole(`${TEST_PREFIX}api-delete`, [
      "accounts:read",
    ]);

    const session = await signIn(ADMIN_USERNAME);

    const response = await authDelete(session, `/api/roles/${roleId}`);
    expect(response.status).toBe(200);

    // Verify role is gone
    const listRes = await authGet(session, "/api/roles");
    const listBody = await listRes.json();
    const names = listBody.data.map((r: { name: string }) => r.name);
    expect(names).not.toContain(`${TEST_PREFIX}api-delete`);
  });

  it("DELETE /api/roles/[id] rejects built-in role deletion", async () => {
    const session = await signIn(ADMIN_USERNAME);

    const response = await authDelete(session, "/api/roles/1");
    expect(response.status).toBe(403);
  });

  it("DELETE /api/roles/[id] rejects deletion of role in use", async () => {
    const roleId = await createTestRole(`${TEST_PREFIX}in-use`, [
      "accounts:read",
    ]);
    await createTestAccount(
      `${TEST_PREFIX}secmon`,
      "TestPass1234!",
      `${TEST_PREFIX}in-use`,
    );

    const session = await signIn(ADMIN_USERNAME);

    const response = await authDelete(session, `/api/roles/${roleId}`);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toMatch(/assigned to accounts/i);

    await deleteTestAccount(`${TEST_PREFIX}secmon`);
  });

  // ── Validation ────────────────────────────────────────────────

  it("POST /api/roles returns 400 for invalid permissions", async () => {
    const session = await signIn(ADMIN_USERNAME);

    const response = await authPost(session, "/api/roles", {
      name: `${TEST_PREFIX}bad-perms`,
      permissions: ["nonexistent:perm"],
    });

    expect(response.status).toBe(400);
  });

  it("POST /api/roles returns 400 for duplicate name", async () => {
    await createTestRole(`${TEST_PREFIX}dup`, ["accounts:read"]);

    const session = await signIn(ADMIN_USERNAME);

    const response = await authPost(session, "/api/roles", {
      name: `${TEST_PREFIX}dup`,
      permissions: ["accounts:read"],
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    const errorText = JSON.stringify(body);
    expect(errorText).toMatch(/already exists/i);
  });

  // ── RBAC ──────────────────────────────────────────────────────

  it("Security Monitor cannot modify roles", async () => {
    const secMonUser = `${TEST_PREFIX}rbac`;
    const secMonPass = "SecMon1234!";
    await createTestAccount(secMonUser, secMonPass, "Security Monitor");

    try {
      const session = await signIn(secMonUser);

      // GET returns minimal data without roles:read
      const getRes = await authGet(session, "/api/roles");
      expect(getRes.status).toBe(200);
      const getBody = await getRes.json();
      expect(getBody.data[0]).toHaveProperty("name");
      expect(getBody.data[0]).not.toHaveProperty("permissions");
      expect(getBody.data[0]).not.toHaveProperty("account_count");

      const postRes = await authPost(session, "/api/roles", {
        name: "hacked",
        permissions: [],
      });
      expect(postRes.status).toBe(403);
    } finally {
      await deleteTestAccount(secMonUser);
    }
  });

  it("Security Monitor cannot create roles", async () => {
    const secMonUser = `${TEST_PREFIX}rbac-write`;
    const secMonPass = "SecMon1234!";
    await createTestAccount(secMonUser, secMonPass, "Security Monitor");

    try {
      const session = await signIn(secMonUser);

      const response = await authPost(session, "/api/roles", {
        name: `${TEST_PREFIX}rbac-attempt`,
        permissions: ["accounts:read"],
      });

      expect(response.status).toBe(403);
    } finally {
      await deleteTestAccount(secMonUser);
    }
  });

  // ── Audit ─────────────────────────────────────────────────────

  it("role audit events are visible in audit logs", async () => {
    const session = await signIn(ADMIN_USERNAME);

    const auditRes = await authGet(
      session,
      "/api/audit-logs?action=role.create",
    );
    expect(auditRes.status).toBe(200);
    const auditBody = await auditRes.json();
    expect(auditBody.data.length).toBeGreaterThanOrEqual(1);
    expect(auditBody.data[0].target_type).toBe("role");
  });
});
