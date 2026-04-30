/**
 * Cross-customer isolation matrix.
 *
 * One file, one fixture, one row per endpoint. Adding a new
 * customer-scoped endpoint after this PR is a one-line change to
 * `ENDPOINTS` below — the harness iterates and runs the standard
 * assertions per row.
 *
 * Per-row assertions (per the issue #388 contract):
 *
 *   - `list-scoped`:
 *       - account-A list: every row references customer A (or null
 *         only when the caller has `customers:access-all`).
 *       - account-B list: every row references customer B.
 *       - admin list: includes the customer-A row, the customer-B
 *         row, and any null-customer fixture row.
 *
 *   - `200-on-in-scope-404-on-out-of-scope`:
 *       - account-A in-scope GET: 200.
 *       - account-A out-of-scope GET: 404 (not 403 — that would
 *         disclose existence to the caller).
 *       - admin in-scope and out-of-scope GETs: 200.
 *
 * The matrix is intentionally not exhaustive at landing time; it
 * pins the patterns and the regression tests for the hardening sweep
 * (#387) and audit-log viewer fix (#386). Extending it as more
 * customer-scoped endpoints land is the explicit goal.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ADMIN_USERNAME,
  type AuthSession,
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

// ── Fixtures ─────────────────────────────────────────────────────

const TEST_PREFIX = "Integ-Scope-";
const ROLE_NAME = "integ-scope-tenant";

const ACCOUNT_A_USERNAME = "integ-scope-account-a";
const ACCOUNT_B_USERNAME = "integ-scope-account-b";
const COMMON_PASSWORD = "ScopeMatrix1234!";

interface Resources {
  customerAId: number;
  customerBId: number;
  auditLogARowId: string;
  auditLogBRowId: string;
  auditLogNullRowId: string;
}

// ── Endpoint matrix ──────────────────────────────────────────────
//
// Each row describes one customer-scoped endpoint and how to assert
// scope behaviour against it. The harness runs the assertions for
// every persona (account-A, account-B, admin) automatically.

interface ListEndpoint {
  name: string;
  method: "GET";
  path: string;
  expects: "list-scoped";
  /**
   * Pull the customer id from a list row. Null means "row is
   * customer-agnostic" — only admins should see those rows.
   */
  rowCustomerId: (row: Record<string, unknown>) => number | null;
  /**
   * Map of fixture row ids the matrix expects each persona to see /
   * not see. Keyed off `Resources` field names so the harness can
   * resolve them at run time without leaking ids into the matrix.
   */
  expectedRows: {
    "account-A": { include: (keyof Resources)[]; exclude: (keyof Resources)[] };
    "account-B": { include: (keyof Resources)[]; exclude: (keyof Resources)[] };
    admin: { include: (keyof Resources)[] };
  };
  /** Pull a stable row identifier for inclusion checks. */
  rowId: (row: Record<string, unknown>) => string;
}

interface DetailEndpoint {
  name: string;
  method: "GET";
  /** Resource the path resolves against ("A" / "B"). */
  pathFor: (resources: Resources) => { inScopeA: string; inScopeB: string };
  expects: "200-on-in-scope-404-on-out-of-scope";
}

type Endpoint = ListEndpoint | DetailEndpoint;

const ENDPOINTS: Endpoint[] = [
  {
    name: "GET /api/audit-logs",
    method: "GET",
    path: "/api/audit-logs?pageSize=100",
    expects: "list-scoped",
    rowCustomerId: (row) =>
      typeof row.customer_id === "number" ? row.customer_id : null,
    rowId: (row) => String(row.id),
    expectedRows: {
      "account-A": {
        include: ["auditLogARowId"],
        exclude: ["auditLogBRowId", "auditLogNullRowId"],
      },
      "account-B": {
        include: ["auditLogBRowId"],
        exclude: ["auditLogARowId", "auditLogNullRowId"],
      },
      admin: {
        include: ["auditLogARowId", "auditLogBRowId", "auditLogNullRowId"],
      },
    },
  },
  {
    name: "GET /api/customers",
    method: "GET",
    path: "/api/customers",
    expects: "list-scoped",
    rowCustomerId: (row) => (typeof row.id === "number" ? row.id : null),
    rowId: (row) => String(row.id),
    expectedRows: {
      "account-A": {
        include: ["customerAId"],
        exclude: ["customerBId"],
      },
      "account-B": {
        include: ["customerBId"],
        exclude: ["customerAId"],
      },
      admin: {
        include: ["customerAId", "customerBId"],
      },
    },
  },
  {
    name: "GET /api/customers/[id]",
    method: "GET",
    pathFor: (r) => ({
      inScopeA: `/api/customers/${r.customerAId}`,
      inScopeB: `/api/customers/${r.customerBId}`,
    }),
    expects: "200-on-in-scope-404-on-out-of-scope",
  },
];

// ── Helpers ──────────────────────────────────────────────────────

async function listRows(
  session: AuthSession,
  path: string,
): Promise<Record<string, unknown>[]> {
  const response = await authGet(session, path);
  expect(response.status).toBe(200);
  const body = (await response.json()) as { data: Record<string, unknown>[] };
  return body.data;
}

function resolveIds(resources: Resources, keys: (keyof Resources)[]): string[] {
  return keys.map((k) => String(resources[k]));
}

// ── Suite ────────────────────────────────────────────────────────

describe("Cross-customer scope matrix", () => {
  let resources: Resources;

  beforeAll(async () => {
    await resetRateLimits();
    await resetAccountDefaults(ADMIN_USERNAME);

    // Clean up any prior state.
    await deleteTestAccount(ACCOUNT_A_USERNAME);
    await deleteTestAccount(ACCOUNT_B_USERNAME);
    await deleteTestRole(ROLE_NAME);
    await deleteRolesByPrefix("integ-scope-");
    await deleteCustomersByPrefix(TEST_PREFIX);

    // Tenant-style role: read-only on customers and audit logs, no
    // `customers:access-all`. The matrix only exercises read paths.
    await createTestRole(
      ROLE_NAME,
      ["customers:read", "audit-logs:read"],
      "Integration scope-matrix tenant role",
    );

    const customerAId = await createCustomerRow(`${TEST_PREFIX}CustomerA`);
    const customerBId = await createCustomerRow(`${TEST_PREFIX}CustomerB`);

    await createTestAccount(ACCOUNT_A_USERNAME, COMMON_PASSWORD, ROLE_NAME);
    await createTestAccount(ACCOUNT_B_USERNAME, COMMON_PASSWORD, ROLE_NAME);

    const accountAId = await getAccountId(ACCOUNT_A_USERNAME);
    const accountBId = await getAccountId(ACCOUNT_B_USERNAME);
    await assignCustomerToAccount(accountAId, customerAId);
    await assignCustomerToAccount(accountBId, customerBId);

    const auditLogARowId = await insertAuditLog({
      actorId: accountAId,
      action: "customer.assign",
      targetType: "account",
      targetId: accountAId,
      customerId: customerAId,
    });
    const auditLogBRowId = await insertAuditLog({
      actorId: accountBId,
      action: "customer.assign",
      targetType: "account",
      targetId: accountBId,
      customerId: customerBId,
    });
    const auditLogNullRowId = await insertAuditLog({
      actorId: "system",
      action: "account.login",
      targetType: "account",
      targetId: accountAId,
      customerId: null,
    });

    resources = {
      customerAId,
      customerBId,
      auditLogARowId,
      auditLogBRowId,
      auditLogNullRowId,
    };
  });

  beforeEach(async () => {
    await resetRateLimits();
    await revokeAllSessions(ADMIN_USERNAME);
    await revokeAllSessions(ACCOUNT_A_USERNAME);
    await revokeAllSessions(ACCOUNT_B_USERNAME);
  });

  afterAll(async () => {
    await deleteAuditLogById(resources.auditLogARowId);
    await deleteAuditLogById(resources.auditLogBRowId);
    await deleteAuditLogById(resources.auditLogNullRowId);

    for (const username of [ACCOUNT_A_USERNAME, ACCOUNT_B_USERNAME]) {
      const id = await getAccountId(username).catch(() => null);
      if (id) await removeAccountCustomerAssignments(id);
      await deleteTestAccount(username);
    }
    await deleteTestRole(ROLE_NAME);
    await deleteCustomersByPrefix(TEST_PREFIX);
  });

  // The matrix is generated at import time; vitest needs `describe.each`
  // to discover the row names, so iterate manually.
  for (const endpoint of ENDPOINTS) {
    describe(endpoint.name, () => {
      if (endpoint.expects === "list-scoped") {
        const list = endpoint;

        it("account-A sees only customer-A rows", async () => {
          const session = await signIn(ACCOUNT_A_USERNAME);
          const rows = await listRows(session, list.path);
          const includeIds = resolveIds(
            resources,
            list.expectedRows["account-A"].include,
          );
          const excludeIds = resolveIds(
            resources,
            list.expectedRows["account-A"].exclude,
          );
          const rowIds = rows.map(list.rowId);
          for (const id of includeIds) expect(rowIds).toContain(id);
          for (const id of excludeIds) expect(rowIds).not.toContain(id);
          for (const row of rows) {
            const customerId = list.rowCustomerId(row);
            expect(customerId).toBe(resources.customerAId);
          }
        });

        it("account-B sees only customer-B rows", async () => {
          const session = await signIn(ACCOUNT_B_USERNAME);
          const rows = await listRows(session, list.path);
          const includeIds = resolveIds(
            resources,
            list.expectedRows["account-B"].include,
          );
          const excludeIds = resolveIds(
            resources,
            list.expectedRows["account-B"].exclude,
          );
          const rowIds = rows.map(list.rowId);
          for (const id of includeIds) expect(rowIds).toContain(id);
          for (const id of excludeIds) expect(rowIds).not.toContain(id);
          for (const row of rows) {
            const customerId = list.rowCustomerId(row);
            expect(customerId).toBe(resources.customerBId);
          }
        });

        it("admin sees rows from both customers (and null-customer rows when applicable)", async () => {
          const session = await signIn(ADMIN_USERNAME);
          const rows = await listRows(session, list.path);
          const includeIds = resolveIds(
            resources,
            list.expectedRows.admin.include,
          );
          const rowIds = rows.map(list.rowId);
          for (const id of includeIds) expect(rowIds).toContain(id);
        });
      } else {
        const detail = endpoint;

        it("account-A: 200 on in-scope, 404 on out-of-scope", async () => {
          const session = await signIn(ACCOUNT_A_USERNAME);
          const paths = detail.pathFor(resources);

          const inScope = await authGet(session, paths.inScopeA);
          expect(inScope.status).toBe(200);

          const outOfScope = await authGet(session, paths.inScopeB);
          // 404, not 403 — surfacing 403 would disclose existence of
          // an out-of-scope resource to the caller.
          expect(outOfScope.status).toBe(404);
        });

        it("account-B: 200 on in-scope, 404 on out-of-scope", async () => {
          const session = await signIn(ACCOUNT_B_USERNAME);
          const paths = detail.pathFor(resources);

          const inScope = await authGet(session, paths.inScopeB);
          expect(inScope.status).toBe(200);

          const outOfScope = await authGet(session, paths.inScopeA);
          expect(outOfScope.status).toBe(404);
        });

        it("admin: 200 on every resource", async () => {
          const session = await signIn(ADMIN_USERNAME);
          const paths = detail.pathFor(resources);

          const a = await authGet(session, paths.inScopeA);
          expect(a.status).toBe(200);

          const b = await authGet(session, paths.inScopeB);
          expect(b.status).toBe(200);
        });
      }
    });
  }
});
