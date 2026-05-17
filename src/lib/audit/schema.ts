/** Phase 1 authentication event actions. */
type AuthAction =
  | "auth.sign_in.success"
  | "auth.sign_in.failure"
  | "auth.sign_out";

/** Phase 1 session event actions. */
type SessionAction =
  | "session.ip_mismatch"
  | "session.ua_mismatch"
  | "session.revoke"
  | "session.reauth_success"
  | "session.reauth_failure"
  | "session.idle_timeout"
  | "session.absolute_timeout";

/** Account event actions. */
type AccountAction =
  | "account.create"
  | "account.update"
  | "account.delete"
  | "account.lock"
  | "account.unlock"
  | "account.suspend"
  | "account.restore";

/** Phase 2 password event actions. */
type PasswordAction = "password.change" | "password.reset";

/** Customer event actions. */
type CustomerAction =
  | "customer.create"
  | "customer.update"
  | "customer.delete"
  | "customer.assign"
  | "customer.unassign";

/** System settings event actions (#132). */
type SystemSettingsAction = "system_settings.update";

/** Role event actions (#134). */
type RoleAction = "role.create" | "role.update" | "role.delete";

/** MFA event actions (#206, #207, #217, #218, #220, #221). */
type MfaAction =
  | "mfa.totp.enroll"
  | "mfa.totp.remove"
  | "mfa.totp.verify.success"
  | "mfa.totp.verify.failure"
  | "mfa.webauthn.register"
  | "mfa.webauthn.remove"
  | "mfa.webauthn.verify.success"
  | "mfa.webauthn.verify.failure"
  | "mfa.recovery.generate"
  | "mfa.recovery.use"
  | "mfa.enforcement.blocked"
  | "mfa.enrollment.complete"
  | "mfa.admin.reset"
  | "mfa.emergency.reset";

/**
 * Node event actions (#307).
 *
 * `node.apply` is the v1 node-level bulk apply path; per-service apply
 * (`service.apply`) is reserved for Phase Node-12 (#333) and is not added
 * here so that no member exists without an emitter.
 */
type NodeAction =
  | "node.create"
  | "node.update"
  | "node.delete"
  | "node.restart"
  | "node.shutdown"
  | "node.apply";

/**
 * Service event actions (#307).
 *
 * v1 ships only `service.draft_save` and `service.set_mode`. The reserved
 * actions `service.apply` (Phase Node-12 / #333) and `service.set_state`
 * (Phase Node-8 PR 3 / #317) are deliberately NOT added here — each follow-on
 * issue extends this union alongside its emitter to avoid dead-code drift.
 */
type ServiceAction = "service.draft_save" | "service.set_mode";

/**
 * Aimer signing-key event actions (#437).
 *
 * The Aimer integration uses a dedicated ES256 keypair for context-token
 * signing, separate from the JWT signing key. The rotation lifecycle is
 * Generate → Rotate → Switch (after operator confirms aimer-web has
 * registered the new kid) → Deactivate.
 *
 * Targets are scoped to `system_settings` because the keypair is a
 * system-wide artifact owned by the System Administrator role.
 */
type AimerSigningKeyAction =
  | "aimer_signing_key.generated"
  | "aimer_signing_key.rotated"
  | "aimer_signing_key.switched"
  | "aimer_signing_key.deactivated";

/**
 * Aimer integration setting change action (#437).
 *
 * Records updates to `aice_id` and `aimer_web_bridge_url` system
 * settings, which together with the signing keypair gate the Send to
 * Aimer flow.
 */
type AimerIntegrationSettingAction = "aimer_integration_setting.changed";

/**
 * Aimer context-token issuance actions (#439).
 *
 * The route handler `POST /api/aimer/context-token` issues a
 * short-lived ES256-signed context token (plus a stub events
 * envelope) on demand for the Send to Aimer button.  The success
 * path emits `.issued`; every guard / setup / scope failure emits
 * `.denied` with a `reason` detail.
 *
 * The target type is `customer` because the success path is bound to
 * a single resolved customer via the chosen `customerId`.  The denial
 * path may be customer-agnostic (see `customer-scope-policy.ts`),
 * but reusing the `customer` target keeps both rows under the same
 * audit-target taxonomy.
 */
type AimerContextTokenAction =
  | "aimer_context_token.issued"
  | "aimer_context_token.denied";

/**
 * Triage policy CRUD actions (#459).
 *
 * TriagePolicy rows live in the per-customer tenant DB; every row is
 * intrinsically customer-scoped, so the audit emitter populates
 * `customerId` from the route's `customer_id` argument.
 */
type TriagePolicyAction =
  | "triage.policy.create"
  | "triage.policy.update"
  | "triage.policy.delete";

/**
 * Triage Story actions (#490).
 *
 * Curated Story rows live in the per-customer tenant DB (`event_group`
 * with `kind = 'analyst_curated'`); the saved row is intrinsically
 * scoped to one customer, so the audit emitter populates `customerId`
 * from the action's validated input. Auto-correlated Stories produced
 * by cadence are NOT audited per-Story (cadence-level audit covers
 * the run); only the analyst-curated path emits.
 *
 * `triage.story.send` (the LLM submission audit) is owned by #493
 * and added alongside that issue's emitter to avoid dead-code drift.
 */
type TriageStoryAction = "triage.story.create";

/**
 * Triage exclusion CRUD actions (#457).
 *
 * Two scopes:
 *   - `triage_exclusion.global_*` — customer-agnostic. The row lives
 *     in `auth_db.global_triage_exclusion` and applies to every
 *     active customer; the audit row carries no `customerId`. The
 *     in-request enqueue of fanout jobs is logged on the global ADD
 *     row; each per-customer fanout DELETE emits its own
 *     `triage_exclusion.customer_add` row.
 *   - `triage_exclusion.customer_*` — customer-scoped. The row lives
 *     in the tenant DB and applies to exactly one customer.
 *   - `triage_exclusion.fanout_failed` — customer-scoped. Emitted by
 *     the internal fanout worker when a per-customer job exceeds the
 *     retry budget.
 *   - `triage_exclusion.global_recover` — customer-agnostic. Emitted
 *     by the 1B-7 recovery surface when an operator (or the internal
 *     token route) resets a failed global-fanout queue row. The
 *     customer dimension is intentionally absent so the historical
 *     pairing with the original `triage_exclusion.global_add` row
 *     stays clean; the per-customer success rows come from the
 *     fanout worker's `triage_exclusion.customer_add` emissions on
 *     re-run.
 *   - `triage_exclusion.customer_recover` — customer-scoped. Emitted
 *     by the recovery surface when an operator resets a customer-
 *     scoped drain-failure sentinel for a single tenant exclusion.
 *
 * The split honors `customer-scope-policy.ts`'s discipline of "one
 * scope per AuditAction"; there is no `mixed` classification and the
 * exhaustiveness test in
 * `src/__tests__/lib/audit/customer-scope-policy.test.ts` enforces
 * coverage.
 */
type TriageExclusionAction =
  | "triage_exclusion.global_add"
  | "triage_exclusion.global_remove"
  | "triage_exclusion.customer_add"
  | "triage_exclusion.customer_remove"
  | "triage_exclusion.fanout_failed"
  | "triage_exclusion.global_recover"
  | "triage_exclusion.customer_recover";

/**
 * Triage baseline rebuild action (#473).
 *
 * Emitted only after the corpus transaction has committed
 * successfully — pre-commit failures (`RebuildBusy`,
 * `RebuildTimeout`, `RebuildIncomplete`, validation, transaction
 * rollback) leave the corpus unchanged and produce no audit row.
 * Failure-attempt audit rows are intentionally out of scope: they
 * would require fanning the same payload through an audit emitter
 * on every error branch, and the corresponding tenant operator has
 * no actionable signal in "an admin tried to mutate the corpus and
 * the request bounced before any DB write". The structured app log
 * remains the operator-side trace of failed attempts.
 *
 * The action is intrinsically customer-scoped — the rebuild
 * operates against exactly one customer-tenant DB per call, so the
 * emitter populates `customerId` with the route's `customerId`
 * argument. The target reuses the existing `"customer"` target type
 * rather than introducing a first-class "baseline corpus" entity,
 * matching the reuse pattern established for
 * `aimer_context_token.issued`.
 */
type TriageBaselineAction = "triage_baseline.rebuild";

/**
 * Triage policy-run manual Send-to-aimer action (#572).
 *
 * Emitted by the `policy-run/finalize` route after the full multi-batch
 * Send has been acknowledged by aimer-web. The action is intrinsically
 * customer-scoped — `policy_triage_run.id` is unique only within a
 * customer DB, so the audit row carries `customerId` to make it
 * surfaceable to the tenant operator in the audit-log viewer.
 *
 * Partial failures (any batch returns non-2xx, finalize never arrives,
 * or terminal batch missing from `batch_acks`) do NOT emit — β tracking
 * and audit are gated on the finalize call succeeding in the same
 * transaction.
 */
type TriagePolicyRunAction = "triage.policy_run.send_to_aimer";

/** All audit event actions. */
export type AuditAction =
  | AuthAction
  | SessionAction
  | AccountAction
  | PasswordAction
  | CustomerAction
  | SystemSettingsAction
  | RoleAction
  | MfaAction
  | NodeAction
  | ServiceAction
  | AimerSigningKeyAction
  | AimerIntegrationSettingAction
  | AimerContextTokenAction
  | TriagePolicyAction
  | TriageStoryAction
  | TriageExclusionAction
  | TriageBaselineAction
  | TriagePolicyRunAction;

/** Target entity types for audit events. */
export type AuditTargetType =
  | "account"
  | "session"
  | "customer"
  | "system_settings"
  | "role"
  | "mfa"
  | "node"
  | "service"
  | "triage_policy"
  | "triage_story"
  | "triage_exclusion"
  | "triage_policy_run";

/** Canonical runtime list of supported audit actions. */
export const AUDIT_ACTIONS = [
  "auth.sign_in.success",
  "auth.sign_in.failure",
  "auth.sign_out",
  "session.ip_mismatch",
  "session.ua_mismatch",
  "session.revoke",
  "session.reauth_success",
  "session.reauth_failure",
  "session.idle_timeout",
  "session.absolute_timeout",
  "account.create",
  "account.update",
  "account.delete",
  "account.lock",
  "account.unlock",
  "account.suspend",
  "account.restore",
  "password.change",
  "password.reset",
  "customer.create",
  "customer.update",
  "customer.delete",
  "customer.assign",
  "customer.unassign",
  "system_settings.update",
  "role.create",
  "role.update",
  "role.delete",
  "mfa.totp.enroll",
  "mfa.totp.remove",
  "mfa.totp.verify.success",
  "mfa.totp.verify.failure",
  "mfa.webauthn.register",
  "mfa.webauthn.remove",
  "mfa.webauthn.verify.success",
  "mfa.webauthn.verify.failure",
  "mfa.recovery.generate",
  "mfa.recovery.use",
  "mfa.enforcement.blocked",
  "mfa.enrollment.complete",
  "mfa.admin.reset",
  "mfa.emergency.reset",
  "node.create",
  "node.update",
  "node.delete",
  "node.restart",
  "node.shutdown",
  "node.apply",
  "service.draft_save",
  "service.set_mode",
  "aimer_signing_key.generated",
  "aimer_signing_key.rotated",
  "aimer_signing_key.switched",
  "aimer_signing_key.deactivated",
  "aimer_integration_setting.changed",
  "aimer_context_token.issued",
  "aimer_context_token.denied",
  "triage.policy.create",
  "triage.policy.update",
  "triage.policy.delete",
  "triage.story.create",
  "triage_exclusion.global_add",
  "triage_exclusion.global_remove",
  "triage_exclusion.customer_add",
  "triage_exclusion.customer_remove",
  "triage_exclusion.fanout_failed",
  "triage_exclusion.global_recover",
  "triage_exclusion.customer_recover",
  "triage_baseline.rebuild",
  "triage.policy_run.send_to_aimer",
] as const satisfies readonly AuditAction[];

/** Canonical runtime list of supported audit target types. */
export const AUDIT_TARGET_TYPES = [
  "account",
  "session",
  "customer",
  "system_settings",
  "role",
  "mfa",
  "node",
  "service",
  "triage_policy",
  "triage_story",
  "triage_exclusion",
  "triage_policy_run",
] as const satisfies readonly AuditTargetType[];
