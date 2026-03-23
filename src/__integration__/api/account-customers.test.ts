import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ADMIN_USERNAME,
  authDelete,
  authGet,
  authPost,
  resetRateLimits,
  signIn,
} from "../helpers/auth";
import {
  createTestAccount,
  deleteCustomersByPrefix,
  deleteTestAccount,
  getAccountId,
  getCustomerIdByName,
  removeAccountCustomerAssignments,
  resetAccountDefaults,
  revokeAllSessions,
} from "../helpers/setup-db";

const TEST_PREFIX = "Integ-AC-";
const TENANT_USERNAME = "integ-tenant-ac";
const TENANT_PASSWORD = "TenantAC1234!";
const SECMON_USERNAME = "integ-secmon-ac";
const SECMON_PASSWORD = "SecMon1234!";

describe("Account-customer assignments", () => {
  let adminAccountId: string;
  let tenantAccountId: string;
  let secmonAccountId: string;

  beforeAll(async () => {
    await resetRateLimits();
    await resetAccountDefaults(ADMIN_USERNAME);

    // Clean up previous test data
    await deleteTestAccount(TENANT_USERNAME);
    await deleteTestAccount(SECMON_USERNAME);
    await deleteCustomersByPrefix(TEST_PREFIX);

    // Create test accounts
    await createTestAccount(
      TENANT_USERNAME,
      TENANT_PASSWORD,
      "Tenant Administrator",
    );
    await createTestAccount(
      SECMON_USERNAME,
      SECMON_PASSWORD,
      "Security Monitor",
    );

    adminAccountId = await getAccountId(ADMIN_USERNAME);
    tenantAccountId = await getAccountId(TENANT_USERNAME);
    secmonAccountId = await getAccountId(SECMON_USERNAME);
  });

  beforeEach(async () => {
    await resetRateLimits();
    await revokeAllSessions(ADMIN_USERNAME);
  });

  afterAll(async () => {
    await removeAccountCustomerAssignments(tenantAccountId);
    await removeAccountCustomerAssignments(secmonAccountId);
    await removeAccountCustomerAssignments(adminAccountId);
    await deleteTestAccount(TENANT_USERNAME);
    await deleteTestAccount(SECMON_USERNAME);
    await deleteCustomersByPrefix(TEST_PREFIX);
  });

  // ── API: POST assign ─────────────────────────────────────────

  it("POST assigns customers to an account", async () => {
    const session = await signIn(ADMIN_USERNAME);

    const c1Res = await authPost(session, "/api/customers", {
      name: `${TEST_PREFIX}Assign1`,
    });
    expect(c1Res.status).toBe(201);
    const c1 = (await c1Res.json()).data;

    const c2Res = await authPost(session, "/api/customers", {
      name: `${TEST_PREFIX}Assign2`,
    });
    expect(c2Res.status).toBe(201);
    const c2 = (await c2Res.json()).data;

    // Assign both customers to the tenant account
    const assignRes = await authPost(
      session,
      `/api/accounts/${tenantAccountId}/customers`,
      { customerIds: [c1.id, c2.id] },
    );
    expect(assignRes.status).toBe(201);
    const assignBody = await assignRes.json();
    expect(assignBody.success).toBe(true);
    expect(assignBody.assigned).toContain(c1.id);
    expect(assignBody.assigned).toContain(c2.id);
  });

  // ── API: GET list ─────────────────────────────────────────────

  it("GET lists customer assignments for an account", async () => {
    const session = await signIn(ADMIN_USERNAME);

    const listRes = await authGet(
      session,
      `/api/accounts/${tenantAccountId}/customers`,
    );
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json();
    expect(listBody.data.length).toBeGreaterThanOrEqual(2);

    const names = listBody.data.map(
      (d: { customer_name: string }) => d.customer_name,
    );
    expect(names).toContain(`${TEST_PREFIX}Assign1`);
    expect(names).toContain(`${TEST_PREFIX}Assign2`);
  });

  // ── API: POST idempotent ──────────────────────────────────────

  it("POST is idempotent (ON CONFLICT DO NOTHING)", async () => {
    const session = await signIn(ADMIN_USERNAME);

    const c1Id = await getCustomerIdByName(`${TEST_PREFIX}Assign1`);
    expect(c1Id).not.toBeNull();

    const res = await authPost(
      session,
      `/api/accounts/${tenantAccountId}/customers`,
      { customerIds: [c1Id] },
    );
    expect(res.status).toBe(201);
  });

  // ── API: DELETE unassign ──────────────────────────────────────

  it("DELETE removes a customer assignment", async () => {
    const session = await signIn(ADMIN_USERNAME);

    const c2Id = await getCustomerIdByName(`${TEST_PREFIX}Assign2`);
    expect(c2Id).not.toBeNull();

    const delRes = await authDelete(
      session,
      `/api/accounts/${tenantAccountId}/customers/${c2Id}`,
    );
    expect(delRes.status).toBe(200);
    const delBody = await delRes.json();
    expect(delBody.success).toBe(true);

    // Verify it's gone
    const listRes = await authGet(
      session,
      `/api/accounts/${tenantAccountId}/customers`,
    );
    const listBody = await listRes.json();
    const ids = listBody.data.map(
      (d: { customer_id: number }) => d.customer_id,
    );
    expect(ids).not.toContain(c2Id);
  });

  // ── API: DELETE 404 for non-existent assignment ───────────────

  it("DELETE returns 404 for non-existent assignment", async () => {
    const session = await signIn(ADMIN_USERNAME);

    const res = await authDelete(
      session,
      `/api/accounts/${tenantAccountId}/customers/999999`,
    );
    expect(res.status).toBe(404);
  });

  // ── Security Monitor: single customer constraint ──────────────

  it("Security Monitor cannot be assigned more than 1 customer", async () => {
    const session = await signIn(ADMIN_USERNAME);

    const c1Id = await getCustomerIdByName(`${TEST_PREFIX}Assign1`);
    const c2Id = await getCustomerIdByName(`${TEST_PREFIX}Assign2`);
    expect(c1Id).not.toBeNull();
    expect(c2Id).not.toBeNull();

    // Clean up any existing assignments for secmon
    await removeAccountCustomerAssignments(secmonAccountId);

    // Assign first customer — should succeed
    const res1 = await authPost(
      session,
      `/api/accounts/${secmonAccountId}/customers`,
      { customerIds: [c1Id] },
    );
    expect(res1.status).toBe(201);

    // Assign second customer — should fail
    const res2 = await authPost(
      session,
      `/api/accounts/${secmonAccountId}/customers`,
      { customerIds: [c2Id] },
    );
    expect(res2.status).toBe(400);
    const body = await res2.json();
    expect(body.error).toContain("single customer");
  });

  // ── Security Monitor: assigning 2 at once is rejected ─────────

  it("Security Monitor cannot be assigned 2 customers at once", async () => {
    const session = await signIn(ADMIN_USERNAME);

    const c1Id = await getCustomerIdByName(`${TEST_PREFIX}Assign1`);
    const c2Id = await getCustomerIdByName(`${TEST_PREFIX}Assign2`);

    await removeAccountCustomerAssignments(secmonAccountId);

    const res = await authPost(
      session,
      `/api/accounts/${secmonAccountId}/customers`,
      { customerIds: [c1Id, c2Id] },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("single customer");
  });

  // ── Validation: bad request body ──────────────────────────────

  it("POST returns 400 for empty customerIds array", async () => {
    const session = await signIn(ADMIN_USERNAME);

    const res = await authPost(
      session,
      `/api/accounts/${tenantAccountId}/customers`,
      { customerIds: [] },
    );
    expect(res.status).toBe(400);
  });

  it("POST returns 400 for non-existent customer IDs", async () => {
    const session = await signIn(ADMIN_USERNAME);

    const res = await authPost(
      session,
      `/api/accounts/${tenantAccountId}/customers`,
      { customerIds: [999999] },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("999999");
  });

  it("POST returns 400 for invalid UUID account", async () => {
    const session = await signIn(ADMIN_USERNAME);

    const res = await authPost(session, "/api/accounts/not-a-uuid/customers", {
      customerIds: [1],
    });
    expect(res.status).toBe(400);
  });

  // ── Audit log verification ────────────────────────────────────

  it("customer.assign and customer.unassign appear in audit logs", async () => {
    const session = await signIn(ADMIN_USERNAME);

    const assignRes = await authGet(
      session,
      "/api/audit-logs?action=customer.assign",
    );
    expect(assignRes.status).toBe(200);
    const assignBody = await assignRes.json();
    expect(assignBody.data.length).toBeGreaterThanOrEqual(1);
    expect(assignBody.data[0].action).toBe("customer.assign");
    expect(assignBody.data[0].target_type).toBe("account");

    const unassignRes = await authGet(
      session,
      "/api/audit-logs?action=customer.unassign",
    );
    expect(unassignRes.status).toBe(200);
    const unassignBody = await unassignRes.json();
    expect(unassignBody.data.length).toBeGreaterThanOrEqual(1);
    expect(unassignBody.data[0].action).toBe("customer.unassign");
    expect(unassignBody.data[0].target_type).toBe("account");
  });

  // ── Tenant scope: Tenant Admin access control ─────────────────

  it("Tenant Admin can only see accounts that share their customers", async () => {
    const tenantSession = await signIn(TENANT_USERNAME);

    // Tenant admin viewing their own assignments — should work
    const selfRes = await authGet(
      tenantSession,
      `/api/accounts/${tenantAccountId}/customers`,
    );
    expect(selfRes.status).toBe(200);

    // Tenant admin viewing admin account that has no shared customers — should get 404
    await removeAccountCustomerAssignments(adminAccountId);

    const otherRes = await authGet(
      tenantSession,
      `/api/accounts/${adminAccountId}/customers`,
    );
    expect(otherRes.status).toBe(404);
  });

  it("Tenant Admin cannot assign customers outside their scope", async () => {
    // Create a customer not assigned to tenant (as admin)
    const adminSession = await signIn(ADMIN_USERNAME);

    const outRes = await authPost(adminSession, "/api/customers", {
      name: `${TEST_PREFIX}OutOfScope`,
    });
    expect(outRes.status).toBe(201);
    const outCustomer = (await outRes.json()).data;

    // Sign in as Tenant Admin
    const tenantSession = await signIn(TENANT_USERNAME);

    // Try to assign out-of-scope customer to secmon — should fail
    const res = await authPost(
      tenantSession,
      `/api/accounts/${secmonAccountId}/customers`,
      { customerIds: [outCustomer.id] },
    );
    expect(res.status).toBe(403);
  });

  // ── DELETE with customer linked to account blocks customer delete ──

  it("Cannot delete customer with active account assignments", async () => {
    const session = await signIn(ADMIN_USERNAME);

    // Create a customer and assign it
    const cRes = await authPost(session, "/api/customers", {
      name: `${TEST_PREFIX}Linked`,
    });
    expect(cRes.status).toBe(201);
    const linkedCustomer = (await cRes.json()).data;

    // Assign to tenant account
    const assignRes = await authPost(
      session,
      `/api/accounts/${tenantAccountId}/customers`,
      { customerIds: [linkedCustomer.id] },
    );
    expect(assignRes.status).toBe(201);

    // Try to delete the customer — should fail because it has assignments
    const delRes = await authDelete(
      session,
      `/api/customers/${linkedCustomer.id}`,
    );
    expect(delRes.status).toBe(400);
    const delBody = await delRes.json();
    expect(delBody.error).toContain("active account assignments");
  });
});
