import "server-only";

import type pg from "pg";

import { getCorrelationId } from "@/lib/audit/correlation";
import { connectTo } from "@/lib/db/client";

// ── Sensitive Field Redaction ─────────────────────────────────────

const SENSITIVE_KEYS: ReadonlySet<string> = new Set([
  "password",
  "password_hash",
  "passwordHash",
  "secret",
  "token",
  "accessToken",
  "refreshToken",
  "apiKey",
  "privateKey",
  "credential",
]);

/**
 * Recursively redact sensitive keys from an object.
 *
 * Replaces values of known sensitive keys with `"[REDACTED]"`.
 * Traverses nested plain objects up to the given depth limit.
 */
function sanitizeDetails(
  obj: Record<string, unknown>,
  depth = 0,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    if (SENSITIVE_KEYS.has(key)) {
      result[key] = "[REDACTED]";
    } else if (
      depth < 3 &&
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value)
    ) {
      result[key] = sanitizeDetails(
        value as Record<string, unknown>,
        depth + 1,
      );
    } else {
      result[key] = value;
    }
  }

  return result;
}

// ── Types ─────────────────────────────────────────────────────────

/** Phase 1 authentication event actions. */
type AuthAction =
  | "auth.sign_in.success"
  | "auth.sign_in.failure"
  | "auth.sign_out"
  | "auth.session_extend";

/** Phase 1 session event actions. */
type SessionAction =
  | "session.ip_mismatch"
  | "session.ua_mismatch"
  | "session.ip_ua_mismatch"
  | "session.revoke"
  | "session.reauth_required"
  | "session.reauth_success"
  | "session.reauth_failure"
  | "session.idle_timeout"
  | "session.absolute_timeout";

/** Account event actions. */
type AccountAction =
  | "account.create"
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

/** All audit event actions. */
export type AuditAction =
  | AuthAction
  | SessionAction
  | AccountAction
  | PasswordAction
  | CustomerAction;

/** Target entity types for audit events. */
export type AuditTargetType = "account" | "session" | "customer";

/**
 * Parameters for recording a single audit log entry.
 *
 * `correlationId` is optional — if omitted, it is auto-read from the
 * `AsyncLocalStorage` context set by `withCorrelationId()`.  Pass it
 * explicitly in contexts where ALS is unavailable (background jobs,
 * Edge Middleware, React Server Components).
 */
export interface AuditEvent {
  /** Account ID of the actor, or `"system"` for automated actions. */
  actor: string;
  /** The action being recorded. */
  action: AuditAction;
  /** The type of entity being acted upon. */
  target: AuditTargetType;
  /** Identifier of the target entity (nullable for some events). */
  targetId?: string;
  /** Arbitrary event details. Sensitive fields are auto-redacted. */
  details?: Record<string, unknown>;
  /** Client IP address. */
  ip?: string;
  /** Session ID. */
  sid?: string;
  /** Related customer ID. */
  customerId?: number;
  /** Explicit correlation ID (overrides ALS auto-read). */
  correlationId?: string;
}

// ── Pool Management ───────────────────────────────────────────────

let auditPool: pg.Pool | null = null;

function getAuditPool(): pg.Pool {
  if (auditPool) return auditPool;

  const connectionString = process.env.AUDIT_DATABASE_URL;
  if (!connectionString) {
    throw new Error("Missing environment variable: AUDIT_DATABASE_URL");
  }

  auditPool = connectTo(connectionString);
  return auditPool;
}

// ── SQL ───────────────────────────────────────────────────────────

const INSERT_SQL = `INSERT INTO audit_logs
  (actor_id, action, target_type, target_id, details,
   ip_address, sid, customer_id, correlation_id)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`;

// ── Public API ────────────────────────────────────────────────────

/**
 * Insert a structured audit log entry into `audit_db`.
 *
 * Correlation ID is resolved in order:
 * 1. Explicit `event.correlationId` (if provided)
 * 2. `AsyncLocalStorage` context via `getCorrelationId()`
 * 3. `NULL` (no correlation — standalone event)
 *
 * Sensitive fields in `details` are automatically redacted before
 * serialization.  Database errors propagate to the caller.
 */
async function record(event: AuditEvent): Promise<void> {
  const correlationId = event.correlationId ?? getCorrelationId() ?? null;

  const sanitizedDetails = event.details
    ? JSON.stringify(sanitizeDetails(event.details))
    : null;

  await getAuditPool().query(INSERT_SQL, [
    event.actor,
    event.action,
    event.target,
    event.targetId ?? null,
    sanitizedDetails,
    event.ip ?? null,
    event.sid ?? null,
    event.customerId ?? null,
    correlationId,
  ]);
}

/** Close the audit database pool. Call during graceful shutdown. */
async function endPool(): Promise<void> {
  if (auditPool) {
    await auditPool.end();
    auditPool = null;
  }
}

/** Reset pool reference without closing connections (testing only). */
function resetPool(): void {
  auditPool = null;
}

export const auditLog = {
  record,
  endPool,
  resetPool,
} as const;
