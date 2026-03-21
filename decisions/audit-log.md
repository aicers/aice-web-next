# Audit Log Architecture

## Context

This document defines the audit log architecture for aice-web-next: what is recorded, where it is stored, and how it is queried. It was extracted from Discussion #32 (Account Management Feature Specification) because the audit log architecture applies beyond account management — any user-initiated system change captured by the BFF is an audit event.

Related documents:

- **Discussion #32** — Account Management Feature Specification (defines the resources and events that produce audit entries)
- **Discussion #34** — Database Migration Strategy (`audit_db` migration runner)
- **Discussion #45** — Backup and Restore Strategy (`audit_db` backup/restore)

---

## 1. Scope

aice-web-next is the **sole producer of audit logs** in the system. All user-initiated changes to the system (account management, role changes, customer operations, system settings, detection rule changes via REview, etc.) pass through aice-web-next as the BFF, so the audit trail is captured at this single entry point. Other services (REview, Giganto, etc.) produce only runtime/application logs, which follow the separate file → REproduce → Giganto path.

### Audit log vs. runtime/application log

| | Audit log | Runtime/application log |
| --- | --- | --- |
| **Producer** | aice-web-next only | All services |
| **Storage** | `audit_db` (PostgreSQL) | File → REproduce → Giganto |
| **Purpose** | Accountability — who did what, when | Debugging, monitoring |
| **Retention** | Long-term (years, compliance-driven) | Short-term (days to weeks, log rotation) |

An event qualifies as an audit log entry if it meets **any** of these criteria:

- **State change**: business data was modified (account created, role changed, setting updated)
- **Security event**: security-relevant even without state change (sign-in failure, IP mismatch detected)
- **Access decision**: authorization was granted or denied (customer access grant, unauthorized access attempt)

The actor may be a specific user (`actor_id` = user UUID) or the system acting under policy rules (`actor_id` = `system`, e.g., automatic account lockout after failed attempts).

---

## 2. Source of Truth — audit_db

- Audit logs are stored in `audit_db`, a **separate PostgreSQL database** dedicated to audit records.
- `audit_db` is the source of truth (SoT).
- Separate from `auth_db` because: (1) audit logs are append-heavy and grow over time, while `auth_db` is small and stable; (2) different retention requirements (audit logs may be preserved for years, `auth_db` backups roll over in 30 days); (3) restoring `auth_db` must not roll back audit records — the audit trail must survive `auth_db` restores.
- Tamper resistance: the application connects to `audit_db` with a role that has INSERT and SELECT only (no UPDATE or DELETE). Additional integrity mechanisms (e.g., application-level hash chain on rows) can be layered on if needed.

---

## 3. Search

The System Administrator can search audit logs in the UI; the BFF queries `audit_db` directly via SQL and enforces the `audit-logs:read` permission before returning results. No dependency on Giganto for audit log search.

---

## 4. Recorded Events

| Category  | Events                                                  |
| --------- | ------------------------------------------------------- |
| Auth      | Sign-in success/failure, sign out, session extension, account lock/unlock, suspended/restored, IP rate limit triggered |
| MFA       | TOTP register/remove, WebAuthn register/remove, MFA reset, recovery code used, break-glass MFA reset |
| Session   | IP or User-Agent mismatch detected, per-session revocation |
| Account   | Create, update, disable, delete, password change/reset  |
| Role      | Create, update, delete, role assign/revoke              |
| Customer  | Create, update, delete, access grant/revoke             |
| System    | Policy changes (password, session, lockout)             |

---

## 5. Log Attributes

| Field            | Type        | Description                                      |
| ---------------- | ----------- | ------------------------------------------------ |
| `timestamp`      | TIMESTAMPTZ | Event time                                       |
| `actor_id`       | TEXT        | Actor (user UUID or `system`)                    |
| `action`         | TEXT        | Event type                                       |
| `target_type`    | TEXT        | Target kind (account, role, policy, etc.)        |
| `target_id`      | TEXT        | Target identifier                                |
| `details`        | JSONB       | Before/after values (excluding passwords/encrypted fields) |
| `ip_address`     | TEXT        | Request source IP                                |
| `sid`            | TEXT        | Session identifier (if applicable)               |
| `customer_id`    | INTEGER     | Related customer (if applicable)                 |
| `correlation_id` | UUID        | Groups related log entries from a single operation (nullable) |

### 5.1 Correlation ID

A single user action can produce multiple log entries — both within `audit_db` (e.g., `account.create` + `role.assign`) and across log types (audit log + runtime/application log). The `correlation_id` field enables post-hoc tracing of all entries originating from the same operation.

#### Generation and propagation

- Each incoming HTTP request (Route Handler or Server Action) generates a UUID v4 correlation ID at the start of processing.
- The ID is propagated through the call stack via `AsyncLocalStorage`, making it available to all code paths within the request without explicit parameter threading.
- System-initiated operations (e.g., bootstrap, scheduled tasks) generate their own correlation ID per operation.

#### Trust policy

- **Server-generated only**: `correlation_id` is always generated server-side (`crypto.randomUUID()`). External headers (`X-Request-ID`, `X-Correlation-ID`, W3C `traceparent`) are **not** accepted as `correlation_id`. This preserves audit integrity — external input could be spoofed or reused to pollute the audit trail.
- If external request tracing is ever needed (e.g., API Gateway → BFF linkage), the external ID should be stored in `details.external_request_id`, not as the `correlation_id`.

#### AsyncLocalStorage boundaries

ALS propagation is reliable only within the same Node.js async context:

| Scope | ALS works? | Approach |
|---|---|---|
| Route Handlers | ✅ Yes | Auto-read via `getCorrelationId()` |
| Server Actions | ✅ Yes | Auto-read via `getCorrelationId()` |
| `instrumentation.ts` hooks | ✅ Yes | Auto-read via `getCorrelationId()` |
| Next.js Middleware (Edge Runtime) | ❌ No | Separate execution context; use `x-correlation-id` header if needed |
| React Server Components | ❌ No | React concurrent scheduling breaks ALS; excluded |
| Background jobs / detached promises | ❌ No | Pass `correlationId` explicitly |

When ALS context is unavailable, callers **must** pass `correlationId` explicitly to `auditLog.record()`.

**Middleware note**: Next.js Middleware runs in Edge Runtime (or a separate worker), so ALS context does not propagate to the subsequent Route Handler. If Middleware-level correlation is needed in the future, the Middleware should set a `x-correlation-id` request header and the Route Handler entry point should read it. Currently Middleware (#61) does not write audit logs, so this is deferred.

#### Schema

```sql
ALTER TABLE audit_logs ADD COLUMN correlation_id UUID;
CREATE INDEX idx_audit_logs_correlation_id
  ON audit_logs (correlation_id)
  WHERE correlation_id IS NOT NULL;
```

- PostgreSQL native `UUID` type: 16 bytes (vs 36+ for TEXT), binary comparison for efficient indexing, DB-level format validation.
- Partial index: excludes NULL rows (pre-correlation entries, standalone system events) to reduce index size and write overhead on a table that grows indefinitely.

#### Audit log integration

- The audit logger (#51) reads `correlation_id` from the async context automatically.
- Callers may also pass it explicitly when the auto-read context is not available.

#### Runtime/application log integration

- When structured logging is used, the `correlationId` field should be included in log output.
- This enables joining audit log entries (in `audit_db`) with runtime log entries (in file/Giganto) by the same correlation ID.

#### Example: sign-in failure leading to account lockout

```
correlation_id = "a1b2c3d4-..."

audit_logs:
  { action: "auth.sign_in_failure", correlation_id: "a1b2c3d4-..." }
  { action: "account.lock",         correlation_id: "a1b2c3d4-..." }

runtime log:
  { level: "warn", msg: "rate limit threshold reached", correlationId: "a1b2c3d4-..." }
```

All three entries share the same `correlation_id`, making them queryable as a group.

Implementation: #65

---

## 6. Suspicious Activity Detection

Audit log-based periodic analysis (queries `audit_db`) + dashboard alerts.

| Detection Indicator             | Description                                      |
| ------------------------------- | ------------------------------------------------ |
| Access from non-allowed IP      | Sign-in attempt from IP not in `allowed_ips` list |
| Consecutive failures            | Linked to two-stage lockout (Discussion #32 §6.3) |
| Off-hours sign-in               | Sign-in outside business hours (logged, not blocked) |
| Session IP/UA mismatch          | IP or User-Agent changed mid-session (Discussion #32 §8.2) |
| Concurrent multi-IP sessions    | Same account active from different IPs simultaneously |
| Rapid sign-in/sign-out cycles   | Possible automation/tool abuse                   |

- Displayed in System Administrator dashboard (Discussion #32 §14).
- Severe events (non-allowed IP access, suspended trigger) show immediate dashboard alerts.

---

## Appendix A. WORM Storage for Long-term Archival

WORM (Write Once, Read Many) storage enforces immutability at the storage layer: once written, data cannot be modified or deleted until a configured retention period expires. This is stronger than the database-level INSERT/SELECT restriction on `audit_db` (§2), which provides tamper-resistance at the application level — a database administrator with sufficient access could still alter rows, whereas WORM provides tamper-prevention even against privileged users.

Two implementation approaches:

- **Software WORM**: S3-compatible object storage (e.g., MinIO, Ceph) with Object Lock enabled. Runs on standard servers; no special hardware required. Retention period and legal hold are enforced by the object storage engine. Practical for most deployments.
- **Hardware WORM**: Dedicated WORM tape drives or optical media (e.g., BD-R). Physical write-once guarantee regardless of software. Required only when regulations mandate hardware-level immutability.

Consideration: if a customer deployment is subject to regulations that require tamper-proof audit log archival (e.g., financial, healthcare, government), audit logs can be periodically exported from `audit_db` and shipped to a WORM-capable object store. `audit_db` (§2) remains the operational SoT; WORM storage serves as the long-term compliance archive. This is not a current requirement and should be evaluated on a per-deployment basis.
