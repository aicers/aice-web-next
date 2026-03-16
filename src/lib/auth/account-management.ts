import "server-only";

import { deriveAccountRolePolicy } from "./account-role-policy";
import { getAccountCustomerIds } from "./customer-scope";
import type { AuthSession } from "./jwt";
import { hasPermission } from "./permissions";

export interface ManagedAccountTarget {
  id: string;
  role_permissions?: string[];
  role_name: string;
  role_id: number;
}

export interface ManagedAccountPolicyError {
  error: string;
  status: 403 | 404;
}

/**
 * Enforce tenant-scoped account management boundaries.
 *
 * Callers with `customers:access-all` are treated as unrestricted
 * account managers. In the current role matrix that is limited to
 * System Administrator.
 */
export async function validateManagedAccountTarget(
  session: Pick<AuthSession, "accountId" | "roles">,
  account: ManagedAccountTarget,
): Promise<ManagedAccountPolicyError | null> {
  const accessAll = await hasPermission(session.roles, "customers:access-all");
  if (accessAll) {
    return null;
  }

  const callerCustomerIds = await getAccountCustomerIds(session.accountId);
  const targetCustomerIds = await getAccountCustomerIds(account.id);
  const overlap = targetCustomerIds.some((id) =>
    callerCustomerIds.includes(id),
  );

  if (!overlap) {
    return { error: "Account not found", status: 404 };
  }

  const targetPolicy = deriveAccountRolePolicy({
    id: account.role_id,
    name: account.role_name,
    permissions: account.role_permissions ?? [],
  });

  if (!targetPolicy.tenantManageable) {
    return {
      error:
        "Tenant Administrator can only manage Security Monitor-equivalent accounts",
      status: 403,
    };
  }

  return null;
}
