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
  deleteCustomersByPrefix,
  resetAccountDefaults,
  revokeAllSessions,
} from "../helpers/setup-db";

const TEST_PREFIX = "Integ-Cust-";

describe("Customer management API", () => {
  beforeAll(async () => {
    await resetRateLimits();
    await resetAccountDefaults(ADMIN_USERNAME);
    await deleteCustomersByPrefix(TEST_PREFIX);
  });

  beforeEach(async () => {
    await resetRateLimits();
    await revokeAllSessions(ADMIN_USERNAME);
  });

  afterAll(async () => {
    await deleteCustomersByPrefix(TEST_PREFIX);
  });

  it("POST /api/customers creates a customer", async () => {
    const session = await signIn(ADMIN_USERNAME);

    const response = await authPost(session, "/api/customers", {
      name: `${TEST_PREFIX}Alpha`,
      description: "Test customer",
    });

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.data.name).toBe(`${TEST_PREFIX}Alpha`);
    expect(body.data.status).toBe("active");
    expect(body.data.database_name).toContain("customer_");
  });

  it("GET /api/customers lists customers", async () => {
    const session = await signIn(ADMIN_USERNAME);

    const response = await authGet(session, "/api/customers");
    expect(response.status).toBe(200);

    const body = await response.json();
    const testCustomers = body.data.filter((c: { name: string }) =>
      c.name.startsWith(TEST_PREFIX),
    );
    expect(testCustomers.length).toBeGreaterThanOrEqual(1);
  });

  it("PATCH /api/customers/[id] updates a customer", async () => {
    const session = await signIn(ADMIN_USERNAME);

    // Get customer ID
    const listRes = await authGet(session, "/api/customers");
    const listBody = await listRes.json();
    const customer = listBody.data.find(
      (c: { name: string }) => c.name === `${TEST_PREFIX}Alpha`,
    );
    expect(customer).toBeDefined();

    const response = await authPatch(session, `/api/customers/${customer.id}`, {
      name: `${TEST_PREFIX}Alpha-Updated`,
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.name).toBe(`${TEST_PREFIX}Alpha-Updated`);
  });

  it("DELETE /api/customers/[id] deletes a customer", async () => {
    const session = await signIn(ADMIN_USERNAME);

    // Get customer ID
    const listRes = await authGet(session, "/api/customers");
    const listBody = await listRes.json();
    const customer = listBody.data.find(
      (c: { name: string }) => c.name === `${TEST_PREFIX}Alpha-Updated`,
    );
    expect(customer).toBeDefined();

    const response = await authDelete(session, `/api/customers/${customer.id}`);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);

    // Verify it's gone
    const verifyRes = await authGet(session, `/api/customers/${customer.id}`);
    expect(verifyRes.status).toBe(404);
  });

  it("POST /api/customers returns 400 for missing name", async () => {
    const session = await signIn(ADMIN_USERNAME);

    const response = await authPost(session, "/api/customers", {});

    expect(response.status).toBe(400);
  });

  // ── Audit log verification ────────────────────────────────────

  it("customer audit events are visible in audit logs", async () => {
    const session = await signIn(ADMIN_USERNAME);

    // Create a customer so we have a fresh audit event
    await authPost(session, "/api/customers", {
      name: `${TEST_PREFIX}AuditCheck`,
    });

    // Check audit logs API for customer.create
    const auditRes = await authGet(
      session,
      "/api/audit-logs?action=customer.create",
    );
    expect(auditRes.status).toBe(200);
    const auditBody = await auditRes.json();
    expect(auditBody.data.length).toBeGreaterThanOrEqual(1);
    expect(auditBody.data[0].target_type).toBe("customer");
  });
});
