import type { AuditAction } from "@/lib/audit/schema";
import { AUDIT_ACTIONS } from "@/lib/audit/schema";

/**
 * Customer-scope classification of every `AuditAction`.
 *
 * - `customer-scoped` — the action concerns a specific customer; the
 *   call site MUST populate `customerId` on the audit event so the
 *   audit-log viewer (#386) surfaces the row to a tenant operator under
 *   the `audit_logs.customer_id IN (...)` predicate.
 * - `customer-agnostic` — the action targets account / session / role /
 *   MFA / system-settings state that has no `customer_id` axis. The
 *   call site intentionally omits `customerId`.
 *
 * The map is exhaustive: every member of `AuditAction` MUST appear here.
 * The accompanying test
 * (`src/__tests__/lib/audit/customer-scope-policy.test.ts`) fails CI if
 * a new `AuditAction` is added without an explicit classification, so a
 * future PR cannot silently introduce a customer-scoped action that
 * records `customer_id: null`.
 */
export const AUDIT_ACTION_CUSTOMER_SCOPE: {
  readonly [A in AuditAction]: "customer-scoped" | "customer-agnostic";
} = {
  // Auth — session / credential surface (no per-customer axis).
  "auth.sign_in.success": "customer-agnostic",
  "auth.sign_in.failure": "customer-agnostic",
  "auth.sign_out": "customer-agnostic",
  "session.ip_mismatch": "customer-agnostic",
  "session.ua_mismatch": "customer-agnostic",
  "session.revoke": "customer-agnostic",
  "session.reauth_success": "customer-agnostic",
  "session.reauth_failure": "customer-agnostic",
  "session.idle_timeout": "customer-agnostic",
  "session.absolute_timeout": "customer-agnostic",
  // Account axis — tenant overlap is enforced on the *account*, not on
  // a customer; the audit row carries no `customer_id`.
  "account.create": "customer-agnostic",
  "account.update": "customer-agnostic",
  "account.delete": "customer-agnostic",
  "account.lock": "customer-agnostic",
  "account.unlock": "customer-agnostic",
  "account.suspend": "customer-agnostic",
  "account.restore": "customer-agnostic",
  "password.change": "customer-agnostic",
  "password.reset": "customer-agnostic",
  // Customer axis — the row IS scoped to a specific customer; emitter
  // MUST populate `customerId`.
  "customer.create": "customer-scoped",
  "customer.update": "customer-scoped",
  "customer.delete": "customer-scoped",
  "customer.assign": "customer-scoped",
  "customer.unassign": "customer-scoped",
  // System-wide config / role admin — no per-customer axis.
  "system_settings.update": "customer-agnostic",
  "role.create": "customer-agnostic",
  "role.update": "customer-agnostic",
  "role.delete": "customer-agnostic",
  // MFA — self-service / break-glass / admin reset; account-axis only.
  "mfa.totp.enroll": "customer-agnostic",
  "mfa.totp.remove": "customer-agnostic",
  "mfa.totp.verify.success": "customer-agnostic",
  "mfa.totp.verify.failure": "customer-agnostic",
  "mfa.webauthn.register": "customer-agnostic",
  "mfa.webauthn.remove": "customer-agnostic",
  "mfa.webauthn.verify.success": "customer-agnostic",
  "mfa.webauthn.verify.failure": "customer-agnostic",
  "mfa.recovery.generate": "customer-agnostic",
  "mfa.recovery.use": "customer-agnostic",
  "mfa.enforcement.blocked": "customer-agnostic",
  "mfa.enrollment.complete": "customer-agnostic",
  "mfa.admin.reset": "customer-agnostic",
  "mfa.emergency.reset": "customer-agnostic",
  // Node / service axis — bound to a customer via the node's
  // `customerId`. Emitter MUST populate `customerId` on the audit
  // event (resolved from the canonical node or the persisted
  // `apply_attempts.customer_id` snapshot).
  "node.create": "customer-scoped",
  "node.update": "customer-scoped",
  "node.delete": "customer-scoped",
  "node.restart": "customer-scoped",
  "node.shutdown": "customer-scoped",
  "node.apply": "customer-scoped",
  "service.draft_save": "customer-scoped",
  "service.set_mode": "customer-scoped",
};

/**
 * Returns the customer-scope classification for an audit action.
 * Throws `TypeError` if the action is not registered — call this from
 * code paths that want a runtime guard rather than a compile-time one.
 */
export function customerScopeForAction(
  action: AuditAction,
): "customer-scoped" | "customer-agnostic" {
  const classification = AUDIT_ACTION_CUSTOMER_SCOPE[action];
  if (!classification) {
    throw new TypeError(
      `Unregistered audit action: ${action}. Add an entry to AUDIT_ACTION_CUSTOMER_SCOPE.`,
    );
  }
  return classification;
}

/**
 * Used by the test guard to enumerate every action declared in the
 * schema and assert one-to-one coverage with the policy map.
 */
export function listAllAuditActions(): readonly AuditAction[] {
  return AUDIT_ACTIONS;
}
