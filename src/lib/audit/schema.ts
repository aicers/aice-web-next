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
  | ServiceAction;

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
