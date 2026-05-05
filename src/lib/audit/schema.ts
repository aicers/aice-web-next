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
  | AimerIntegrationSettingAction;

/** Target entity types for audit events. */
export type AuditTargetType =
  | "account"
  | "session"
  | "customer"
  | "system_settings"
  | "role"
  | "mfa"
  | "node"
  | "service";

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
] as const satisfies readonly AuditTargetType[];
