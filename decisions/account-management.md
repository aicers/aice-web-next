# aice-web-next Account Management Feature Specification (v23)

## Context

This specification defines the account management features for aice-web-next, based on the architecture and security principles established in:

- **Discussion #556**: AICE/Aimer authentication, certificate, session, and data flow design
- **Discussion #555**: Data, authentication, secret, encryption, and audit log design principles

aice-web-next is the **sole owner of account management**. REview/Giganto do not store account information or provide account-related APIs. Communication with REview/Giganto uses mTLS + Context JWT (already implemented). Account data is stored in PostgreSQL.

---

## 1. Role System

### 1.1 Built-in Roles

| Role                       | Description                                         | Deletable |
| -------------------------- | --------------------------------------------------- | --------- |
| **System Administrator**   | Full system, account, role, customer mgmt           | No        |
| **Tenant Administrator**   | Tenant-scoped operations + Security Monitor account mgmt | No   |
| **Security Monitor**       | Event/dashboard read-only                           | No        |

- Built-in roles cannot be deleted, but their permissions can be modified within constraints (see below).
- Auto-created on first system startup.
- Each role has an `mfa_required` attribute (default: `false`) configurable by System Administrator. Determines whether accounts of that role must register MFA before accessing the system.

**Immutable Permission Constraints (System Administrator)**:

The following permissions cannot be removed from System Administrator role to prevent self-lockout:

- `accounts:read`, `accounts:write`, `accounts:delete`
- `roles:read`, `roles:write`, `roles:delete`
- `customers:read`, `customers:write`, `customers:access-all`
- `system-settings:read`, `system-settings:write`

Other permissions on System Administrator may be added/removed freely. Tenant Administrator and Security Monitor have no immutable constraints (all permissions modifiable by System Administrator).

### 1.2 Custom Role

- Created, modified, deleted by System Administrator.
- Defined by combining permissions.
- Can be created by cloning a built-in role.
- Customer assignment required (same as Tenant Administrator and Security Monitor).
- Accounts with a Custom Role are managed (created, updated, deleted) by System Administrator only. Tenant Administrator cannot manage Custom Role accounts.

### 1.3 Permission Model

Resource + action combinations (account management scope):

````
accounts:read        accounts:write       accounts:delete
roles:read           roles:write          roles:delete
customers:read       customers:write      customers:access-all
audit-logs:read
system-settings:read system-settings:write
````

- Data access permissions (events, sensors, policies, dashboards, reports) are out of scope for this specification and will be defined separately.
- Custom roles may combine any of the above permissions.

### 1.4 Default Permission Sets

| Permission              | System Administrator | Tenant Administrator | Security Monitor |
| ----------------------- | :------------------: | :------------------: | :--------------: |
| `accounts:read`         | ✅ 🔒               | ✅ ¹               | —                |
| `accounts:write`        | ✅ 🔒               | ✅ ¹               | —                |
| `accounts:delete`       | ✅ 🔒               | ✅ ¹               | —                |
| `roles:read`            | ✅ 🔒               | —                    | —                |
| `roles:write`           | ✅ 🔒               | —                    | —                |
| `roles:delete`          | ✅ 🔒               | —                    | —                |
| `customers:read`        | ✅ 🔒               | ✅ ²               | —                |
| `customers:write`       | ✅ 🔒               | ✅ ²               | —                |
| `customers:access-all`  | ✅ 🔒               | —                    | —                |
| `audit-logs:read`       | ✅                   | —                    | —                |
| `system-settings:read`  | ✅ 🔒               | —                    | —                |
| `system-settings:write` | ✅ 🔒               | —                    | —                |

🔒 = immutable (System Administrator only, cannot be removed)

¹ Scoped: own assigned customers only, Security Monitor accounts only (role hierarchy per §4.4.1 — cannot manage equal or higher-privilege accounts).

² Scoped: own assigned customers only. System Administrator sees all customers via `customers:access-all`; Tenant Administrator sees only assigned ones.

**Implicit rights (all users, no permission required)**: all users can view their own profile and update `display_name`, `email`, `phone`, `password`, `locale`, `timezone` per §4.4.

- Security Monitor has no account management permissions. Its primary permissions (events, dashboards, etc.) are defined in the data access specification.
- All defaults (except 🔒) can be modified by System Administrator.

---

## 2. Multi-tenant Access Control

### 2.1 Customer Access by Role

| Role                       | Customer access                                          | Configuration                                          |
| -------------------------- | -------------------------------------------------------- | ------------------------------------------------------ |
| **System Administrator**   | `customers:access-all` auto-granted; no individual mapping | Automatic on account creation                          |
| **Tenant Administrator**   | Multiple customers allowed (1+)                          | System Administrator assigns at account creation       |
| **Security Monitor**       | **Single customer only**                                 | System Administrator or Tenant Administrator assigns   |
| **Custom Role**            | Multiple customers (1+)                                  | System Administrator assigns at account creation       |

- `customers:access-all` can only be granted to System Administrator.
- Tenant Administrator, Security Monitor, and Custom Role accounts cannot be created without at least one customer assignment.
- System Administrator can add/remove customer assignments after creation.
- Tenant Administrator can add/remove customer assignments for Security Monitor accounts, but only within their own assigned customers.
- Context JWT includes `customer_ids` so that REview/Giganto return only data the requesting account is authorized to access.

### 2.2 Customer Isolation

| Item                        | Policy                                                                  |
| --------------------------- | ----------------------------------------------------------------------- |
| Customer data (customer_db)   | Separate database per customer                                            |
| Account/auth (auth_db)      | Single database, `account_customer` mapping for access control            |
| API requests                | `customer_id` required for all data queries, access rights enforced     |
| Customer deletion           | customer_db drop + auth_db mapping removal + RocksDB key prefix range delete |

### 2.3 Customer Management

#### Customer Attributes (auth_db)

| Field           | Description                                            |
| --------------- | ------------------------------------------------------ |
| `id` (SERIAL)   | Unique identifier, monotonically increasing, never reused |
| `name`          | Customer display name                                  |
| `description`   | Optional description                                   |
| `created_at`    | Creation timestamp                                     |
| `updated_at`    | Update timestamp                                       |

- `id` uses a sequence (SERIAL/BIGSERIAL) and is never recycled. Deleted customer IDs are permanently retired to ensure consistency across audit logs, Context JWT history, and external system references (e.g., customer_db names, RocksDB key prefixes).
- Additional columns will be added as requirements evolve.

#### Customer CRUD

| Action   | System Administrator | Tenant Administrator       | Security Monitor |
| -------- | :------------------: | :------------------------: | :--------------: |
| Create   | ✅                  | ❌                         | ❌              |
| Read     | ✅ (all)            | ✅ (assigned only)         | ❌              |
| Update   | ✅ (all)            | ✅ (assigned only)         | ❌              |
| Delete   | ✅                  | ❌                         | ❌              |

- **Create**: System Administrator only. Creates a new customer record and the corresponding `customer_db`.
- **Read**: `customers:read` required. System Administrator sees all via `customers:access-all`; Tenant Administrator sees assigned customers only.
- **Update**: `customers:write` required. System Administrator can update any customer; Tenant Administrator can update assigned customers only.
- **Delete**: System Administrator only. Triggers: customer_db drop + auth_db mapping removal + RocksDB key prefix range delete (per §2.2).
- Customer with active account assignments cannot be deleted. All account-customer mappings must be removed first.

---

## 3. DB Separation

````
PostgreSQL
├── auth_db          ← Accounts, roles, sessions (aice-web-next only)
├── audit_db         ← Audit logs (aice-web-next only, separate retention/backup)
└── customer_db (×N) ← Per-customer input data, reports (one per customer)
````

- aice-web-next is the sole owner of auth_db, audit_db, and customer_db. It manages the full lifecycle of customer databases: creation (§2.3), schema migration, and deletion (§2.2).
- REview/Giganto do not manage customer databases or customer metadata. They receive customer information from aice-web-next through two distinct channels:
  - **Context JWT (`customer_ids`)** — authentication/authorization scope. When aice-web-next calls a REview/Giganto API, the JWT carries the requesting account's accessible `customer_ids` so the backend returns only authorized data.
  - **Explicit API calls** — aice-web-next calls REview/Giganto APIs to push the full customer list or other customer attributes (e.g., after customer creation, update, or deletion) so they can keep their local state in sync. **Note:** The exact timing and trigger conditions for these sync calls are critical for data consistency across services and must be carefully designed during implementation.
- auth_db does not store DB connection credentials.
- DB connection credentials are injected from OpenBao.

---

## 4. Account

### 4.1 Account Attributes (auth_db)

| Field                  | Description                                   | Encryption                |
| ---------------------- | --------------------------------------------- | ------------------------- |
| `id` (UUID)            | Unique identifier                             | No                        |
| `username`             | Unique sign-in name                           | No                        |
| `display_name`         | UI display name                               | No                        |
| `password_hash`        | PHC string format (includes algorithm + params) | Hash is self-protecting |
| `email`                | Contact (optional)                            | **Yes** — column encryption |
| `phone`                | Contact (optional)                            | **Yes** — column encryption |
| `status`               | `active`, `locked`, `suspended`, `disabled`   | No                        |
| `token_version`        | Logical session invalidation counter          | No                        |
| `must_change_password` | Force password change on next sign-in         | No                        |
| `mfa_required`         | MFA enforcement override: `null` = follow role default, `true` = required, `false` = exempt | No |
| `failed_sign_in_count` | Consecutive failure count                     | No                        |
| `locked_until`         | Lock release time (null = not locked)         | No                        |
| `max_sessions`         | Per-account max concurrent sessions (null = use global default) | No |
| `allowed_ips`          | Allowed IPs/CIDRs, max 5 (null = no restriction) | No                    |
| `locale`               | Preferred language (null = browser default)    | No                        |
| `timezone`             | Preferred timezone (null = browser default)    | No                        |
| `last_sign_in_at`      | Last sign-in timestamp                        | No                        |
| `password_changed_at`  | Last password change timestamp                | No                        |
| `created_at`           | Creation timestamp                            | No                        |
| `updated_at`           | Update timestamp                              | No                        |

- SSN, passport, card numbers are never stored.
- `email` and `phone` use Envelope Encryption (DEK wrapped by KEK (managed by OpenBao)).
- `allowed_ips`: `null` means no restriction (access from anywhere); when set, max 5 entries. Supports individual IPs and CIDR notation (e.g., `192.168.1.0/24`). System Administrator only.
- `max_sessions`: `null` falls back to global default in System Settings. System Administrator only.
- `locale` and `timezone`: user can change their own. `null` means use browser defaults (`navigator.language`, `Intl.DateTimeFormat().resolvedOptions().timeZone`).

### 4.2 Password Hash Format (PHC String)

Industry de facto standard. A single string contains algorithm, version, parameters, salt, and hash:

````
$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$RdescudvJCsgt3ub+b+daw
````

- No separate column needed for algorithm or parameters.
- On algorithm upgrade, existing hashes are identified by prefix and re-hashed on next successful sign-in (transparent migration).

### 4.3 Column Encryption

- Envelope Encryption per Discussion #555 §9.
- DEK encrypts column value → DEK wrapped by KEK (managed by OpenBao).
- Encryption metadata (`dek_wrapped`, `kek_key_id`, `kek_key_version`, `nonce`) stored alongside.
- Decryption impossible without OpenBao.

### 4.4 Account CRUD

- **Create**: System Administrator can create all account types. Tenant Administrator can create Security Monitor accounts within their own assigned customers. Initial password + `must_change_password=true`. Customer assignment required (except System Administrator).
- **Read**: All users can view their own profile without `accounts:read`. Self-visible fields: `username`, `display_name`, `email`, `phone`, `status`, `locale`, `timezone`, `max_sessions`, `allowed_ips`, `created_at`, `last_sign_in_at`, `password_changed_at`. Internal fields not exposed to self: `failed_sign_in_count`, `locked_until`, `token_version`, `must_change_password`. `accounts:read` enables viewing other accounts (scoped by customer assignment and role hierarchy per §4.4.1).
- **Update**: Self can change `display_name`, `email`, `phone`, `password`, `locale`, `timezone`. All other fields require `accounts:write`. `mfa_required` override is System Administrator only (or Tenant Administrator for Security Monitor accounts within their customers). Tenant Administrator can update other Security Monitor fields within their customers.
- **Disable**: System Administrator can disable any account. Tenant Administrator can disable Security Monitor accounts within their customers. Status → `disabled`, `token_version` incremented (immediate session invalidation).
- **Delete**: System Administrator can delete any account. Tenant Administrator can delete Security Monitor accounts they created. Soft delete (audit trail preserved).

### 4.4.1 Delegated Account Management (Tenant Administrator)

| Action                           | Scope                                      |
| -------------------------------- | ------------------------------------------ |
| Create Security Monitor          | Own assigned customers only                  |
| Assign customer to Security Monitor | Own assigned customers only               |
| Update Security Monitor          | Within own assigned customers                |
| Disable/Delete Security Monitor  | Within own assigned customers                |
| Create Tenant Administrator      | ❌ (System Administrator only)             |
| Create System Administrator      | ❌ (System Administrator only)             |

- Tenant Administrator cannot create accounts with equal or higher privilege (privilege escalation prevention).
- If a customer is unassigned from a Tenant Administrator, that Tenant Administrator immediately loses management rights over all Security Monitor accounts belonging to that customer — even ones they originally created.

### 4.5 System Administrator Account Limits

| Item    | Value                                       |
| ------- | ------------------------------------------- |
| Minimum | 1 (auto-created at first boot, undeletable) |
| Maximum | 5 (hardcoded)                               |

- Maximum is not configurable via UI or System Settings.
- If override is ever needed, use environment variable at deployment time.

### 4.6 Initial Administrator Account

- Installer collects initial admin `username` and `password`.
- Two injection methods (in priority order):
  1. **Secret file**: `/run/secrets/init_admin_username`, `/run/secrets/init_admin_password` — read once, then:
     - Attempt deletion. If successful, done.
     - If deletion fails (e.g., RO mount like Docker Secrets), write a consumed marker to app data directory (`${DATA_DIR}/.init_admin_consumed`) and refuse to re-read the secret files while the marker exists. `DATA_DIR` defaults to `./data` (configurable via environment variable).
  2. **Environment variable**: `INIT_ADMIN_USERNAME`, `INIT_ADMIN_PASSWORD` — fallback if secret files do not exist.
- Secret file takes priority over environment variable if both exist.
- On first startup, aice-web-next reads credentials from the above sources.
- If auth_db has 0 accounts, creates System Administrator account with `must_change_password=true`.
- If accounts already exist, ignores the credentials.
- All account creation logic (hashing, policy validation, DB write) lives solely in aice-web-next.

---

## 5. Password Policy

| Item                           | Default                                            | Configurable |
| ------------------------------ | -------------------------------------------------- | ------------ |
| Minimum length                 | 12 characters                                      | Yes          |
| Maximum length                 | 128 characters                                     | No           |
| Complexity rules               | **Disabled** (NIST SP 800-63B aligned)             | Yes (enable in System Settings) |
| Unicode allowed                | Yes                                                | No           |
| Previous password reuse ban    | Last 5                                             | Yes          |
| Password blocklist             | Top 100K common passwords (bundled, offline)       | No           |
| Periodic password change       | **Disabled** (NIST SP 800-63B aligned)             | Yes (90/180 days, see note below) |
| Compromised password check     | Future: full HIBP dataset (CC0 license)            | —            |

- **Argon2id** hashing with configurable memory/time parameters.
- Password history stored as hashes (for reuse validation).
- **Self change**: current password verification required.
- **Admin reset**: System Administrator sets temporary password → `must_change_password=true`.

### Complexity Rules Note

- NIST SP 800-63B: recommends length over complexity rules.
- ISMS-P / KISA: requires 3+ character type combination for 8+ chars, or 2+ for 10+ chars.
- **Default: disabled** (NIST-aligned). Long passphrase + blocklist provides sufficient security without complexity burden.
- System Settings allows **enabling** complexity rules for ISMS-P compliance (3+ of: uppercase, lowercase, digits, special chars).

### Password Blocklist

- Bundled top 100K common passwords (static file, no external network).
- Checked at password creation and change time.
- Rejection message: generic "password does not meet policy" (no hint about blocklist to avoid information leakage).
- Phase 4: expand to full HIBP dataset (CC0 license, offline k-Anonymity).

### Periodic Password Change Note

- **Default: disabled** (NIST SP 800-63B aligned — periodic change increases weak-password reuse and provides minimal security benefit).
- Current regulations (개인정보의 안전성 확보조치 기준 제5조) do **not** mandate periodic change when sufficient complexity rules are enforced.
- Can be enabled in System Settings if an ISMS-P auditor requires it (configurable period: 90/180 days).

---

## 6. Authentication

### 6.1 Sign-in

- `POST /api/auth/sign-in`
- Username + Password verification.
- Success → session record created (§8.2) → JWT issued (with `sid`) → `HttpOnly + Secure + SameSite=Strict` Cookie.
- If `must_change_password=true` → redirect to password change screen.
- Failure → `failed_sign_in_count` incremented.
- If `allowed_ips` is set, reject sign-in from unlisted IPs before password verification.

### 6.2 Sign Out (3 variants)

| Function               | Action                                               | Who              |
| ---------------------- | ---------------------------------------------------- | ---------------- |
| Current session        | Revoke `sid` + delete cookie                         | Self             |
| All own sessions       | Increment `token_version` (all `sid`s revoked)       | Self             |
| Force sign out (other) | Increment target's `token_version` (all `sid`s revoked) | System Administrator (any account), Tenant Administrator (Security Monitors within their customers) |

### 6.3 Two-stage Account Lockout

**Stage 1: Temporary Lock**

| Item             | Default          | Configurable |
| ---------------- | ---------------- | ------------ |
| Failure threshold | 5 consecutive    | Yes (System Administrator) |
| Lock duration     | 30 minutes       | Yes (System Administrator) |

- Status → `locked`, `locked_until` set.
- Auto-unlocks after duration. `failed_sign_in_count` resets.

**Stage 2: Suspended**

| Item             | Default          | Configurable |
| ---------------- | ---------------- | ------------ |
| Failure threshold after unlock | 3 consecutive | Yes (System Administrator) |

- If user is temporarily locked, then unlocked by time, then fails again past this threshold → Status → `suspended`.
- `suspended` accounts can only be restored by System Administrator.

**DoS Protection — 3-tier Rate Limiting**

Sign-in endpoint uses three independent rate limit buckets:

| Bucket            | Default          | Purpose                               |
| ----------------- | ---------------- | ------------------------------------- |
| **Per-IP**        | 20 / 5 min       | Blocks brute-force from single source |
| **Per-account+IP**| 5 / 5 min        | Limits targeted attack per source     |
| **Global**        | 100 / 1 min      | Caps total sign-in throughput (anti-botnet) |

- Exceeding any bucket → reject with `429 Too Many Requests` + `Retry-After` header.
- Exponential backoff on response time after repeated failures from same IP.
- Rate limits are independent of per-account lockout (§6.3 Stage 1/2) — both apply simultaneously.
- All thresholds configurable in System Settings (§15).

**General API Rate Limiting**

Authenticated API endpoints are not rate-limited per-endpoint. Instead, a general per-user rate limit applies to all authenticated requests (configured in System Settings). Two categories of exceptions with tighter per-user limits:

| Category                  | Reason                                            |
| ------------------------- | ------------------------------------------------- |
| Password change           | Prevents brute-force of current password via API  |
| MFA verification          | Prevents TOTP code brute-force                    |

- Sign-in endpoint rate limits (above) apply regardless of authentication state and are separate from the general API rate limit.

**Account Recovery**

- `locked` → `active`: manual unlock, `failed_sign_in_count` reset.
- `suspended` → `active`: manual restore, `failed_sign_in_count` reset.
- System Administrator can recover any account.
- Tenant Administrator can recover Security Monitor accounts within their customers.
- All recovery actions recorded in audit log.

### 6.4 MFA

MFA is available to all roles. Enforcement is controlled via `mfa_required` at two levels:

| Level        | Who can set                                         | Scope                             |
| ------------ | --------------------------------------------------- | --------------------------------- |
| Role-level   | System Administrator                                | All accounts of that role         |
| Account-level | System Administrator                               | Any account                       |
| Account-level | Tenant Administrator                               | Security Monitor accounts within their assigned customers only |

**Effective MFA Requirement**

| Account `mfa_required` | Role `mfa_required` | Result   |
| ---------------------- | ------------------- | -------- |
| `true`                 | any                 | Required |
| `false`                | any                 | Optional |
| `null`                 | `true`              | Required |
| `null`                 | `false`             | Optional |

- All built-in roles default to `mfa_required = false`.
- When required: first sign-in with ID/PW → forced MFA registration prompt → subsequent sign-ins require MFA.

**MFA Methods (available to all roles)**

| Method             | Description                                                      |
| ------------------ | ---------------------------------------------------------------- |
| **WebAuthn/FIDO2** | Hardware key or platform authenticator (Windows Hello PIN, Touch ID) |
| **TOTP**           | Authenticator app, 30-sec cycle                                  |

System Administrator can restrict which methods are available system-wide via System Settings (§15). Default: both enabled.

| Setting            | Effect                                                           |
| ------------------ | ---------------------------------------------------------------- |
| WebAuthn + TOTP    | Both methods available (default)                                 |
| WebAuthn only      | TOTP registration and sign-in disabled                           |
| TOTP only          | WebAuthn registration and sign-in disabled                       |

- WebAuthn recommended (phishing-resistant, no clock dependency).
- TOTP depends on clock synchronization between the authenticator device and the server. In closed networks without a reliable internal NTP server, clock drift can exceed the ±1 step tolerance (~90 seconds), causing TOTP failures. In such environments, disabling TOTP and requiring WebAuthn only is recommended.
- If a method is disabled after users have already registered with it, those users must register the allowed method before their next sign-in. Existing credentials of the disabled method are no longer accepted for sign-in.
- Falls back to TOTP if WebAuthn credential not registered (only when both methods are enabled).

**Once MFA is registered:**
- **ID/PW-only sign-in is disabled** while MFA is registered.
- MFA can be removed only by System Administrator (or Tenant Administrator for Security Monitors). Removal re-enables ID/PW-only sign-in. If enforcement remains `true`, the account will be prompted to re-register MFA on next sign-in.

**TOTP Details**

- QR code displayed on screen → scan with authenticator app.
- Code validity: 30-second cycle, ±1 step tolerance (~90 seconds clock skew).
- No external network required — works in closed networks.
- Time skew tracking: server records per-user offset if codes consistently match at an offset.

**WebAuthn/FIDO2 Details**

- Register after sign-in.
- Supports: hardware security keys (USB/NFC), platform authenticators (Windows Hello PIN, macOS Touch ID).
- Enables fast re-authentication via biometric/PIN.
- Works offline in closed networks (no attestation server needed).

**MFA Recovery**

- On MFA registration, generate **one-time recovery codes** (10 codes, single-use). Displayed once, user must store securely offline.
- **Storage**: recovery codes stored as one-way hashes (same as passwords). Plaintext is never persisted. Used codes are immediately deleted from DB. On regeneration, all existing codes are invalidated before new ones are issued.
- **Verification**: recovery code input is compared using constant-time comparison (`hmac.Equal` / `crypto.timingSafeEqual`) to prevent timing side-channel attacks.
- Recovery code can substitute MFA during sign-in (each code usable once).
- If all recovery codes exhausted and MFA device lost:
  - **Administrator reset**: System Administrator (or Tenant Administrator for Security Monitors) resets MFA. Requires acting admin's own MFA verification (step-up) if the admin has MFA registered.
  - **Break-glass** (when no other administrator with active MFA can help):
    - Set environment variable `EMERGENCY_MFA_RESET=<username>` and `EMERGENCY_MFA_REASON="<mandatory reason text>"` before restart.
    - On startup, aice-web-next processes the reset **once**: MFA cleared → `must_change_password=true` set → environment variable consumed and ignored on subsequent restarts (tracked via `${DATA_DIR}/.mfa_reset_consumed`).
    - **Expiry**: if not consumed within 10 minutes of process start, the reset is discarded (prevents stale env vars from firing on later restarts).
    - Audit log records (fixed fields): `system` as actor, target username, reason text, timestamp, `request_id` (auto-generated UUID per reset), `operator_id` (OS user or service account that set the env var, if determinable), `deployment_id` (container/ instance identifier), source IP of first sign-in after reset.
    - **Reason is mandatory**: reset without `EMERGENCY_MFA_REASON` is rejected (logged as failed break-glass attempt).
    - **Operational requirement**: remove `EMERGENCY_MFA_RESET` and `EMERGENCY_MFA_REASON` from process environment immediately after restart. Do not include in process environment dumps, debug logs, or crash reports.
- All MFA reset actions recorded in audit log.

---

## 7. JWT Operation

### 7.1 Access JWT Payload

````
{
  "iss": "aice-web-next",
  "sub": "user-uuid",
  "aud": "aice-web-next",
  "iat": 1730000000,
  "exp": 1730000900,
  "sid": "session-uuid",
  "roles": ["Tenant Administrator"],
  "token_version": 3
}
````

- `sid`: per-session identifier. Each sign-in creates a new session with its own `sid`. Enables per-session revocation and tracking.
- `roles`: used by Next.js middleware for route protection. Permission lookup (role → permission set) is performed against a server-side cache; no DB hit per request. Cache is invalidated on role permission change.
- `permissions` claim is **not included**: derivable from `roles` via cache.
- `customer_ids` claim is **not included**: the JWT controls only whether access is granted. Once authenticated, aice-web-next looks up the account's accessible customers from a server-side cache on demand. Included in the inter-service Context JWT (§2.1) when forwarding requests to REview/Giganto.
- JWT header includes `kid` (Key ID) for key rotation support (§11).

### 7.2 Lifetime and Storage

| Item           | Value                                          |
| -------------- | ---------------------------------------------- |
| Expiration     | 15 minutes (configurable, 5–15 min range)      |
| Storage        | `HttpOnly + Secure + SameSite=Strict` Cookie   |
| Refresh Token  | Not used                                       |

**Why Refresh Token is not used**

A Refresh Token serves two primary purposes: (1) renewing a short-lived Access Token without re-authentication, and (2) enabling stateless AT validation in microservice environments where each service verifies the AT independently while only the central Auth server handles renewal.

Neither purpose applies here:

1. **UX role is covered by Sliding Rotation**: Active users never hit the expiry wall because Sliding Rotation (§7.3) automatically reissues the JWT before it expires. The UX benefit of a RT is already provided.

2. **Stateless validation advantage does not apply**: This system is a single BFF — all requests pass through aice-web-next. Furthermore, `token_version` (§7.4) and `sid` validation already require a DB/cache lookup on every request. The premise of "JWT to eliminate DB lookups" does not hold; adding a RT would not reduce the number of DB queries.

3. **Immediate revocation is already implemented**: `token_version` increment revokes all sessions instantly; `sid` invalidation targets a single session. The AT+RT pattern cannot achieve immediate revocation for an AT's remaining lifetime without a separate revocation infrastructure (revocation list, token introspection endpoint), which conflicts with this system's security requirement of instant session invalidation on password change, role change, and forced sign-out.

4. **No third-party clients**: RT is most valuable in OAuth delegation flows where a third-party application acts on behalf of a user over an extended period. This system is internal-only with no third-party delegation.

This design decision is valid under this specific combination of conditions: single BFF architecture, per-request DB lookup already required, immediate revocation mandatory, and no third-party delegation. In microservice architectures, edge/CDN token validation, OAuth/OIDC ecosystems, or extremely high-throughput systems where per-request DB hits are prohibitive, the AT+RT pattern would be the more appropriate choice.

### 7.3 Sliding Rotation

*Sliding Rotation* combines two concepts: **sliding expiration** (the expiry deadline shifts forward on each activity rather than being fixed at issuance) and **token rotation** (the existing JWT is replaced by a newly issued one). Together: whenever the BFF detects activity and the JWT is close to expiry, it issues a fresh JWT with a new `exp`, effectively extending the session without requiring re-authentication.

- When remaining lifetime ≤ 1/3 of total, BFF auto-issues new JWT.
- Grace Period: previous token valid for 30 seconds.
- `iat`-based latest token priority.
- **Active users are never forced to sign in again.**

### 7.4 Revocation

**Bulk revocation** (all sessions):
- JWT `token_version` compared against DB value; mismatch → rejected.
- `token_version` incremented on: password change, role change, customer access change, forced sign out.

**Per-session revocation** (single session):
- JWT `sid` checked against session record; `revoked=true` → rejected.
- Used for: current session sign out, dashboard-initiated single session termination.

---

## 8. Session Management

### 8.1 Session Policy

| Item                  | Default          | Configurable |
| --------------------- | ---------------- | ------------ |
| Idle Timeout          | 30 minutes       | Yes          |
| Absolute Timeout      | 8 hours          | Yes          |
| Max concurrent sessions | No limit (global default) | Yes  |

- Per-account `max_sessions` overrides global default when set.
- Exceeding max sessions → new sign-in rejected.

### 8.2 Per-session Tracking

Each sign-in creates a session record in auth_db:

| Field           | Description                                          |
| --------------- | ---------------------------------------------------- |
| `sid`           | UUID, included in JWT `sid` claim                    |
| `account_id`    | Owner account                                        |
| `ip_address`    | Sign-in source IP                                    |
| `user_agent`    | Browser User-Agent string                            |
| `created_at`    | Sign-in timestamp                                    |
| `last_active_at`| Last Sliding Rotation timestamp                      |
| `revoked`       | Boolean, set on sign out or force revocation         |

- JWT validation checks: `sid` exists in DB, not revoked.
- Session validation: risk-based step-up by comparing current request IP and User-Agent against stored `ip_address` and `user_agent`.

  | Change                    | Risk    | Action                             |
  | ------------------------- | ------- | ---------------------------------- |
  | IP only (UA same)         | Low     | Log (Discussion #46 §6), proceed, **no re-auth** |
  | UA minor version change   | Low     | Log (Discussion #46 §6), proceed, **no re-auth** |
  | UA major change (IP same) | Medium  | Log (Discussion #46 §6), **require re-auth**     |
  | IP + UA both              | High    | Log (Discussion #46 §6), **require re-auth**     |

  - **UA comparison**: extract browser family + major version (e.g., `Chrome/131`). Minor/patch version changes (e.g., `131.0.6778` → `131.0.6779`) are ignored to tolerate browser auto-updates.
  - Re-auth: session flagged `needs_reauth` → return 401 with re-authentication prompt → user re-enters password or MFA → `ip_address` and `user_agent` updated to current values → session continues.
  - Session itself is not revoked (preserves user context).
  - IP-only change without re-auth: accounts for VPN reconnect, DHCP renewal, network switch in closed network environments.
- `token_version` increment revokes **all** sessions; `sid`-based revocation targets a **single** session.
- Dashboard (§14) uses session records for active session display.

### 8.3 Session Extension Dialog

When no server requests have been made and JWT expiration approaches, display a dialog asking the user whether to extend.

**Display condition:**
- JWT remaining lifetime ≤ 1/5 of total (e.g., 3 minutes for 15-min token).
- No Sliding Rotation has occurred (no server requests in the period).

**Dialog behavior:**

| User action           | Result                                                       |
| --------------------- | ------------------------------------------------------------ |
| **[Extend] click**    | `GET /api/auth/me` → Sliding Rotation → new JWT → dialog closes |
| **[Sign out] click**  | Immediate sign out                                           |
| **No response**       | Countdown expires → JWT expires → redirect to sign-in        |

**Relationship with active usage:**

| Situation                      | Behavior                                    |
| ------------------------------ | ------------------------------------------- |
| Active (server requests occur) | Sliding Rotation auto-renews, **no dialog** |
| Reading only (no requests)     | Dialog appears near expiry → click to extend |
| Away from desk                 | Dialog appears → no response → expires → redirect to sign-in |

---

## 9. CSRF (Cross-Site Request Forgery) Protection

CSRF is an attack where a malicious site causes the user's browser to submit a forged request to this application while the user is already authenticated. Because the browser automatically attaches the session cookie, the server cannot distinguish the forged request from a legitimate one without an additional verification mechanism.

The Double Submit Cookie pattern counters this by exploiting an asymmetry enforced by the browser's Same-Origin Policy (SOP): a malicious site can cause the browser to *send* a request (with cookies attached), but it cannot *read* cookies belonging to another origin. The server issues a token in a cookie (`HttpOnly=false`) and requires the client to echo it back in a custom request header (`X-CSRF-Token`). Client-side JavaScript reads the cookie and copies it into the header — something only code running on the legitimate origin can do. A forged request from a malicious site arrives without the header value, and is rejected.

Plain Double Submit Cookie has one weakness: if an attacker can inject a cookie (e.g., via a subdomain), they can set both the cookie and the header to the same arbitrary value and pass the equality check. Adding HMAC closes this gap — the server does not merely check that cookie equals header; it verifies that the token is a valid signature produced with a server-side secret. Without that secret, a forged token fails verification regardless of how the cookie was set.

**HMAC-based Double Submit Cookie** (session-bound):

- Token formula: `HMAC-SHA256(sid + nonce + issued_at, server_secret)`. Transmitted as `nonce.issued_at.signature`.
- On sign-in and each Sliding Rotation, generate new CSRF token (new nonce + issued_at).
- Token set as cookie (`__Host-csrf`, `Secure=true`, `HttpOnly=false`, `SameSite=Strict`, `Path=/`) and sent in response header.
- Client includes token in `X-CSRF-Token` header on state-changing requests.
- Server parses token, recomputes HMAC from `sid` + extracted nonce + issued_at, and compares signature.
- **Validation rules**: reject if signature mismatch, `sid` mismatch, or `issued_at` older than current JWT's `iat` (stale token).
- **Session-bound**: token is tied to `sid`, not reusable across sessions.
- Validated on all state-changing requests (POST/PUT/PATCH/DELETE) to **Route Handlers** (`/api/auth/*` and any future API routes).
- **Server Actions** are exempt: Next.js enforces its own CSRF protection (Origin check, encrypted Action IDs) for Server Actions. Business mutations use Server Actions exclusively.
- **Origin/Referer verification**: additionally check `Origin` header (or `Referer` if `Origin` absent) against the expected app origin. Reject requests from mismatched origins. This provides defense-in-depth alongside HMAC token validation.

---

## 10. Context Token (aimer-web Handoff)

| Item       | Value                                  |
| ---------- | -------------------------------------- |
| Lifetime   | 30 seconds – 2 minutes                |
| Usage      | One-time                               |
| Payload    | `iss`, `sub`, `aice_id`, `iat`, `exp`, `jti` |

- Used `jti` recorded until expiry to prevent replay.
- Not an auth token — origin identification only.

---

## 11. Secret Management (Bootroot / OpenBao)

**Bootroot** is the in-house PKI bootstrap and trust foundation that manages mTLS certificate issuance and rotation using step-ca and OpenBao. The same OpenBao instance managed by Bootroot will also serve as the secret store for aice-web-next application secrets. Secrets are stored in OpenBao KV v2 and rendered to local files by OpenBao Agent; the column encryption KEK is the exception and uses OpenBao Transit Engine (key never leaves OpenBao).

**Development ordering**: Adding aice-web-next as a managed service in Bootroot requires coordination with the Bootroot operator (AppRole provisioning, KV v2 path policy, Transit engine configuration). aice-web-next is developed without Bootroot first; Bootroot integration is introduced in Phase 3 (see §16). Until then, secrets are supplied via environment variables or config files injected at deployment time.

| Secret type                                   | Storage                              | Rotation                                                                              | Until Bootroot integration                                  |
| --------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| PostgreSQL credentials (auth_db, audit_db, customer_db) | OpenBao KV v2 (via Bootroot)         | `bootroot rotate db`; OpenBao Agent re-renders credentials to file                   | Environment variable                                        |
| JWT signing key (dedicated, separate from mTLS) | **Filesystem**                     | `kid`-based: two keys active during transition; old key removed after AT expiry window | Same (filesystem, manually managed)                        |
| Column encryption KEK                         | **OpenBao Transit Engine** (via Bootroot) | `bootroot rotate kek`: rotate Transit key → rewrap all DEKs → advance `min_decryption_version`; no column data re-encryption | Column encryption deferred until Bootroot integration |
| CSRF server secret                            | OpenBao KV v2 (via Bootroot)         | On-demand via Bootroot CLI; existing CSRF tokens invalidated on rotation              | Environment variable                                        |
| mTLS certificates/keys                        | Filesystem (managed by Bootroot)     | Auto-rotated by Bootroot (existing impl)                                              | Already integrated                                          |

- **JWT key is separate from mTLS certificate** — different lifecycle, rotation schedule, and trust scope. No key reuse across purposes. step-ca issues X.509 certificates only; it cannot issue standalone JWT signing key material. The JWT key lifecycle (generation, rotation) is managed independently of Bootroot.
- JWT key includes `kid` (Key ID) in header for rotation support. Two keys active during rotation window (old key validates existing tokens, new key signs new tokens).
- No credentials in code, Git, or DB.
- OpenBao failure mitigation: application cache (TTL) + break-glass procedure.

---

## 12. Audit Log

See **Discussion #46** — Audit Log Architecture.

Account management events defined in this specification (auth, MFA, session, account, role, customer, system settings) are recorded as audit log entries in `audit_db`. Discussion #46 covers the full audit log architecture: storage (`audit_db`), search, recorded events, log attributes, and suspicious activity detection.

---

## 14. System Administrator Dashboard

Three views for System Administrator:

| View                    | Content                                        |
| ----------------------- | ---------------------------------------------- |
| Active sessions         | Account, IP, sign-in time, session count       |
| Locked accounts         | Account, lock reason, unlock scheduled time    |
| Suspended accounts      | Account, suspended time, recovery action       |

Plus:
- Suspicious activity alerts (Discussion #46 §6).
- Quick actions: force sign out, unlock, restore.

---

## 15. System Settings

Configurable by System Administrator:

| Setting group      | Items                                                 |
| ------------------ | ----------------------------------------------------- |
| Password policy    | Min length, complexity toggle (default off), reuse ban count, periodic change toggle + period (§5) |
| Session policy     | Idle Timeout, Absolute Timeout, global max sessions   |
| Lockout policy     | Stage 1: failure threshold + duration; Stage 2: failure threshold |
| Sign-in rate limit | Per-IP, per-account+IP, global thresholds and windows |
| API rate limit     | General: per-user threshold for authenticated requests; Sensitive ops (password change, MFA verify): tighter per-user limits |
| JWT policy         | Access Token expiration time                          |
| MFA policy         | Allowed MFA methods: WebAuthn + TOTP (default) / WebAuthn only / TOTP only |

- Changes recorded in audit log.
- Stored in auth_db. Defaults hardcoded in application code.

---

## 16. Implementation Phases

````
Phase 1 — Core Authentication
├── ID/PW sign-in and sign out (3 variants)
├── JWT issuance, validation, Sliding Rotation
├── Per-session tracking (sid + IP + User-Agent)
├── Session extension dialog
├── CSRF protection (HMAC Double Submit Cookie)
├── IP rate limiting on sign-in endpoint (DoS protection)
├── Next.js Middleware (route protection)
├── Initial admin account (secret file / env var bootstrap)
├── Per-account allowed IPs (CIDR support, max 5)
├── Per-account max concurrent sessions
└── Audit log (audit_db, PostgreSQL)

Phase 2 — Account Management
├── Account CRUD (System Administrator + Tenant Administrator delegation)
├── Password change, reset, policy enforcement
├── Password blocklist (top 100K, bundled offline)
├── Two-stage lockout (temporary lock → suspended)
├── Account recovery (unlock / restore, delegated to Tenant Administrator)
├── RBAC (role + permission based route protection)
├── Customer management (CRUD, System Administrator + Tenant Administrator update)
├── Multi-tenant access control (account_customer mapping)
└── Per-account locale and timezone

Phase 3 — Operations
├── System Administrator dashboard (sessions, locks, suspended)
├── System Settings UI
├── Custom Role management UI
├── Suspicious activity detection (Discussion #46 §6)
└── Certificate expiry detection alerts

Phase 4 — MFA & Security Hardening (requires external coordination)
├── MFA — WebAuthn/FIDO2 (available to all roles)
├── MFA — TOTP (available to all roles)
├── MFA enforcement (per-role `mfa_required` + per-account override)
├── Bootroot service integration (prerequisite for column encryption and DB credential rotation)
│   ├── Add aice-web-next as a managed service in Bootroot (AppRole, KV v2 path policy, Transit engine — coordinated with Bootroot operator)
│   ├── Switch PostgreSQL credentials: env var → OpenBao KV v2 (via Bootroot), rendered to file by OpenBao Agent
│   └── Switch CSRF server secret: env var → OpenBao KV v2 (via Bootroot), rendered to file by OpenBao Agent
├── Column encryption (OpenBao Transit Engine, via Bootroot) — requires Bootroot integration
├── Compromised password check (full HIBP dataset, CC0, offline k-Anonymity)
└── Context Token (aimer-web handoff)
````

---

## Appendix A. Roadmap Items (Non-normative)

Items in this appendix are **planned enhancements**, not current requirements. They do not affect implementation of the normative sections above.

### A.1 Break-glass OpenBao Token

Replace environment variable `EMERGENCY_MFA_RESET` with an OpenBao-issued one-time token (`EMERGENCY_MFA_RESET_TOKEN`):

- **Mechanism**: OpenBao Cubbyhole or Response-wrapping.
- Token is cryptographically opaque, single-use, and TTL-bound by OpenBao itself.
- Eliminates the need for app-side expiry timer and consumed marker logic.
- Requires OpenBao availability during break-glass (trade-off vs. current env var approach which works even if OpenBao is down).

### A.2 Compromised Password Check (HIBP)

Full HIBP dataset integration (CC0 license, offline k-Anonymity). Scheduled for Phase 4 (see §16).

### A.3 WORM Storage for Audit Log Long-term Archival

See **Discussion #46** Appendix A.




