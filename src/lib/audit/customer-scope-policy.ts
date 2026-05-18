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
  // Aimer integration (#437) — system-wide artifacts (signing keypair,
  // aice_id, aimer_web_bridge_url) with no per-customer axis. The
  // per-customer external_key gate lives on a different action set.
  "aimer_signing_key.generated": "customer-agnostic",
  "aimer_signing_key.rotated": "customer-agnostic",
  "aimer_signing_key.switched": "customer-agnostic",
  "aimer_signing_key.deactivated": "customer-agnostic",
  "aimer_integration_setting.changed": "customer-agnostic",
  // Aimer context-token issuance (#439). Issuance only happens after
  // the chosen `customerId` is resolved and verified, so the audit
  // row reliably carries `customerId` — a customer-scoped event.
  "aimer_context_token.issued": "customer-scoped",
  // Denial happens at any of several stages, some of which run before
  // the customer is resolved (`aimer_integration_not_configured`,
  // `rate_limited`) or where the requested customer may not actually
  // exist for the caller (`event_not_found_for_customer`). Forcing
  // this to be customer-scoped would either violate the policy
  // comment ("emitter MUST set customerId") or push toward leaking
  // customer existence by pasting a `requestedCustomerId` into the
  // audit row. `customer-agnostic` is the simpler and safer placement.
  "aimer_context_token.denied": "customer-agnostic",
  // Detection menu Send routing (#621). Phase 2 issuance happens after
  // the chosen `customerId` is resolved and verified, so `.issued`
  // reliably carries `customerId` and is customer-scoped. `.denied`
  // mirrors `aimer_context_token.denied`: denial happens at any of
  // several stages, some of which run before the customer is resolved
  // (rate-limit, integration-not-configured) or where the requested
  // customer may not exist for the caller (cross-tenant 404). Forcing
  // it to customer-scoped would either violate the "emitter MUST set
  // customerId" rule or push toward leaking customer existence via the
  // `requestedCustomerId` detail.
  "aimer_detection_send.issued": "customer-scoped",
  "aimer_detection_send.denied": "customer-agnostic",
  // Triage policy CRUD (#459) — TriagePolicy rows live in the
  // per-customer tenant DB, so every row is intrinsically scoped to
  // the customer the route operates on. Emitter populates `customerId`
  // from the route's required `customer_id` argument.
  "triage.policy.create": "customer-scoped",
  "triage.policy.update": "customer-scoped",
  "triage.policy.delete": "customer-scoped",
  // Triage Story curated-save (#490). The `event_group` row lives in
  // the per-customer tenant DB and the saved Story is intrinsically
  // scoped to one customer; the action's input carries `customerId`
  // explicitly and the emitter populates it.
  "triage.story.create": "customer-scoped",
  // Triage Story Send-to-aimer-web (#493). Each emission carries a
  // single `customerId` (the focused Story's tenant for manual Send,
  // the drain's `(customerId, kind = 'story')` cursor for
  // opportunistic). One row per Story; mixed-customer batches are
  // impossible because every drain is single-customer.
  "triage.story.send": "customer-scoped",
  // Triage exclusion CRUD (#457). Global-scope rows live in
  // `auth_db.global_triage_exclusion` and apply to every active
  // customer; customer-scope rows live in the tenant DB and apply to
  // exactly one customer. Per the "one scope per AuditAction" policy,
  // the global ADD/REMOVE actions are customer-agnostic (they would
  // otherwise need to fan out one row per active customer at the
  // emitter); the per-customer fanout DELETEs emit their own
  // `triage_exclusion.customer_add` row carrying
  // `details.origin = 'global_fanout'` so the spread is observable in
  // the audit-log viewer.
  "triage_exclusion.global_add": "customer-agnostic",
  "triage_exclusion.global_remove": "customer-agnostic",
  "triage_exclusion.customer_add": "customer-scoped",
  "triage_exclusion.customer_remove": "customer-scoped",
  "triage_exclusion.fanout_failed": "customer-scoped",
  // 1B-7 recovery surface. `global_recover` pairs with
  // `global_add`/`global_remove` as customer-agnostic so the audit
  // viewer surfaces it once per operator action rather than once per
  // customer; the per-customer re-run rows come from the fanout
  // worker's own `triage_exclusion.customer_add` emissions on retry.
  // `customer_recover` carries `customer_id` exactly like
  // `customer_add`/`customer_remove` because a customer-scoped
  // exclusion lives in exactly one tenant DB.
  "triage_exclusion.global_recover": "customer-agnostic",
  "triage_exclusion.customer_recover": "customer-scoped",
  // Triage baseline force-rebuild (#473). The rebuild operates on
  // exactly one customer-tenant DB per call; the route's required
  // `customerId` argument is the audit row's `customerId`.
  "triage_baseline.rebuild": "customer-scoped",
  // Triage policy-run manual Send-to-aimer (#572). `policy_triage_run.id`
  // is unique only inside a customer DB, so the audit row is intrinsically
  // scoped to the customer the finalize route operated on.
  "triage.policy_run.send_to_aimer": "customer-scoped",
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
