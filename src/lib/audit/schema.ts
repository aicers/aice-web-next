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

/** MFA event actions (#206, #207, #217, #218, #220). */
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
  | "mfa.enrollment.complete";

/** All audit event actions. */
export type AuditAction =
  | AuthAction
  | SessionAction
  | AccountAction
  | PasswordAction
  | CustomerAction
  | SystemSettingsAction
  | RoleAction
  | MfaAction;

/** Target entity types for audit events. */
export type AuditTargetType =
  | "account"
  | "session"
  | "customer"
  | "system_settings"
  | "role"
  | "mfa";

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
] as const satisfies readonly AuditAction[];

/** Canonical runtime list of supported audit target types. */
export const AUDIT_TARGET_TYPES = [
  "account",
  "session",
  "customer",
  "system_settings",
  "role",
  "mfa",
] as const satisfies readonly AuditTargetType[];
