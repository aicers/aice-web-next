import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ADMIN_USERNAME,
  authGet,
  resetRateLimits,
  signIn,
} from "../helpers/auth";
import {
  assignCustomerToAccount,
  createCustomerRow,
  createTestAccount,
  createTestRole,
  deleteAuditLogById,
  deleteCustomersByPrefix,
  deleteRolesByPrefix,
  deleteTestAccount,
  deleteTestRole,
  getAccountId,
  insertAuditLog,
  removeAccountCustomerAssignments,
  resetAccountDefaults,
  revokeAllSessions,
} from "../helpers/setup-db";

// ── Fixtures ───────────────────────────────────────────────────

const TEST_PREFIX = "Integ-AL-";
const ROLE_NAME = "integ-al-auditor";

const ACCOUNT_A_USERNAME = "integ-al-account-a";
const ACCOUNT_B_USERNAME = "integ-al-account-b";
const EMPTY_USERNAME = "integ-al-empty";
const ALL_ASSIGNED_USERNAME = "integ-al-all-assigned";

const COMMON_PASSWORD = "AuditViewer1234!";

interface AuditLogResponse {
  data: Array<{
    id: string;
    actor_id: string;
    customer_id: number | null;
    action: string;
  }>;
  total: number;
  page: number;
  pageSize: number;
}

interface SeededIds {
  customerARowId: string;
  customerBRowId: string;
  nullCustomerRowId: string;
}

describe("Audit logs viewer scoping", () => {
  let customerAId: number;
  let customerBId: number;
  let seeded: SeededIds;

  beforeAll(async () => {
    await resetRateLimits();
    await resetAccountDefaults(ADMIN_USERNAME);

    // Clean up any leftover state from prior runs.
    await deleteTestAccount(ACCOUNT_A_USERNAME);
    await deleteTestAccount(ACCOUNT_B_USERNAME);
    await deleteTestAccount(EMPTY_USERNAME);
    await deleteTestAccount(ALL_ASSIGNED_USERNAME);
    await deleteTestRole(ROLE_NAME);
    await deleteRolesByPrefix("integ-al-");
    await deleteCustomersByPrefix(TEST_PREFIX);

    // Custom role: audit-logs:read but NOT customers:access-all.
    await createTestRole(
      ROLE_NAME,
      ["audit-logs:read"],
      "Integration test auditor (scoped)",
    );

    // Test customers (rows only, no provisioned database).
    customerAId = await createCustomerRow(`${TEST_PREFIX}CustomerA`);
    customerBId = await createCustomerRow(`${TEST_PREFIX}CustomerB`);

    // Test accounts.
    await createTestAccount(ACCOUNT_A_USERNAME, COMMON_PASSWORD, ROLE_NAME);
    await createTestAccount(ACCOUNT_B_USERNAME, COMMON_PASSWORD, ROLE_NAME);
    await createTestAccount(EMPTY_USERNAME, COMMON_PASSWORD, ROLE_NAME);
    await createTestAccount(ALL_ASSIGNED_USERNAME, COMMON_PASSWORD, ROLE_NAME);

    const accountAId = await getAccountId(ACCOUNT_A_USERNAME);
    const accountBId = await getAccountId(ACCOUNT_B_USERNAME);
    const allAssignedId = await getAccountId(ALL_ASSIGNED_USERNAME);

    await assignCustomerToAccount(accountAId, customerAId);
    await assignCustomerToAccount(accountBId, customerBId);

    // The "all-assigned" account is linked to every test customer but
    // does not hold customers:access-all — proves the predicate is
    // applied even when the assignment list happens to cover every
    // customer.
    await assignCustomerToAccount(allAssignedId, customerAId);
    await assignCustomerToAccount(allAssignedId, customerBId);

    // Seed three audit rows: one per customer plus one customer-agnostic.
    seeded = {
      customerARowId: await insertAuditLog({
        actorId: accountAId,
        action: "customer.assign",
        targetType: "account",
        targetId: accountAId,
        customerId: customerAId,
      }),
      customerBRowId: await insertAuditLog({
        actorId: accountBId,
        action: "customer.assign",
        targetType: "account",
        targetId: accountBId,
        customerId: customerBId,
      }),
      nullCustomerRowId: await insertAuditLog({
        actorId: "system",
        action: "account.login",
        targetType: "account",
        targetId: accountAId,
        customerId: null,
      }),
    };
  });

  beforeEach(async () => {
    await resetRateLimits();
    await revokeAllSessions(ADMIN_USERNAME);
    await revokeAllSessions(ACCOUNT_A_USERNAME);
    await revokeAllSessions(ACCOUNT_B_USERNAME);
    await revokeAllSessions(EMPTY_USERNAME);
    await revokeAllSessions(ALL_ASSIGNED_USERNAME);
  });

  afterAll(async () => {
    await deleteAuditLogById(seeded.customerARowId);
    await deleteAuditLogById(seeded.customerBRowId);
    await deleteAuditLogById(seeded.nullCustomerRowId);

    const accounts = [
      ACCOUNT_A_USERNAME,
      ACCOUNT_B_USERNAME,
      EMPTY_USERNAME,
      ALL_ASSIGNED_USERNAME,
    ];
    for (const username of accounts) {
      const id = await getAccountId(username).catch(() => null);
      if (id) await removeAccountCustomerAssignments(id);
      await deleteTestAccount(username);
    }
    await deleteTestRole(ROLE_NAME);
    await deleteCustomersByPrefix(TEST_PREFIX);
  });

  // ── Restricted scope: only own customer's rows ───────────────

  it("account-A sees only customer-A rows (NULL and B excluded)", async () => {
    const session = await signIn(ACCOUNT_A_USERNAME);

    const response = await authGet(session, "/api/audit-logs?pageSize=100");
    expect(response.status).toBe(200);

    const body = (await response.json()) as AuditLogResponse;
    const ids = body.data.map((r) => r.id);
    const customerIds = new Set(body.data.map((r) => r.customer_id));

    expect(ids).toContain(seeded.customerARowId);
    expect(ids).not.toContain(seeded.customerBRowId);
    expect(ids).not.toContain(seeded.nullCustomerRowId);
    expect(customerIds).toEqual(new Set([customerAId]));
    expect(body.total).toBe(body.data.length);
  });

  it("account-B sees only customer-B rows", async () => {
    const session = await signIn(ACCOUNT_B_USERNAME);

    const response = await authGet(session, "/api/audit-logs?pageSize=100");
    expect(response.status).toBe(200);

    const body = (await response.json()) as AuditLogResponse;
    const ids = body.data.map((r) => r.id);
    const customerIds = new Set(body.data.map((r) => r.customer_id));

    expect(ids).toContain(seeded.customerBRowId);
    expect(ids).not.toContain(seeded.customerARowId);
    expect(ids).not.toContain(seeded.nullCustomerRowId);
    expect(customerIds).toEqual(new Set([customerBId]));
    expect(body.total).toBe(body.data.length);
  });

  // ── Admin: sees everything ───────────────────────────────────

  it("admin sees all rows including the customer-agnostic NULL row", async () => {
    const session = await signIn(ADMIN_USERNAME);

    const response = await authGet(session, "/api/audit-logs?pageSize=100");
    expect(response.status).toBe(200);

    const body = (await response.json()) as AuditLogResponse;
    const ids = body.data.map((r) => r.id);

    expect(ids).toContain(seeded.customerARowId);
    expect(ids).toContain(seeded.customerBRowId);
    expect(ids).toContain(seeded.nullCustomerRowId);
  });

  // ── Empty scope: empty result, not admin fallback ─────────────

  it("empty-scope account gets an empty result set", async () => {
    const session = await signIn(EMPTY_USERNAME);

    const response = await authGet(session, "/api/audit-logs?pageSize=100");
    expect(response.status).toBe(200);

    const body = (await response.json()) as AuditLogResponse;
    expect(body.data).toEqual([]);
    expect(body.total).toBe(0);
  });

  // ── All-assigned but not admin: predicate still applied ───────

  it("all-customers-assigned non-admin still excludes NULL customer rows", async () => {
    const session = await signIn(ALL_ASSIGNED_USERNAME);

    const response = await authGet(session, "/api/audit-logs?pageSize=100");
    expect(response.status).toBe(200);

    const body = (await response.json()) as AuditLogResponse;
    const ids = body.data.map((r) => r.id);

    // Sees both A and B rows because assigned to both.
    expect(ids).toContain(seeded.customerARowId);
    expect(ids).toContain(seeded.customerBRowId);

    // Critically — NULL-customer rows must NOT leak via "all assigned
    // ⇒ admin-like" inference.
    expect(ids).not.toContain(seeded.nullCustomerRowId);
    for (const row of body.data) {
      expect(row.customer_id).not.toBeNull();
    }
  });
});
