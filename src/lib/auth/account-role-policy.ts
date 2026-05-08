import "server-only";

import { query } from "@/lib/db/client";

export const SYSTEM_ADMIN_ROLE_NAME = "System Administrator";

interface RolePolicyRow {
  id: number;
  name: string;
  permissions: string[];
}

export interface AccountRolePolicy {
  roleId: number;
  roleName: string;
  permissions: string[];
  isNamedSystemAdministrator: boolean;
  isSecurityMonitorEquivalent: boolean;
  requiresCustomerAssignment: boolean;
  maxCustomerAssignments: number | null;
  tenantManageable: boolean;
}

export interface AccountRolePolicySummary {
  requires_customer_assignment: boolean;
  max_customer_assignments: number | null;
  tenant_manageable: boolean;
}

export function rolePermissionsSelectSql(
  roleAlias = "r",
  columnAlias = "permissions",
): string {
  return `COALESCE(
            (SELECT array_agg(rp.permission ORDER BY rp.permission)
             FROM role_permissions rp
             WHERE rp.role_id = ${roleAlias}.id),
            '{}'
          ) AS ${columnAlias}`;
}

function hasGlobalCustomerAccess(permissions: string[]): boolean {
  return permissions.includes("customers:access-all");
}

// Allow-list of read-only data permissions that preserve Security
// Monitor semantics. A role whose permissions are all drawn from this
// set is treated as Security Monitor-equivalent. Any permission
// outside this set (including write permissions such as
// `dashboard:write`, which gates session revocation) disqualifies a
// role from equivalence, so new permissions must be added here
// explicitly.
const SECURITY_MONITOR_EQUIVALENT_PERMISSIONS: ReadonlySet<string> = new Set([
  "audit-logs:read",
  "dashboard:read",
  "detection:read",
  "nodes:read",
  "services:read",
  "triage:read",
]);

function hasNonMonitorPermission(permissions: string[]): boolean {
  return permissions.some(
    (permission) => !SECURITY_MONITOR_EQUIVALENT_PERMISSIONS.has(permission),
  );
}

export function deriveAccountRolePolicy(
  role: RolePolicyRow,
): AccountRolePolicy {
  const permissions = Array.isArray(role.permissions)
    ? [...role.permissions].sort()
    : [];
  const securityMonitorEquivalent = !hasNonMonitorPermission(permissions);
  const requiresCustomerAssignment = !hasGlobalCustomerAccess(permissions);

  return {
    roleId: role.id,
    roleName: role.name,
    permissions,
    isNamedSystemAdministrator: role.name === SYSTEM_ADMIN_ROLE_NAME,
    isSecurityMonitorEquivalent: securityMonitorEquivalent,
    requiresCustomerAssignment,
    maxCustomerAssignments: securityMonitorEquivalent ? 1 : null,
    tenantManageable: securityMonitorEquivalent,
  };
}

export function summarizeAccountRolePolicy(
  policy: Pick<
    AccountRolePolicy,
    "requiresCustomerAssignment" | "maxCustomerAssignments" | "tenantManageable"
  >,
): AccountRolePolicySummary {
  return {
    requires_customer_assignment: policy.requiresCustomerAssignment,
    max_customer_assignments: policy.maxCustomerAssignments,
    tenant_manageable: policy.tenantManageable,
  };
}

export async function loadAccountRolePolicy(
  roleId: number,
): Promise<AccountRolePolicy | null> {
  const { rows } = await query<RolePolicyRow>(
    `SELECT r.id, r.name, ${rolePermissionsSelectSql("r")}
       FROM roles r
      WHERE r.id = $1`,
    [roleId],
  );

  if (rows.length === 0) {
    return null;
  }

  return deriveAccountRolePolicy(rows[0]);
}
