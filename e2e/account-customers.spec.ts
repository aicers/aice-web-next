import { expect, test } from "@playwright/test";

import {
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  resetRateLimits,
  signInAndWait,
} from "./helpers/auth";
import {
  clearMustChangePassword,
  createTestAccount,
  deleteCustomersByPrefix,
  deleteTestAccount,
  getAccountId,
  getCustomerIdByName,
  removeAccountCustomerAssignments,
  resetAccountDefaults,
  revokeAllSessions,
} from "./helpers/setup-db";

const TEST_PREFIX = "E2E-AC-";
const TENANT_USERNAME = "e2e-tenant-ac";
const TENANT_PASSWORD = "TenantAC1234!";
const SECMON_USERNAME = "e2e-secmon-ac";
const SECMON_PASSWORD = "SecMon1234!";

// ── Helpers ─────────────────────────────────────────────────────

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";

async function getCsrf(page: import("@playwright/test").Page): Promise<string> {
  const cookies = await page.context().cookies();
  return cookies.find((c) => c.name === "csrf")?.value ?? "";
}

function mutationHeaders(csrf: string) {
  return { "x-csrf-token": csrf, Origin: BASE_URL };
}

// ── Setup / Teardown ────────────────────────────────────────────

test.describe("Account-customer assignments", () => {
  let adminAccountId: string;
  let tenantAccountId: string;
  let secmonAccountId: string;

  test.beforeAll(async () => {
    await resetRateLimits();
    await clearMustChangePassword(ADMIN_USERNAME);
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

  test.beforeEach(async () => {
    await resetRateLimits();
    await revokeAllSessions(ADMIN_USERNAME);
  });

  test.afterAll(async () => {
    await removeAccountCustomerAssignments(tenantAccountId);
    await removeAccountCustomerAssignments(secmonAccountId);
    await removeAccountCustomerAssignments(adminAccountId);
    await deleteTestAccount(TENANT_USERNAME);
    await deleteTestAccount(SECMON_USERNAME);
    await deleteCustomersByPrefix(TEST_PREFIX);
  });

  // ── API: POST assign ─────────────────────────────────────────

  test("POST assigns customers to an account", async ({ page }) => {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);

    // Create test customers
    const csrf = await getCsrf(page);
    const headers = mutationHeaders(csrf);

    const c1Res = await page.request.post("/api/customers", {
      data: { name: `${TEST_PREFIX}Assign1` },
      headers,
    });
    expect(c1Res.status()).toBe(201);
    const c1 = (await c1Res.json()).data;

    const c2Res = await page.request.post("/api/customers", {
      data: { name: `${TEST_PREFIX}Assign2` },
      headers,
    });
    expect(c2Res.status()).toBe(201);
    const c2 = (await c2Res.json()).data;

    // Assign both customers to the tenant account
    const assignRes = await page.request.post(
      `/api/accounts/${tenantAccountId}/customers`,
      {
        data: { customerIds: [c1.id, c2.id] },
        headers,
      },
    );
    expect(assignRes.status()).toBe(201);
    const assignBody = await assignRes.json();
    expect(assignBody.success).toBe(true);
    expect(assignBody.assigned).toContain(c1.id);
    expect(assignBody.assigned).toContain(c2.id);
  });

  // ── API: GET list ─────────────────────────────────────────────

  test("GET lists customer assignments for an account", async ({ page }) => {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);

    const listRes = await page.request.get(
      `/api/accounts/${tenantAccountId}/customers`,
    );
    expect(listRes.status()).toBe(200);
    const listBody = await listRes.json();
    expect(listBody.data.length).toBeGreaterThanOrEqual(2);

    const names = listBody.data.map(
      (d: { customer_name: string }) => d.customer_name,
    );
    expect(names).toContain(`${TEST_PREFIX}Assign1`);
    expect(names).toContain(`${TEST_PREFIX}Assign2`);
  });

  // ── API: POST idempotent ──────────────────────────────────────

  test("POST is idempotent (ON CONFLICT DO NOTHING)", async ({ page }) => {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);

    const csrf = await getCsrf(page);
    const headers = mutationHeaders(csrf);

    const c1Id = await getCustomerIdByName(`${TEST_PREFIX}Assign1`);
    expect(c1Id).not.toBeNull();

    // Re-assign the same customer — should succeed without error
    const res = await page.request.post(
      `/api/accounts/${tenantAccountId}/customers`,
      {
        data: { customerIds: [c1Id] },
        headers,
      },
    );
    expect(res.status()).toBe(201);
  });

  // ── API: DELETE unassign ──────────────────────────────────────

  test("DELETE removes a customer assignment", async ({ page }) => {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);

    const csrf = await getCsrf(page);
    const headers = mutationHeaders(csrf);

    const c2Id = await getCustomerIdByName(`${TEST_PREFIX}Assign2`);
    expect(c2Id).not.toBeNull();

    const delRes = await page.request.delete(
      `/api/accounts/${tenantAccountId}/customers/${c2Id}`,
      { headers },
    );
    expect(delRes.status()).toBe(200);
    const delBody = await delRes.json();
    expect(delBody.success).toBe(true);

    // Verify it's gone
    const listRes = await page.request.get(
      `/api/accounts/${tenantAccountId}/customers`,
    );
    const listBody = await listRes.json();
    const ids = listBody.data.map(
      (d: { customer_id: number }) => d.customer_id,
    );
    expect(ids).not.toContain(c2Id);
  });

  // ── API: DELETE 404 for non-existent assignment ───────────────

  test("DELETE returns 404 for non-existent assignment", async ({ page }) => {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);

    const csrf = await getCsrf(page);
    const headers = mutationHeaders(csrf);

    const res = await page.request.delete(
      `/api/accounts/${tenantAccountId}/customers/999999`,
      { headers },
    );
    expect(res.status()).toBe(404);
  });

  // ── Security Monitor: single customer constraint ──────────────

  test("Security Monitor cannot be assigned more than 1 customer", async ({
    page,
  }) => {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);

    const csrf = await getCsrf(page);
    const headers = mutationHeaders(csrf);

    const c1Id = await getCustomerIdByName(`${TEST_PREFIX}Assign1`);
    const c2Id = await getCustomerIdByName(`${TEST_PREFIX}Assign2`);
    expect(c1Id).not.toBeNull();
    expect(c2Id).not.toBeNull();

    // Clean up any existing assignments for secmon
    await removeAccountCustomerAssignments(secmonAccountId);

    // Assign first customer — should succeed
    const res1 = await page.request.post(
      `/api/accounts/${secmonAccountId}/customers`,
      {
        data: { customerIds: [c1Id] },
        headers,
      },
    );
    expect(res1.status()).toBe(201);

    // Assign second customer — should fail
    const res2 = await page.request.post(
      `/api/accounts/${secmonAccountId}/customers`,
      {
        data: { customerIds: [c2Id] },
        headers,
      },
    );
    expect(res2.status()).toBe(400);
    const body = await res2.json();
    expect(body.error).toContain("single customer");
  });

  // ── Security Monitor: assigning 2 at once is rejected ─────────

  test("Security Monitor cannot be assigned 2 customers at once", async ({
    page,
  }) => {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);

    const csrf = await getCsrf(page);
    const headers = mutationHeaders(csrf);

    const c1Id = await getCustomerIdByName(`${TEST_PREFIX}Assign1`);
    const c2Id = await getCustomerIdByName(`${TEST_PREFIX}Assign2`);

    // Clean assignments
    await removeAccountCustomerAssignments(secmonAccountId);

    const res = await page.request.post(
      `/api/accounts/${secmonAccountId}/customers`,
      {
        data: { customerIds: [c1Id, c2Id] },
        headers,
      },
    );
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("single customer");
  });

  // ── Validation: bad request body ──────────────────────────────

  test("POST returns 400 for empty customerIds array", async ({ page }) => {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);

    const csrf = await getCsrf(page);
    const headers = mutationHeaders(csrf);

    const res = await page.request.post(
      `/api/accounts/${tenantAccountId}/customers`,
      {
        data: { customerIds: [] },
        headers,
      },
    );
    expect(res.status()).toBe(400);
  });

  test("POST returns 400 for non-existent customer IDs", async ({ page }) => {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);

    const csrf = await getCsrf(page);
    const headers = mutationHeaders(csrf);

    const res = await page.request.post(
      `/api/accounts/${tenantAccountId}/customers`,
      {
        data: { customerIds: [999999] },
        headers,
      },
    );
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("999999");
  });

  test("POST returns 400 for invalid UUID account", async ({ page }) => {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);

    const csrf = await getCsrf(page);
    const headers = mutationHeaders(csrf);

    const res = await page.request.post("/api/accounts/not-a-uuid/customers", {
      data: { customerIds: [1] },
      headers,
    });
    expect(res.status()).toBe(400);
  });

  // ── Audit log verification ────────────────────────────────────

  test("customer.assign and customer.unassign appear in audit logs", async ({
    page,
  }) => {
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);

    // Check audit logs for customer.assign
    const assignRes = await page.request.get(
      "/api/audit-logs?action=customer.assign",
    );
    expect(assignRes.status()).toBe(200);
    const assignBody = await assignRes.json();
    expect(assignBody.data.length).toBeGreaterThanOrEqual(1);
    expect(assignBody.data[0].action).toBe("customer.assign");
    expect(assignBody.data[0].target_type).toBe("account");

    // Check audit logs for customer.unassign
    const unassignRes = await page.request.get(
      "/api/audit-logs?action=customer.unassign",
    );
    expect(unassignRes.status()).toBe(200);
    const unassignBody = await unassignRes.json();
    expect(unassignBody.data.length).toBeGreaterThanOrEqual(1);
    expect(unassignBody.data[0].action).toBe("customer.unassign");
    expect(unassignBody.data[0].target_type).toBe("account");
  });

  // ── Tenant scope: Tenant Admin access control ─────────────────

  test("Tenant Admin can only see accounts that share their customers", async ({
    page,
  }) => {
    // Sign in as Tenant Admin
    await revokeAllSessions(TENANT_USERNAME);
    await clearMustChangePassword(TENANT_USERNAME);
    await signInAndWait(page, TENANT_USERNAME, TENANT_PASSWORD);

    // Tenant admin viewing their own assignments — should work
    const selfRes = await page.request.get(
      `/api/accounts/${tenantAccountId}/customers`,
    );
    expect(selfRes.status()).toBe(200);

    // Tenant admin viewing admin account that has no shared customers — should get 404
    // First ensure admin has no overlapping customers
    await removeAccountCustomerAssignments(adminAccountId);

    const otherRes = await page.request.get(
      `/api/accounts/${adminAccountId}/customers`,
    );
    expect(otherRes.status()).toBe(404);
  });

  test("Tenant Admin cannot assign customers outside their scope", async ({
    page,
  }) => {
    // Create a customer not assigned to tenant
    await revokeAllSessions(ADMIN_USERNAME);
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);

    const csrf = await getCsrf(page);
    const headers = mutationHeaders(csrf);

    const outRes = await page.request.post("/api/customers", {
      data: { name: `${TEST_PREFIX}OutOfScope` },
      headers,
    });
    expect(outRes.status()).toBe(201);
    const outCustomer = (await outRes.json()).data;

    // Sign in as Tenant Admin
    await revokeAllSessions(TENANT_USERNAME);
    await clearMustChangePassword(TENANT_USERNAME);
    await signInAndWait(page, TENANT_USERNAME, TENANT_PASSWORD);

    const tenantCsrf = await getCsrf(page);
    const tenantHeaders = mutationHeaders(tenantCsrf);

    // Try to assign out-of-scope customer to secmon — should fail
    const res = await page.request.post(
      `/api/accounts/${secmonAccountId}/customers`,
      {
        data: { customerIds: [outCustomer.id] },
        headers: tenantHeaders,
      },
    );
    expect(res.status()).toBe(403);
  });

  // ── DELETE with customer linked to account blocks customer delete ──

  test("Cannot delete customer with active account assignments", async ({
    page,
  }) => {
    await revokeAllSessions(ADMIN_USERNAME);
    await signInAndWait(page, ADMIN_USERNAME, ADMIN_PASSWORD);

    const csrf = await getCsrf(page);
    const headers = mutationHeaders(csrf);

    // Create a customer and assign it
    const cRes = await page.request.post("/api/customers", {
      data: { name: `${TEST_PREFIX}Linked` },
      headers,
    });
    expect(cRes.status()).toBe(201);
    const linkedCustomer = (await cRes.json()).data;

    // Assign to tenant account
    const assignRes = await page.request.post(
      `/api/accounts/${tenantAccountId}/customers`,
      {
        data: { customerIds: [linkedCustomer.id] },
        headers,
      },
    );
    expect(assignRes.status()).toBe(201);

    // Try to delete the customer — should fail because it has assignments
    const delRes = await page.request.delete(
      `/api/customers/${linkedCustomer.id}`,
      { headers },
    );
    expect(delRes.status()).toBe(400);
    const delBody = await delRes.json();
    expect(delBody.error).toContain("active account assignments");
  });
});
