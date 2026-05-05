import "server-only";

import { SYSTEM_ADMIN_ROLE_NAME } from "@/lib/auth/account-role-policy";
import type { AuthSession } from "@/lib/auth/jwt";

/**
 * Role-name-based check.  Aimer integration management is reserved
 * for the named System Administrator role per #437 §Authorization.
 *
 * Why role-name and not permission-based: a future custom role with
 * broad permissions (e.g. `system-settings:*`, `customers:*`) must
 * NOT be able to modify the signing keypair or the bridge target.
 * Tying the gate to the canonical role name preserves the trust
 * boundary between System Administrator and Tenant Administrator.
 */
export function isSystemAdministrator(
  roles: readonly string[] | undefined,
): boolean {
  if (!roles) return false;
  return roles.includes(SYSTEM_ADMIN_ROLE_NAME);
}

export function requireSystemAdministrator(session: AuthSession): boolean {
  return isSystemAdministrator(session.roles);
}
