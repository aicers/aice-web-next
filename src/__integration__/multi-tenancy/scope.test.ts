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
 *       - Each per-persona slot has an optional `inScope` and
 *         `outOfScope` variant. The harness only fires variants that
 *         are defined and asserts each response status equals the
 *         variant's `expectStatus`. Routes whose tenant in-scope path
 *         would mutate fixture state we don't want to restore (e.g.
 *         password-reset, mfa-reset) only declare the tenant
 *         out-of-scope variant — the regression bar is "out-of-scope
 *         is rejected", not "every successful path is exercised".
 *         Optional `cleanupAfterSuccess` runs after each 2xx so
 *         mutation rows don't leak fixture state into later runs.
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
  setAccountStatus,
} from "../helpers/setup-db";

// ── Fixtures ─────────────────────────────────────────────────────

const TEST_PREFIX = "Integ-Scope-";
const ROLE_NAME = "integ-scope-tenant";
// Security Monitor-equivalent role used as the **target role** by the
// `POST /api/accounts` row. Listed under the same `integ-scope-`
// prefix so the suite cleanup picks it up via `deleteRolesByPrefix`.
const MONITOR_ROLE_NAME = "integ-scope-monitor";

const ACCOUNT_A_USERNAME = "integ-scope-account-a";
const ACCOUNT_B_USERNAME = "integ-scope-account-b";
const COMMON_PASSWORD = "ScopeMatrix1234!";

interface Resources {
  customerAId: number;
  customerBId: number;
  /**
   * Customer with no account assignments. Used by the
   * `DELETE /api/customers/[id]` row, since the route refuses to drop
   * a customer that still has linked accounts.
   */
  customerOrphanId: number;
  accountAId: string;
  accountBId: string;
  /**
   * Role id for a Security Monitor-equivalent role (only allow-listed
   * read permissions). Used as the **target role** by the
   * `POST /api/accounts` row so the request reaches the customer-scope
   * branch instead of failing at the tenant-manageability gate. The
   * tenant caller's own role is unrelated; what matters is that the
   * target role qualifies under `tenantManageable`.
   */
  monitorRoleId: number;
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

interface PersonaMutationVariants {
  /**
   * The persona's "in-scope" call (e.g. tenant acting on their own
   * resource). Optional: omit when the in-scope path requires fixture
   * state we don't want to restore (e.g. tenant password-reset on a
   * managed Security Monitor account that doesn't exist in this
   * matrix). The out-of-scope variant alone is sufficient regression
   * coverage for those routes.
   */
  inScope?: MutationVariant;
  /** The persona's "out-of-scope" call. */
  outOfScope?: MutationVariant;
}

interface MutationEndpoint {
  name: string;
  method: "POST" | "PATCH" | "DELETE";
  expects: "mutation-scope";
  /**
   * Build the request variants for each persona. The harness fires
   * each defined variant in order (`inScope`, then `outOfScope`) and
   * asserts the response status equals the variant's `expectStatus`.
   * Optional cleanup runs after each successful 2xx so mutations
   * don't leak fixture state into later runs.
   */
  request: (resources: Resources) => {
    accountA: PersonaMutationVariants;
    accountB: PersonaMutationVariants;
    admin: PersonaMutationVariants;
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
  {
    name: "PATCH /api/customers/[id]",
    method: "PATCH",
    expects: "admin-only",
    request: (r) => ({
      path: `/api/customers/${r.customerOrphanId}`,
      body: { description: `${TEST_PREFIX}admin-only-patched` },
    }),
    adminSuccessStatus: 200,
    cleanupAfterSuccess: async (r, adminSession) => {
      // Restore the description to its original empty state so
      // re-runs don't drift the fixture.
      await authPatch(adminSession, `/api/customers/${r.customerOrphanId}`, {
        description: null,
      });
    },
  },
  {
    name: "DELETE /api/customers/[id]",
    method: "DELETE",
    expects: "admin-only",
    request: (r) => ({ path: `/api/customers/${r.customerOrphanId}` }),
    adminSuccessStatus: 200,
    cleanupAfterSuccess: async (r) => {
      // The admin success deletes the orphan customer. Recreate it so
      // the fixture state is consistent for re-runs against a
      // long-lived dev DB. The id changes, but the matrix doesn't
      // re-read `r.customerOrphanId` after this row runs.
      await deleteCustomersByPrefix(`${TEST_PREFIX}Orphan`);
      r.customerOrphanId = await createCustomerRow(`${TEST_PREFIX}Orphan`);
    },
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
  // POST /api/accounts — the regression we want to guard is the
  // customer-scope branch ("Cannot assign customers outside your
  // scope" at route step 5), so the request body has to reach that
  // branch. That requires the **target role** to be tenant-manageable
  // (Security Monitor-equivalent), otherwise tenant callers fail at
  // the role-policy gate (step 3) and the scope check is never
  // exercised. The matrix seeds a dedicated `monitorRoleId` for that
  // purpose; the tenant caller's own role still lacks
  // `customers:access-all`, so out-of-scope `customerIds` produce
  // 403 and in-scope `customerIds` produce 201. Admin (System
  // Administrator, has `customers:access-all`) can create with any
  // customer set, so both variants succeed.
  {
    name: "POST /api/accounts",
    method: "POST",
    expects: "mutation-scope",
    request: (r) => {
      const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const buildBody = (
        suffix: string,
        customerIds: number[],
      ): Record<string, unknown> => ({
        username: `${TEST_PREFIX}created-${suffix}-${stamp}`.toLowerCase(),
        displayName: `${TEST_PREFIX}created-${suffix}`,
        password: COMMON_PASSWORD,
        roleId: r.monitorRoleId,
        customerIds,
      });
      return {
        accountA: {
          inScope: {
            path: "/api/accounts",
            body: buildBody("a-in", [r.customerAId]),
            expectStatus: 201,
          },
          outOfScope: {
            path: "/api/accounts",
            body: buildBody("a-out", [r.customerBId]),
            expectStatus: 403,
          },
        },
        accountB: {
          inScope: {
            path: "/api/accounts",
            body: buildBody("b-in", [r.customerBId]),
            expectStatus: 201,
          },
          outOfScope: {
            path: "/api/accounts",
            body: buildBody("b-out", [r.customerAId]),
            expectStatus: 403,
          },
        },
        admin: {
          inScope: {
            path: "/api/accounts",
            body: buildBody("admin-a", [r.customerAId]),
            expectStatus: 201,
          },
          outOfScope: {
            path: "/api/accounts",
            body: buildBody("admin-b", [r.customerBId]),
            expectStatus: 201,
          },
        },
      };
    },
    cleanupAfterSuccess: async () => {
      // Sweep every account whose username matches the matrix prefix.
      // Variants generate fresh timestamp+random usernames each run,
      // so a prefix sweep is the simplest way to keep the dev DB
      // clean across re-runs.
      await dropAccountsByUsernamePrefix(`${TEST_PREFIX}created`);
    },
  },
  // PATCH /api/accounts/[id] — accounts:write held by tenants, scope
  // enforced by validateManagedAccountTarget. Self-patch on basic
  // fields is the in-scope path; cross-tenant target is the out-of-
  // scope path (404 since accounts share no customers in the
  // fixture).
  {
    name: "PATCH /api/accounts/[id]",
    method: "PATCH",
    expects: "mutation-scope",
    request: (r) => ({
      accountA: {
        inScope: {
          path: `/api/accounts/${r.accountAId}`,
          body: { displayName: ACCOUNT_A_USERNAME },
          expectStatus: 200,
        },
        outOfScope: {
          path: `/api/accounts/${r.accountBId}`,
          body: { displayName: "should-not-apply" },
          expectStatus: 404,
        },
      },
      accountB: {
        inScope: {
          path: `/api/accounts/${r.accountBId}`,
          body: { displayName: ACCOUNT_B_USERNAME },
          expectStatus: 200,
        },
        outOfScope: {
          path: `/api/accounts/${r.accountAId}`,
          body: { displayName: "should-not-apply" },
          expectStatus: 404,
        },
      },
      // Admin can patch any account; both variants succeed and are
      // idempotent (display_name reset to the original username), so
      // no per-variant cleanup is needed.
      admin: {
        inScope: {
          path: `/api/accounts/${r.accountAId}`,
          body: { displayName: ACCOUNT_A_USERNAME },
          expectStatus: 200,
        },
        outOfScope: {
          path: `/api/accounts/${r.accountBId}`,
          body: { displayName: ACCOUNT_B_USERNAME },
          expectStatus: 200,
        },
      },
    }),
  },
  // DELETE /api/accounts/[id] — admin-only because tenant role lacks
  // `accounts:delete`. The admin success disables account-A; the
  // cleanup re-enables it so subsequent rows / re-runs aren't broken.
  {
    name: "DELETE /api/accounts/[id]",
    method: "DELETE",
    expects: "admin-only",
    request: (r) => ({ path: `/api/accounts/${r.accountAId}` }),
    adminSuccessStatus: 200,
    nonAdminStatuses: [403],
    cleanupAfterSuccess: async () => {
      await setAccountStatus(ACCOUNT_A_USERNAME, "active", null);
    },
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
  // DELETE /api/accounts/[id]/customers/[customerId] — tenants have
  // accounts:write. In-scope: tenant unassigns their own customer
  // from their own account (200), then the cleanup re-adds. Out-of-
  // scope: tenant tries to unassign the OTHER tenant's customer from
  // the OTHER tenant's account; the assignment exists, so the route
  // reaches the scope check and rejects with 403.
  {
    name: "DELETE /api/accounts/[id]/customers/[customerId]",
    method: "DELETE",
    expects: "mutation-scope",
    request: (r) => ({
      accountA: {
        inScope: {
          path: `/api/accounts/${r.accountAId}/customers/${r.customerAId}`,
          expectStatus: 200,
        },
        outOfScope: {
          path: `/api/accounts/${r.accountBId}/customers/${r.customerBId}`,
          expectStatus: 403,
        },
      },
      accountB: {
        inScope: {
          path: `/api/accounts/${r.accountBId}/customers/${r.customerBId}`,
          expectStatus: 200,
        },
        outOfScope: {
          path: `/api/accounts/${r.accountAId}/customers/${r.customerAId}`,
          expectStatus: 403,
        },
      },
      // Admin variants intentionally omitted: re-firing admin-driven
      // mutations on the same (account, customer) pair after the
      // tenant in-scope variants would race the cleanup ordering.
      // The route's "admin can do anything" path is exercised by the
      // sibling POST row above; what this row guards is the tenant
      // scope check, which the two non-admin personas already cover.
      admin: {},
    }),
    cleanupAfterSuccess: async (
      resources,
      _adminSession,
      _persona,
      _variant,
    ) => {
      // Re-establish the canonical (accountA→customerA, accountB→
      // customerB) assignments after every successful unassign.
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
  // POST /api/accounts/[id]/password-reset — tenants have
  // accounts:write but the route forbids self-reset (400) and
  // validateManagedAccountTarget rejects out-of-scope targets (404).
  // Only the out-of-scope variant is meaningful for regression
  // detection: a future change that drops the scope check would let
  // a tenant reset another tenant's password, which is exactly the
  // gap we're guarding against. Admin variants omitted because the
  // success path mutates password state we don't want to restore on
  // every run.
  {
    name: "POST /api/accounts/[id]/password-reset",
    method: "POST",
    expects: "mutation-scope",
    request: (r) => ({
      accountA: {
        outOfScope: {
          path: `/api/accounts/${r.accountBId}/password-reset`,
          body: { newPassword: COMMON_PASSWORD },
          expectStatus: 404,
        },
      },
      accountB: {
        outOfScope: {
          path: `/api/accounts/${r.accountAId}/password-reset`,
          body: { newPassword: COMMON_PASSWORD },
          expectStatus: 404,
        },
      },
      admin: {},
    }),
  },
  // POST /api/accounts/[id]/unlock — same shape as password-reset:
  // out-of-scope is the regression-meaningful assertion. Admin
  // success requires the target to be locked or suspended, which the
  // matrix fixture doesn't seed; the dedicated unlock test in
  // src/__integration__/api/unlock.test.ts already covers the happy
  // path.
  {
    name: "POST /api/accounts/[id]/unlock",
    method: "POST",
    expects: "mutation-scope",
    request: (r) => ({
      accountA: {
        outOfScope: {
          path: `/api/accounts/${r.accountBId}/unlock`,
          expectStatus: 404,
        },
      },
      accountB: {
        outOfScope: {
          path: `/api/accounts/${r.accountAId}/unlock`,
          expectStatus: 404,
        },
      },
      admin: {},
    }),
  },
  // POST /api/accounts/[id]/mfa-reset — out-of-scope rejected by
  // validateManagedAccountTarget (404) before the step-up auth and
  // MFA-existence checks run. The dedicated MFA tests cover the
  // happy path; what this row protects is "tenant cannot reach
  // another tenant's MFA reset at all".
  {
    name: "POST /api/accounts/[id]/mfa-reset",
    method: "POST",
    expects: "mutation-scope",
    request: (r) => ({
      accountA: {
        outOfScope: {
          path: `/api/accounts/${r.accountBId}/mfa-reset`,
          body: { password: COMMON_PASSWORD },
          expectStatus: 404,
        },
      },
      accountB: {
        outOfScope: {
          path: `/api/accounts/${r.accountAId}/mfa-reset`,
          body: { password: COMMON_PASSWORD },
          expectStatus: 404,
        },
      },
      admin: {},
    }),
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

/**
 * Drop every account row whose username starts with `prefix`,
 * cascading through the related child tables that `deleteTestAccount`
 * handles. Used by the `POST /api/accounts` cleanup, which generates
 * a unique timestamped username on every admin invocation.
 */
async function dropAccountsByUsernamePrefix(prefix: string): Promise<void> {
  const pg = await import("pg");
  const { readFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  let connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    try {
      const env = readFileSync(resolve(".env.local"), "utf8");
      const m = env.match(/^DATABASE_URL=(.+)$/m);
      if (m) connectionString = m[1].trim();
    } catch {
      /* fall through */
    }
  }
  if (!connectionString) {
    connectionString = "postgres://postgres:postgres@localhost:5432/auth_db";
  }
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const { rows } = await client.query<{ username: string }>(
      "SELECT username FROM accounts WHERE username LIKE $1",
      [`${prefix}%`],
    );
    for (const row of rows) {
      await client.query(
        `DELETE FROM sessions
         WHERE account_id = (SELECT id FROM accounts WHERE username = $1)`,
        [row.username],
      );
      await client.query(
        `DELETE FROM account_customer
         WHERE account_id = (SELECT id FROM accounts WHERE username = $1)`,
        [row.username],
      );
      await client.query(
        `DELETE FROM password_history
         WHERE account_id = (SELECT id FROM accounts WHERE username = $1)`,
        [row.username],
      );
      await client.query("DELETE FROM accounts WHERE username = $1", [
        row.username,
      ]);
    }
  } finally {
    await client.end();
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
    await dropAccountsByUsernamePrefix(`${TEST_PREFIX}created`.toLowerCase());
    await deleteTestRole(ROLE_NAME);
    await deleteRolesByPrefix("integ-scope-");
    await deleteCustomersByPrefix(TEST_PREFIX);

    // Tenant-style role: scoped read on accounts/customers/audit-logs
    // plus accounts:write so the mutation-scope rows can exercise
    // PATCH /api/accounts/[id], POST /api/accounts/[id]/customers,
    // and the admin-bypass rows on password-reset / unlock /
    // mfa-reset from a non-admin caller. No `customers:access-all`,
    // `customers:write`, `customers:delete`, or `accounts:delete` —
    // those gate the admin-only assertions.
    await createTestRole(
      ROLE_NAME,
      ["customers:read", "audit-logs:read", "accounts:read", "accounts:write"],
      "Integration scope-matrix tenant role",
    );

    // Security Monitor-equivalent role used as the **target role** for
    // `POST /api/accounts`. Permissions must all be drawn from the
    // monitor allow-list in `account-role-policy.ts` so
    // `tenantManageable` is true; otherwise the route's step-3 gate
    // shorts the tenant's request before the customer-scope check.
    const monitorRoleId = await createTestRole(
      MONITOR_ROLE_NAME,
      ["audit-logs:read"],
      "Integration scope-matrix monitor-equivalent role",
    );

    const customerAId = await createCustomerRow(`${TEST_PREFIX}CustomerA`);
    const customerBId = await createCustomerRow(`${TEST_PREFIX}CustomerB`);
    const customerOrphanId = await createCustomerRow(`${TEST_PREFIX}Orphan`);

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
      customerOrphanId,
      accountAId,
      accountBId,
      monitorRoleId,
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

    // The mutation rows emit audit entries via the routes under test
    // (`POST /api/accounts/[id]/customers`, `PATCH /api/accounts/[id]`,
    // `DELETE /api/accounts/[id]`, etc.). Those live in `audit_db` so
    // they are not cascaded by the auth_db account/role/customer
    // cleanup below — drop them by actor before detaching the test
    // accounts so re-runs see a clean slate. Only the test-account
    // actors (and admin, since admin's matrix-driven rows also emit)
    // are touched: admin's audit history outside the matrix isn't
    // affected because we filter by actor_id, not by action.
    await deleteAuditLogsByActor(resources.accountAId);
    await deleteAuditLogsByActor(resources.accountBId);

    for (const username of [ACCOUNT_A_USERNAME, ACCOUNT_B_USERNAME]) {
      const id = await getAccountId(username).catch(() => null);
      if (id) await removeAccountCustomerAssignments(id);
      await deleteTestAccount(username);
    }
    await dropAccountsByUsernamePrefix(`${TEST_PREFIX}created`.toLowerCase());
    await deleteTestRole(ROLE_NAME);
    await deleteTestRole(MONITOR_ROLE_NAME);
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
          it(`${c.persona}: defined variants pass scope assertions`, async () => {
            const variants = mutation.request(resources);
            const personaVariants =
              c.persona === "account-A"
                ? variants.accountA
                : c.persona === "account-B"
                  ? variants.accountB
                  : variants.admin;

            // Skip the test cleanly when neither variant is defined
            // (e.g. admin: {} for routes whose admin path needs
            // stateful setup we don't seed in this matrix).
            if (!personaVariants.inScope && !personaVariants.outOfScope) {
              return;
            }

            const session = await signIn(c.username);

            for (const [tag, variant] of [
              ["in-scope", personaVariants.inScope],
              ["out-of-scope", personaVariants.outOfScope],
            ] as const) {
              if (!variant) continue;
              const res = await fireMutation(session, mutation.method, variant);
              expect(res.status).toBe(variant.expectStatus);
              if (
                res.status >= 200 &&
                res.status < 300 &&
                mutation.cleanupAfterSuccess
              ) {
                const adminSession = await signIn(ADMIN_USERNAME);
                await mutation.cleanupAfterSuccess(
                  resources,
                  adminSession,
                  c.persona,
                  tag,
                );
              }
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
