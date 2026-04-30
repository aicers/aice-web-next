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
 *       - account-A list: includes the customer-A fixture row, excludes
 *         the customer-B fixture row. If the row payload exposes a
 *         single `customer_id` field, every row's customer matches the
 *         caller's customer (rows that don't expose one — e.g. the
 *         accounts list, where the link is via `account_customer` and
 *         not on the row — skip the per-row assertion).
 *       - account-B list: mirror of account-A on customer B.
 *       - admin list: includes the customer-A row, the customer-B
 *         row, and any null-customer fixture row.
 *
 *   - `200-on-in-scope-404-on-out-of-scope`:
 *       - account-A in-scope GET: 200.
 *       - account-A out-of-scope GET: 404 (not 403 — surfacing 403
 *         would disclose existence to the caller).
 *       - admin in-scope and out-of-scope GETs: 200.
 *
 *   - `mutation-scope` (POST / PATCH / DELETE):
 *       - account-A with in-scope params: 2xx.
 *       - account-A with out-of-scope params: 4xx (typically 403 for a
 *         mutation that names an out-of-scope resource — distinct from
 *         the read-side 404 since the caller is asserting they own the
 *         input ids).
 *       - account-B mirrors account-A on customer B.
 *       - admin: 2xx for both in-scope and out-of-scope variants.
 *
 *   - `admin-only`:
 *       - account-A and account-B: 4xx (typically 403 — neither holds
 *         the operation's permission).
 *       - admin: success status declared on the row.
 *
 * The audit-log and customer rows are the regression tests for #386
 * and #387; the accounts rows cover the post-#387 customer-scoped
 * surface that does not flow through `buildDispatchContext`. Routes
 * that *do* flow through `buildDispatchContext` (e.g. the node API
 * surface backed by REview / Tivan) are guarded by the static
 * `pnpm check:scope` check and exercised against the `mock-graphql`
 * helper in their feature-specific integration files; they are not
 * driven by this matrix because the cross-customer contract there is
 * "the JWT carries the right `customer_ids`", which is a structural
 * assertion against the dispatch context, not a row-level DB scope
 * check.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ADMIN_USERNAME,
  type AuthSession,
  authDelete,
  authGet,
  authPatch,
  authPost,
  resetRateLimits,
  signIn,
} from "../helpers/auth";
import {
  assignCustomerToAccount,
  createCustomerRow,
  createTestAccount,
  createTestRole,
  deleteAuditLogById,
  deleteAuditLogsByActor,
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
  accountAId: string;
  accountBId: string;
  auditLogARowId: string;
  auditLogBRowId: string;
  auditLogNullRowId: string;
}

type Persona = "account-A" | "account-B" | "admin";

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
   * Pull the customer id from a list row. Returning `null` means
   * "customer-agnostic row" — only admins should see those. Returning
   * `undefined` means "this row payload doesn't expose a single
   * customer id" — skip the per-row customer assertion (e.g. accounts
   * list, where membership is N:N via `account_customer`).
   */
  rowCustomerId: (row: Record<string, unknown>) => number | null | undefined;
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

interface MutationVariant {
  path: string;
  body?: unknown;
  expectStatus: number;
}

interface MutationEndpoint {
  name: string;
  method: "POST" | "PATCH" | "DELETE";
  expects: "mutation-scope";
  /**
   * Build the request variants for each persona. The harness fires:
   *   - account-A: `accountA.inScope` then `accountA.outOfScope`
   *   - account-B: `accountB.inScope` then `accountB.outOfScope`
   *   - admin:     `admin.inScope` then `admin.outOfScope`
   * and asserts each response status equals the variant's
   * `expectStatus`. Optional cleanup runs after each successful 2xx so
   * mutation rows don't leak fixture state into later test runs.
   */
  request: (resources: Resources) => {
    accountA: { inScope: MutationVariant; outOfScope: MutationVariant };
    accountB: { inScope: MutationVariant; outOfScope: MutationVariant };
    admin: { inScope: MutationVariant; outOfScope: MutationVariant };
  };
  /**
   * Optional post-success cleanup. Fired after every 2xx mutation so
   * the matrix can run against a long-lived dev DB without the
   * mutations piling up. Receives the fixture, the persona, and the
   * variant tag the call corresponds to.
   */
  cleanupAfterSuccess?: (
    resources: Resources,
    adminSession: AuthSession,
    persona: Persona,
    variant: "in-scope" | "out-of-scope",
  ) => Promise<void>;
}

interface AdminOnlyEndpoint {
  name: string;
  method: "GET" | "POST" | "PATCH" | "DELETE";
  expects: "admin-only";
  /** Single request shape — admin-only routes have no per-persona scope. */
  request: (resources: Resources) => {
    path: string;
    body?: unknown;
  };
  /** Status the admin call must produce (e.g. 200, 201). */
  adminSuccessStatus: number;
  /**
   * Status non-admin callers must produce. Defaults to `[401, 403]`
   * since admin-only routes typically refuse non-holders of the
   * operation's permission with 403, but a few surface 401 if the
   * route checks auth before perm.
   */
  nonAdminStatuses?: readonly number[];
  /** Optional post-success cleanup mirroring `MutationEndpoint`. */
  cleanupAfterSuccess?: (
    resources: Resources,
    adminSession: AuthSession,
  ) => Promise<void>;
}

type Endpoint =
  | ListEndpoint
  | DetailEndpoint
  | MutationEndpoint
  | AdminOnlyEndpoint;

const ENDPOINTS: Endpoint[] = [
  // ── audit-logs (regression target for #386) ────────────────────
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
  // ── customers (regression target for #387) ─────────────────────
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
  // ── accounts (post-#387 surface, local-DB scoped) ──────────────
  {
    name: "GET /api/accounts",
    method: "GET",
    path: "/api/accounts?pageSize=100",
    expects: "list-scoped",
    // Account rows don't expose a single customer_id (membership is
    // N:N via `account_customer`); skip the per-row check and rely on
    // include/exclude alone.
    rowCustomerId: () => undefined,
    rowId: (row) => String(row.id),
    expectedRows: {
      "account-A": {
        include: ["accountAId"],
        exclude: ["accountBId"],
      },
      "account-B": {
        include: ["accountBId"],
        exclude: ["accountAId"],
      },
      admin: {
        include: ["accountAId", "accountBId"],
      },
    },
  },
  {
    name: "GET /api/accounts/[id]",
    method: "GET",
    pathFor: (r) => ({
      inScopeA: `/api/accounts/${r.accountAId}`,
      inScopeB: `/api/accounts/${r.accountBId}`,
    }),
    expects: "200-on-in-scope-404-on-out-of-scope",
  },
  {
    name: "GET /api/accounts/[id]/customers",
    method: "GET",
    pathFor: (r) => ({
      inScopeA: `/api/accounts/${r.accountAId}/customers`,
      inScopeB: `/api/accounts/${r.accountBId}/customers`,
    }),
    expects: "200-on-in-scope-404-on-out-of-scope",
  },
  // ── accounts mutation surface ──────────────────────────────────
  //
  // POST /api/accounts/[id]/customers — assigning customers to an
  // account. In-scope: caller assigns one of their own customer ids
  // to their own account. Out-of-scope: caller asks for a customer id
  // outside their scope; the route must 403 BEFORE existence checks
  // (see #387 P1 §4 / §7-2).
  {
    name: "POST /api/accounts/[id]/customers",
    method: "POST",
    expects: "mutation-scope",
    request: (r) => ({
      accountA: {
        inScope: {
          path: `/api/accounts/${r.accountAId}/customers`,
          body: { customerIds: [r.customerAId] },
          expectStatus: 201,
        },
        outOfScope: {
          path: `/api/accounts/${r.accountAId}/customers`,
          body: { customerIds: [r.customerBId] },
          expectStatus: 403,
        },
      },
      accountB: {
        inScope: {
          path: `/api/accounts/${r.accountBId}/customers`,
          body: { customerIds: [r.customerBId] },
          expectStatus: 201,
        },
        outOfScope: {
          path: `/api/accounts/${r.accountBId}/customers`,
          body: { customerIds: [r.customerAId] },
          expectStatus: 403,
        },
      },
      admin: {
        // Admin can assign any customer to any account; "out-of-scope"
        // doesn't apply, so both variants are real assignments. Use a
        // distinct (account, customer) pair per variant so the second
        // one isn't a no-op against the same row.
        inScope: {
          path: `/api/accounts/${r.accountAId}/customers`,
          body: { customerIds: [r.customerBId] },
          expectStatus: 201,
        },
        outOfScope: {
          path: `/api/accounts/${r.accountBId}/customers`,
          body: { customerIds: [r.customerAId] },
          expectStatus: 201,
        },
      },
    }),
    cleanupAfterSuccess: async (resources, _adminSession) => {
      // Reset to the canonical per-suite assignment so subsequent
      // mutation rows / re-runs see the same fixture state.
      await removeAccountCustomerAssignments(resources.accountAId);
      await removeAccountCustomerAssignments(resources.accountBId);
      await assignCustomerToAccount(
        resources.accountAId,
        resources.customerAId,
      );
      await assignCustomerToAccount(
        resources.accountBId,
        resources.customerBId,
      );
    },
  },
  // ── admin-only example: POST /api/customers ────────────────────
  //
  // Creating a customer requires `customers:write`, which the
  // tenant-style test role does not hold; this exercises the
  // admin-only branch end-to-end. The created row is cleaned up via
  // `deleteCustomersByPrefix` since the name carries `TEST_PREFIX`.
  {
    name: "POST /api/customers",
    method: "POST",
    expects: "admin-only",
    request: () => ({
      path: "/api/customers",
      body: { name: `${TEST_PREFIX}AdminOnly-${Date.now()}` },
    }),
    adminSuccessStatus: 201,
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

async function fireMutation(
  session: AuthSession,
  method: MutationEndpoint["method"],
  variant: MutationVariant,
): Promise<Response> {
  switch (method) {
    case "POST":
      return authPost(session, variant.path, variant.body);
    case "PATCH":
      return authPatch(session, variant.path, variant.body);
    case "DELETE":
      return authDelete(session, variant.path, variant.body);
  }
}

async function fireAdminOnly(
  session: AuthSession,
  method: AdminOnlyEndpoint["method"],
  request: { path: string; body?: unknown },
): Promise<Response> {
  switch (method) {
    case "GET":
      return authGet(session, request.path);
    case "POST":
      return authPost(session, request.path, request.body);
    case "PATCH":
      return authPatch(session, request.path, request.body);
    case "DELETE":
      return authDelete(session, request.path, request.body);
  }
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

    // Tenant-style role: scoped read on accounts/customers/audit-logs
    // plus accounts:write so the mutation-scope row can exercise
    // POST /api/accounts/[id]/customers from a non-admin caller.
    // No `customers:access-all`, no `customers:write` — those gate the
    // admin-only assertions.
    await createTestRole(
      ROLE_NAME,
      ["customers:read", "audit-logs:read", "accounts:read", "accounts:write"],
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
      accountAId,
      accountBId,
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

    // The mutation row emits `customer.assign` audit entries via the
    // route under test (`POST /api/accounts/[id]/customers`). Those
    // live in `audit_db` so they are not cascaded by the auth_db
    // account/role/customer cleanup below — drop them by actor before
    // detaching the test accounts so re-runs see a clean slate. Only
    // the test-account actors are dropped; admin's row count is not
    // touched since admin's audit history belongs to the dev DB.
    await deleteAuditLogsByActor(resources.accountAId);
    await deleteAuditLogsByActor(resources.accountBId);

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

        const personaCases: Array<{
          persona: Persona;
          username: string;
          customerKey: keyof Resources | null;
          spec: { include: (keyof Resources)[]; exclude?: (keyof Resources)[] };
        }> = [
          {
            persona: "account-A",
            username: ACCOUNT_A_USERNAME,
            customerKey: "customerAId",
            spec: list.expectedRows["account-A"],
          },
          {
            persona: "account-B",
            username: ACCOUNT_B_USERNAME,
            customerKey: "customerBId",
            spec: list.expectedRows["account-B"],
          },
          {
            persona: "admin",
            username: ADMIN_USERNAME,
            customerKey: null,
            spec: list.expectedRows.admin,
          },
        ];

        for (const c of personaCases) {
          it(`${c.persona} sees the expected rows`, async () => {
            const session = await signIn(c.username);
            const rows = await listRows(session, list.path);
            const includeIds = resolveIds(resources, c.spec.include);
            const rowIds = rows.map(list.rowId);
            for (const id of includeIds) expect(rowIds).toContain(id);

            if (c.spec.exclude) {
              const excludeIds = resolveIds(resources, c.spec.exclude);
              for (const id of excludeIds) expect(rowIds).not.toContain(id);
            }

            // Per-row customer-id check: skip when the endpoint can't
            // expose a single customer per row (rowCustomerId returns
            // undefined) or when the persona is admin (admin sees
            // every customer).
            if (c.persona !== "admin" && c.customerKey) {
              const expectedCustomerId = resources[c.customerKey];
              for (const row of rows) {
                const customerId = list.rowCustomerId(row);
                if (customerId !== undefined) {
                  expect(customerId).toBe(expectedCustomerId);
                }
              }
            }
          });
        }
      } else if (endpoint.expects === "200-on-in-scope-404-on-out-of-scope") {
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
      } else if (endpoint.expects === "mutation-scope") {
        const mutation = endpoint;

        const personaCases: Array<{
          persona: Persona;
          username: string;
        }> = [
          { persona: "account-A", username: ACCOUNT_A_USERNAME },
          { persona: "account-B", username: ACCOUNT_B_USERNAME },
          { persona: "admin", username: ADMIN_USERNAME },
        ];

        for (const c of personaCases) {
          it(`${c.persona}: in-scope succeeds, out-of-scope is rejected`, async () => {
            const variants = mutation.request(resources);
            const personaVariants =
              c.persona === "account-A"
                ? variants.accountA
                : c.persona === "account-B"
                  ? variants.accountB
                  : variants.admin;
            const session = await signIn(c.username);

            const inScopeRes = await fireMutation(
              session,
              mutation.method,
              personaVariants.inScope,
            );
            expect(inScopeRes.status).toBe(
              personaVariants.inScope.expectStatus,
            );
            if (
              inScopeRes.status >= 200 &&
              inScopeRes.status < 300 &&
              mutation.cleanupAfterSuccess
            ) {
              const adminSession = await signIn(ADMIN_USERNAME);
              await mutation.cleanupAfterSuccess(
                resources,
                adminSession,
                c.persona,
                "in-scope",
              );
            }

            const outOfScopeRes = await fireMutation(
              session,
              mutation.method,
              personaVariants.outOfScope,
            );
            expect(outOfScopeRes.status).toBe(
              personaVariants.outOfScope.expectStatus,
            );
            if (
              outOfScopeRes.status >= 200 &&
              outOfScopeRes.status < 300 &&
              mutation.cleanupAfterSuccess
            ) {
              const adminSession = await signIn(ADMIN_USERNAME);
              await mutation.cleanupAfterSuccess(
                resources,
                adminSession,
                c.persona,
                "out-of-scope",
              );
            }
          });
        }
      } else {
        const adminOnly = endpoint;
        const nonAdminStatuses = adminOnly.nonAdminStatuses ?? [401, 403];

        for (const username of [ACCOUNT_A_USERNAME, ACCOUNT_B_USERNAME]) {
          it(`${username}: rejected (no admin permission)`, async () => {
            const session = await signIn(username);
            const req = adminOnly.request(resources);
            const res = await fireAdminOnly(session, adminOnly.method, req);
            expect(nonAdminStatuses).toContain(res.status);
          });
        }

        it("admin: succeeds", async () => {
          const session = await signIn(ADMIN_USERNAME);
          const req = adminOnly.request(resources);
          const res = await fireAdminOnly(session, adminOnly.method, req);
          expect(res.status).toBe(adminOnly.adminSuccessStatus);
          if (
            adminOnly.cleanupAfterSuccess &&
            res.status >= 200 &&
            res.status < 300
          ) {
            await adminOnly.cleanupAfterSuccess(resources, session);
          }
        });
      }
    });
  }
});
