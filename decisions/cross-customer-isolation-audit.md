# Cross-customer isolation — gap report

Sub-issue: #385. Umbrella: #382. Sister sub-issues: #386 (audit-log viewer
leak — already known, fixed independently), #387 (hardening sweep), #388
(regression guards).

This document is the input to #387/#388. It enumerates every customer-data
path in `aice-web-next` and classifies each one against the project
principle:

> An account that is restricted to a subset of customers must not have any
> path — UI, API, log, error message, or otherwise — that exposes
> information from a customer outside that subset.

Classification key (used throughout):

| Class | Meaning |
|---|---|
| `scoped` | Applies customer scope (`buildDispatchContext` for REview/external; `account_customer` JOIN or `customer_id IN (...)` for local DB) |
| `admin-only` | Gated by `customers:access-all` (or another permission only granted to a global admin role) |
| `customer-agnostic` | Endpoint deals with non-customer data (session/auth/MFA/account/role/system settings) |
| `LEAK` | Returns or mutates customer-scoped data without scope enforcement |
| `unknown` | Could not classify with confidence — flagged for manual review |

Findings are de-duplicated: the same underlying issue is referenced from
section 7, not repeated in every section.

---

## 1. Server actions / API routes inventory

### `src/app/api/**/route.ts`

#### Auth (`/api/auth/**`)

| Route | Class | Notes |
|---|---|---|
| `/api/auth/me` | customer-agnostic | Returns own session/account |
| `/api/auth/sign-in`, `/sign-out`, `/sign-out-all`, `/reauth`, `/password` | customer-agnostic | Session / credential ops |
| `/api/auth/mfa/totp/**`, `/webauthn/**`, `/recovery/**`, `/enrollment-complete` | customer-agnostic | Self-owned MFA credentials only |

#### Accounts & roles (`/api/accounts/**`, `/api/roles/**`)

| Route | Class | Notes |
|---|---|---|
| `/api/accounts` (GET, POST) | scoped | Permission-gated (`accounts:read` / `accounts:write`). `access-all` callers see all rows; non-`access-all` callers are scoped via an `account_customer` subquery so they only see/manage accounts whose customer set overlaps theirs. POST has a customer-enumeration leak on the `customerIds` payload — see §4. (Classified `scoped`, not `admin-only`: the route is reachable by tenant admins and applies tenant-overlap scoping, so "scope check unnecessary" is not accurate.) |
| `/api/accounts/[id]` (GET, PATCH, DELETE) | scoped | Permission gate plus tenant-overlap check via `getAccountCustomerIds` for non-`access-all` callers (`route.ts:70-82, 136-143, 393-399`). Reachable by tenant admins, so the `admin-only` label would understate the scope work performed; the row-level scope sits on the *account* axis ("which customers does the target manage") rather than `customer_id`, but the route still applies customer-overlap enforcement and so is classified `scoped` for taxonomy consistency. |
| `/api/accounts/[id]/customers` (GET, POST) | scoped | `account_customer` JOIN; tenant admin can only assign within own scope. POST has a customer-enumeration leak — see §4 |
| `/api/accounts/[id]/customers/[customerId]` (DELETE) | scoped | Same shape; explicit scope check before unassign |
| `/api/accounts/[id]/unlock`, `/password-reset`, `/mfa-reset` | scoped | Permission-gated account-management ops; non-`access-all` callers gated by tenant-overlap check on the target account (`getAccountCustomerIds` / `validateManagedAccountTarget`). No per-customer data returned, but the *target* is tenant-scoped, so classified `scoped` for taxonomy consistency with the sibling accounts routes |
| `/api/accounts/me/preferences` | customer-agnostic | Self locale/timezone preferences |
| `/api/roles`, `/api/roles/[id]`, `/api/roles/[id]/mfa-required` | admin-only | Roles are system-wide; gated by `roles:write` / `roles:read`, which the project treats as a global-admin permission |

#### Customers (`/api/customers/**`)

| Route | Class | Notes |
|---|---|---|
| `/api/customers` (GET) | scoped | `access-all` returns all rows; otherwise `JOIN account_customer` against caller |
| `/api/customers` (POST) | scoped | Gated by `customers:write` only — *not* admin-gated. A non-`access-all` caller with `customers:write` can create customer rows; the new row has no `account_customer` link until POST `/api/accounts/[id]/customers` runs. The audit emit at line 146 is a finding — see §3 |
| `/api/customers/[id]` (GET, PATCH) | scoped | `access-all`-or-`account_customer`-JOIN check at `[id]/route.ts:62, 138` before read/mutation. Audit emit on PATCH at line 177 is a finding — see §3 |
| `/api/customers/[id]` (DELETE) | **LEAK** | Gated by `customers:delete` only. The handler checks existence and refuses if any `account_customer` link remains, but it does **not** check that the caller has scope on the customer (no `account_customer WHERE account_id = session.accountId AND customer_id = $1`). A non-`access-all` caller with `customers:delete` can therefore drop any unlinked customer's database row + DB. Audit emit at line 248 also omits `customerId` — see §3 |

#### Customer-scoped data plane (`/api/nodes/**`, `/api/services/external/**`, `/api/detection/export`)

| Route | Class | Notes |
|---|---|---|
| `/api/nodes` (POST) | scoped | `nodes:write + services:write`; routes through `createNodeWithAudit` → `buildDispatchContext` |
| `/api/nodes/[id]` (GET, PATCH, DELETE) | scoped | Combined node+service permission; `getNode` / `updateNodeWithAudit` / `removeNodes` all `assertNodeInScope` post-fetch |
| `/api/nodes/[id]/restart`, `/shutdown` | scoped | `nodeReboot` / `nodeShutdown` via `buildDispatchContext` |
| `/api/nodes/status` | scoped | `getNodeStatusList` materialises `customerIds` |
| `/api/services/external/giganto/status`, `/tivan/status` | scoped | `getGigantoStatus` / `getTivanStatus` flow through `buildDispatchContext` |
| `/api/detection/export` | scoped | `fetchExportRowCount` → `buildDispatchContext`; CSV stream uses same scope |

#### Dashboard (`/api/dashboard/**`)

| Route | Class | Notes |
|---|---|---|
| `/api/dashboard/alerts` | admin-only | `dashboard:read`; suspicious-activity rules over global session/account state — no customer-scoped data |
| `/api/dashboard/sessions`, `/[sid]/revoke` | admin-only | Global session list / revoke; permission-gated |
| `/api/dashboard/locked-accounts` | admin-only | Global lock list |
| `/api/dashboard/cert-status` | admin-only | mTLS deployment config, not customer-scoped |

#### Audit logs (`/api/audit-logs`)

| Route | Class | Notes |
|---|---|---|
| `/api/audit-logs` (GET) | **LEAK** | Confirmed leak; fix owned by **#386**. No `customer_id` predicate against caller's effective scope. Documented here for completeness only |

#### System / internal / e2e

| Route | Class | Notes |
|---|---|---|
| `/api/system-settings`, `/[key]` | customer-agnostic | Global config (password / MFA / lockout / JWT policies) |
| `/api/internal/apply-attempts/cleanup` | customer-agnostic | Internal-token-gated maintenance job; runs as `system` actor. See §3 LEAK on the audit it emits |
| `/api/e2e/reset-mfa-policy`, `/reset-rate-limits` | customer-agnostic | Test-only, behind `NODE_ENV !== "production"` |

### `src/lib/**/server-actions.ts` and equivalent

| Module | Exported actions | Class |
|---|---|---|
| `src/lib/node/server-actions.ts` | `listNodes`, `getNode`, `fetchSlimNodeMetadata`, `listNodeStatuses`, `insertNode`, `updateNodeDraft`, `removeNodes`, `nodeReboot`, `nodeShutdown`, `getGigantoStatus`/`Config`/`updateGigantoConfig`, `getTivanStatus`/`Config`/`updateTivanConfig` | All `scoped` via `buildDispatchContext` + `assertNodeInScope` |
| `src/lib/detection/server-actions.ts` | `searchEvents`, `searchEventsAtAnchor`, `countEventsBy*` (category/level/country/kind/ip/originatorIp/responderIp), `eventFrequencySeries`, `fetchEventByLocator` | All `scoped` via local `buildDispatchContext(session, filter)` |
| `src/lib/detection/server-actions.ts` | `lookupIpLocation` | `customer-agnostic` — IP geolocation, no customer data |
| `src/app/[locale]/(dashboard)/detection/actions.ts` | `runEventQuery` | `scoped` — wraps `searchEventsAtAnchor` |
| `src/app/[locale]/(dashboard)/detection/analytics-actions.ts` | `runAnalyticsQuery` | `scoped` — wraps `countEventsBy*` (category/level/country/kind/srcIp/dstIp via `dispatch`) and `eventFrequencySeries`; both flow through the Detection-track `buildDispatchContext` |
| `src/app/[locale]/(dashboard)/detection/sensor-actions.ts` | `fetchSensors` | `scoped` — wraps `listSensors`, which signs the Context JWT with `session.customerIds`; the returned sensor list is already restricted to the caller's accessible customers |
| `src/app/[locale]/(dashboard)/detection/saved-filter-actions.ts` | `listSavedFilters`, `saveFilter`, `renameFilter`, `deleteFilter` | `scoped` — DB ownership scoped by `owner_account_id = session.accountId`. The persisted `filter_json` payload may embed a `customers` selection from a previous scope; running a saved filter goes back through the Detection BFF whose customer-intersection check is owned by **#384** (referenced in §7, not duplicated). The saved-filter actions themselves do not leak across accounts |

---

## 2. DB query inventory

Scope: every **semantic SQL call site** — every `query(...)`,
`query<T>(...)`, `pool.query(...)`, `client.query(...)`,
`client.query<T>(...)`, and the audit-DB wrapper `queryAudit(...)` /
`queryAudit<T>(...)` — under `src/lib/**` and
`src/app/api/**/route.ts`. Generic-typed forms (`query<Row>(...)`) are
included alongside untyped forms; they are the same DB call.
Migrations and test harnesses excluded.

The thin DB-helper plumbing (the bodies of `query` / `withTransaction`
in `src/lib/db/client.ts` and `queryAudit` in `src/lib/audit/client.ts`)
is **explicitly excluded** from the per-call-site inventory below
because it is pass-through plumbing that forwards
`text` / `params` / `BEGIN` / `COMMIT` / `ROLLBACK` straight to the
underlying `pg` driver and never embeds a customer predicate.
Semantic ownership lives at each helper's caller, which is what this
inventory enumerates. Listed once for completeness so the helpers are
not invisible:

- `src/lib/db/client.ts:28` — `getPool().query<T>(text, params)` inside `query()`; pass-through wrapper, no SQL of its own
- `src/lib/db/client.ts:37, :39, :42` — `client.query("BEGIN" / "COMMIT" / "ROLLBACK")` inside `withTransaction()`; transaction-control statements, customer-agnostic
- `src/lib/audit/client.ts:34` — `getPool().query<T>(text, params)` inside `queryAudit()`; pass-through wrapper against the audit DB

### Scoped — operates on customer-scoped tables under explicit scope

- `src/lib/auth/customer-scope.ts:14` — `SELECT customer_id FROM account_customer WHERE account_id = $1` (resolves caller scope)
- `src/lib/auth/customer-scope.ts:29` — `SELECT id FROM customers ORDER BY id` (used only after `customers:access-all` check)
- `src/app/api/customers/route.ts:61` — `SELECT * FROM customers ORDER BY ...` (the `access-all` branch's listing)
- `src/app/api/customers/route.ts:66` — `SELECT * FROM customers c JOIN account_customer ac ON ac.customer_id = c.id WHERE ac.account_id = $1` (the tenant-scoped listing)
- `src/app/api/customers/route.ts:119` — `SELECT * FROM customers WHERE id = $1` (post-create read-back inside POST)
- `src/app/api/customers/route.ts:132` — `DELETE FROM customers WHERE id = $1` (rollback path inside POST when database provisioning fails)
- `src/app/api/customers/route.ts:137` — `SELECT * FROM customers WHERE status = 'active' ORDER BY ...` (post-create active-customers list)
- `src/app/api/customers/[id]/route.ts:45` — `SELECT * FROM customers WHERE id = $1` (GET target)
- `src/app/api/customers/[id]/route.ts:62` — `SELECT customer_id FROM account_customer WHERE account_id = $1 AND customer_id = $2` (GET tenant-scope check, runs only on the non-`access-all` branch)
- `src/app/api/customers/[id]/route.ts:121` — `SELECT * FROM customers WHERE id = $1` (PATCH precondition)
- `src/app/api/customers/[id]/route.ts:138` — `SELECT customer_id FROM account_customer WHERE account_id = $1 AND customer_id = $2` (PATCH tenant-scope check, non-`access-all` branch)
- `src/app/api/customers/[id]/route.ts:171` — `UPDATE customers SET ... WHERE id = $1` (PATCH commit, after the scope check above)
- `src/app/api/accounts/[id]/customers/route.ts:72` — `JOIN account_customer ac` + `JOIN customers c`; tenant scope check (lines 53–69) runs before the SELECT
- `src/app/api/accounts/[id]/customers/route.ts:197, 204, 223` — transactional account-customer assignment queries; tenant scope check at line 173 runs before the transaction
- `src/app/api/accounts/[id]/customers/[customerId]/route.ts:51, 81` — verify-then-delete; explicit scope check between
- `src/app/api/accounts/route.ts:134` — `account_customer` subquery used to filter visible accounts in the GET listing
- `src/app/api/accounts/route.ts:145` — `accounts` listing with the visibility filter from `:134` applied
- `src/app/api/accounts/route.ts:436` — `accounts` post-insert refetch (within the create-account transaction; scope already enforced by the path above)
- `src/lib/node/apply-attempts.ts:144` — `INSERT INTO apply_attempts (...)` inside `createApplyAttempt`; the public entry point pre-resolves the node via `assertNodeInScope` before reaching this insert
- `src/lib/node/apply-history.ts:21` — `SELECT MAX(...) FROM apply_attempts WHERE node_id = $1 AND status = 'succeeded'` (last-applied-at on the detail page); reachable only from the scoped `getNode` / detail-page path that has already run `assertNodeInScope`

### Scoped — internal `apply_attempts` state machine (auth DB)

All call sites operate on `apply_attempts` and are keyed on `attempt_id`
(UUID, opaque). Public entry points pre-resolve the node via
`buildDispatchContext` + `assertNodeInScope`; the internal cleanup
endpoint runs as `system` actor behind a static token. Listed
per-call-site so #387/#388 do not have to re-derive the inventory:

`src/lib/node/apply-attempt-lifecycle.ts`:

- `:515` — `UPDATE apply_attempts SET executing_lock = $1 WHERE attempt_id = ...` (confirm-mode lock claim)
- `:537` — `UPDATE apply_attempts SET executing_lock = $1 WHERE attempt_id = ...` (retry-mode lock claim, JSON-path guard)
- `:809` — `UPDATE apply_attempts ... WHERE attempt_id = $... AND executing_lock = $3` (stale-lock clear under guard)
- `:863` — `UPDATE apply_attempts ... WHERE attempt_id = $... AND executing_lock = $4` (success + final state cascade)
- `:887` — `UPDATE apply_attempts ... WHERE attempt_id = $... AND executing_lock = $3` (dispatch advance)
- `:938` — `UPDATE apply_attempts ... WHERE attempt_id = $... AND executing_lock = $4` (terminal-state cascade)
- `:959` — `UPDATE apply_attempts ... WHERE attempt_id = $... AND executing_lock = $3` (soft-failure transition)
- `:989` — `UPDATE apply_attempts ... WHERE attempt_id = $... AND executing_lock = $4` (row finalisation)

`src/lib/node/apply-attempt-cleanup.ts`:

- `:224` — `UPDATE apply_attempts ... WHERE attempt_id = $1` (terminalise expired attempt; conditional on caller's tx mode)
- `:270` — `UPDATE apply_attempts SET executing_lock = NULL WHERE executing_lock IS NOT NULL AND NOW() - claim_started_at > ...` (stale-lock recovery sweep — no per-row id; bounded by a server-managed TTL predicate, customer-agnostic at the row level)
- `:292` — `UPDATE apply_attempts ... WHERE status = 'pending' AND NOW() > expires_at` (TTL pending → expired; same shape as `:270`, no per-row id)
- `:306` — `UPDATE apply_attempts ... WHERE status = 'failed_retryable' AND NOW() > expires_at` (TTL failed_retryable → failed_terminal; same shape)
- `:362` — `DELETE FROM apply_attempts WHERE status IN (... terminal ...) AND NOW() > expires_at` (retention purge; same shape)
- `:453` — `SELECT ... FROM apply_attempts WHERE attempt_id = $1` (`readApplyAttempt` helper)
- `:515` — `UPDATE apply_attempts SET succeeded_audit_emitted_at = NOW() WHERE attempt_id = $1 AND succeeded_audit_emitted_at IS NULL` (claim audit-emission slot)
- `:547` — `UPDATE apply_attempts SET succeeded_audit_completed_at = NOW() WHERE attempt_id = $1 AND succeeded_audit_emitted_at IS NOT NULL` (mark audit complete)
- `:598` — `UPDATE apply_attempts SET succeeded_audit_emitted_at = NULL WHERE attempt_id = $1 AND succeeded_audit_emitted_at IS NOT NULL` (release audit slot on synchronous failure)
- `:698` — `SELECT ... FROM apply_attempts WHERE status = 'succeeded' AND succeeded_audit_completed_at IS NULL` (recovery-sweep candidate scan; no per-row id, bounded by status predicate)

All 18 sites operate on `apply_attempts` only and are scoped one frame
up by `assertNodeInScope` at the public entry point. The
`apply-attempt-cleanup.ts:738` audit emit driven by these rows is the
separate finding in §3.

### Scoped (account-owner) — `saved_filter` (auth DB, account-owned)

`saved_filter` is account-owned, not customer-owned: every row carries
`owner_account_id` and is only readable / writable by that account. Listed
explicitly per the §2 special-attention list in #385 — these are persisted
filters whose `filter_json` payload may encode customer-scoped Detection
state (e.g. a `customers` chip selection captured under the account's
prior scope).

- `src/lib/detection/saved-filters.ts:190` — `SELECT ... FROM saved_filter WHERE owner_account_id = $1 AND mode = 'structured' ORDER BY ...` (list)
- `src/lib/detection/saved-filters.ts:222` — `INSERT INTO saved_filter (owner_account_id, name, mode, filter_json) VALUES (...)` (create)
- `src/lib/detection/saved-filters.ts:254` — `UPDATE saved_filter SET name = ... WHERE id = $1 AND owner_account_id = $2` (rename)
- `src/lib/detection/saved-filters.ts:284` — `DELETE FROM saved_filter WHERE id = $1 AND owner_account_id = $2` (delete)

All four are scoped at the row level by `owner_account_id`, so a saved
filter cannot be read or mutated across account boundaries. The
cross-customer concern is one step removed: a row written under a wider
customer scope can later be replayed by the same account after its scope
has been reduced. Enforcement of customer scope when *applying* the
filter is the Detection BFF intersection check owned by **#384** (already
referenced in §7 "out of scope") — not duplicated as a new finding here.

### Customer-agnostic (auth DB / audit DB / system tables)

Listed per-call-site for all auth-DB CRUD. `accounts`, `roles`,
`role_permissions`, `sessions`, `*_credentials`, `*_challenges`,
`recovery_codes`, `password_history`, `mfa_challenges`,
`system_settings` carry no `customer_id` column. Where the *target* is
tenant-scoped (account-management routes), tenant-overlap enforcement
sits one frame up at the API layer; the SQL itself is customer-agnostic.

Audit-DB writers:

- `src/lib/audit/logger.ts:133` — `INSERT INTO audit_logs ...`. Append-only insert; `customer_id` is data, not predicate

System-settings reads (each policy module owns one cached SELECT against the global `system_settings` row keyed by `key`):

- `src/lib/auth/password-policy.ts:45` — `system_settings` SELECT (`password_policy`)
- `src/lib/auth/session-policy.ts:56` — `system_settings` SELECT (`session_policy`)
- `src/lib/auth/lockout-policy.ts:39` — `system_settings` SELECT (`lockout_policy`)
- `src/lib/auth/jwt-policy.ts:36` — `system_settings` SELECT (`jwt_policy`)
- `src/lib/auth/mfa-policy.ts:40` — `system_settings` SELECT (`mfa_policy`)
- `src/lib/auth/account-role-policy.ts:104` — `system_settings` SELECT (`account_role_policy`)
- `src/lib/auth/system-settings.ts:194` — `system_settings` SELECT (single-key read by admin endpoint)
- `src/lib/auth/system-settings.ts:204` — `system_settings` UPSERT (admin write of the single global row for that key)
- `src/lib/auth/system-settings.ts:232` — `system_settings` SELECT (alternate read path used by snapshot consumers)
- `src/lib/rate-limit/limiter.ts:75` — `system_settings` SELECT (`rate_limit.sign_in`)
- `src/lib/rate-limit/limiter.ts:110` — `system_settings` SELECT (`rate_limit.api`)

Auth-DB lib (per call site):

`src/lib/auth/sign-in.ts`:

- `:48` — `accounts` UPDATE (reset failed-count + lockout, set `last_sign_in_at`)
- `:57` — `sessions` INSERT (per-account session row)

`src/lib/auth/session.ts`:

- `:18` — `sessions` UPDATE (revoke single session by sid)

`src/lib/auth/guard.ts`:

- `:271` — `sessions` UPDATE (set `needs_reauth`)
- `:310` — `sessions` UPDATE (touch `last_active_at`)

`src/lib/auth/jwt.ts`:

- `:125` — `sessions` SELECT (resolve session row from sid for JWT issuance)

`src/lib/auth/permissions.ts`:

- `:23` — `role_permissions` SELECT (resolve permissions for a role)

`src/lib/auth/password-validator.ts`:

- `:60` — `password_history` SELECT (reuse-prevention lookup)

`src/lib/auth/mfa-enforcement.ts`:

- `:31` — credential-presence SELECT (UNION over `totp_credentials` / `webauthn_credentials` for the caller's account)

`src/lib/auth/mfa-challenge.ts`:

- `:61` — `mfa_challenges` SELECT (single-use guard on the JWT identifier)
- `:87` — `accounts` SELECT (resolve subject account from challenge JWT)
- `:150` — `mfa_challenges` SELECT (rate-limit count of recent challenges)

`src/lib/auth/mfa-credentials.ts` (transactional account credential wipe):

- `:15` — `totp_credentials` DELETE (account)
- `:18` — `webauthn_credentials` DELETE (account)
- `:21` — `recovery_codes` DELETE (account)
- `:24` — `sessions` UPDATE (revoke for account)

`src/lib/auth/recovery-codes.ts`:

- `:52` — `recovery_codes` DELETE (transactional regenerate, prior codes)
- `:56` — `recovery_codes` INSERT (transactional regenerate, fresh codes)
- `:76` — `recovery_codes` SELECT (challenge consume — load candidates)
- `:84` — `recovery_codes` UPDATE (mark a code used)
- `:101` — `recovery_codes` SELECT (remaining/total count for the UI)

`src/lib/auth/totp.ts`:

- `:85` — `totp_credentials` SELECT (active credential by account)
- `:97` — `totp_credentials` INSERT…ON CONFLICT (enroll / replace)
- `:110` — `totp_credentials` UPDATE (mark verified)
- `:119` — `totp_credentials` DELETE (remove credential)

`src/lib/auth/webauthn.ts`:

- `:92` — `webauthn_credentials` SELECT (list by account)
- `:107` — `webauthn_credentials` SELECT (load by credential id)
- `:122` — `webauthn_credentials` SELECT (load by account)
- `:141` — `webauthn_credentials` INSERT (registration commit)
- `:163` — `webauthn_credentials` UPDATE (label / metadata edit)
- `:175` — `webauthn_credentials` UPDATE (counter / last-used bump)
- `:187` — `webauthn_credentials` DELETE (single credential by id)
- `:198` — `webauthn_credentials` DELETE (all for account)
- `:234` — `webauthn_registration_challenges` cleanup
- `:238` — `webauthn_registration_challenges` upsert
- `:254` — `webauthn_registration_challenges` consume
- `:269` — `webauthn_authentication_challenges` cleanup
- `:273` — `webauthn_authentication_challenges` upsert
- `:289` — `webauthn_authentication_challenges` consume

`src/lib/auth/role-management.ts`:

- `:82` — `roles` ⨝ `role_permissions` SELECT (list with permissions)
- `:109` — `roles` SELECT (single by id, with permissions)
- `:139` — `roles` SELECT (lookup by name)
- `:179` — `roles` SELECT (name-conflict check on create)
- `:189` — `roles` INSERT (within the create transaction)
- `:201` — `role_permissions` INSERT (within the create transaction)
- `:251` — `roles` SELECT (name-conflict check on update)
- `:261` — `roles` UPDATE (within the update transaction)
- `:269` — `role_permissions` DELETE (within the update transaction)
- `:273` — `role_permissions` INSERT (within the update transaction, fresh perms)
- `:328` — `roles` DELETE

`src/lib/auth/emergency-mfa-reset.ts`:

- `:38` — `accounts` SELECT (resolve account by username for the break-glass path)

`src/lib/auth/bootstrap.ts`:

- `:125` — `audit_logs` INSERT (bootstrap audit row)
- `:157` — `accounts` SELECT (count, gate the bootstrap path)
- `:175` — `roles` SELECT (lookup default admin role)
- `:192` — `accounts` INSERT…WHERE NOT EXISTS (bootstrap admin)
- `:208` — `password_history` INSERT (bootstrap admin's initial password)

`src/lib/db/migrate.ts` — DDL / migration runner only (excluded from this inventory by scope).

Auth route handlers (per call site):

- `src/app/api/auth/me/route.ts:15` — `accounts` SELECT (caller's own row by `session.accountId`; self-read, no customer dimension)
- `src/app/api/auth/reauth/route.ts:32` — `accounts` SELECT (caller's password hash for the reauth verify)
- `src/app/api/auth/reauth/route.ts:62` — `sessions` UPDATE (clear `needs_reauth`)
- `src/app/api/auth/sign-in/route.ts:88` — `accounts` UPDATE (auto-unlock expired temp lock)
- `src/app/api/auth/sign-in/route.ts:130` — `accounts` UPDATE (stage-1 temp lock)
- `src/app/api/auth/sign-in/route.ts:151` — `accounts` UPDATE (stage-2 suspend)
- `src/app/api/auth/sign-in/route.ts:174` — `accounts` UPDATE (`failed_sign_in_count`)
- `src/app/api/auth/sign-in/route.ts:238` — `accounts` SELECT (resolve account from username for the credential check)
- `src/app/api/auth/sign-in/route.ts:311` — `mfa_challenges` INSERT (issue MFA challenge token)
- `src/app/api/auth/sign-in/route.ts:351` — `password_history` SELECT (post-sign-in must-change-password gate count)
- `src/app/api/auth/sign-out-all/route.ts:20` — `accounts` UPDATE (`token_version` bump within transaction)
- `src/app/api/auth/sign-out-all/route.ts:24` — `sessions` UPDATE (revoke all for account, within transaction)
- `src/app/api/auth/password/route.ts:63` — `accounts` SELECT (caller's current password hash)
- `src/app/api/auth/password/route.ts:105` — `accounts` UPDATE (password hash + token bump + status, within transaction)
- `src/app/api/auth/password/route.ts:120` — `password_history` INSERT (within transaction)
- `src/app/api/auth/password/route.ts:127` — `sessions` UPDATE (revoke siblings, within transaction)
- `src/app/api/auth/mfa/enrollment-complete/route.ts:21` — `sessions` UPDATE (clear `must_enroll_mfa`)
- `src/app/api/auth/mfa/totp/setup/route.ts:52` — `accounts` SELECT (caller's username for the TOTP issuer label)
- `src/app/api/auth/mfa/totp/challenge/route.ts:89` — `mfa_challenges` SELECT (single-use guard on the challenge JTI)
- `src/app/api/auth/mfa/recovery/generate/route.ts:52` — `accounts` SELECT (caller's password hash for confirm)
- `src/app/api/auth/mfa/recovery/challenge/route.ts:62` — `mfa_challenges` SELECT (single-use guard on the challenge JTI)
- `src/app/api/auth/mfa/webauthn/register/options/route.ts:42` — `accounts` SELECT (caller's username for the WebAuthn user handle)
- `src/app/api/auth/mfa/webauthn/credentials/[id]/route.ts:100` — `accounts` SELECT (caller's password hash for confirm)
- `src/app/api/auth/mfa/webauthn/challenge/route.ts:146` — `mfa_challenges` SELECT (single-use guard on the challenge JTI)
- `src/app/api/auth/mfa/webauthn/challenge/options/route.ts:63` — `webauthn_authentication_challenges` SELECT (challenge presence)

Self-service / preferences:

- `src/app/api/accounts/me/preferences/route.ts:32` — `accounts` SELECT (caller's locale + timezone, keyed on `session.accountId`)
- `src/app/api/accounts/me/preferences/route.ts:116` — `accounts` SELECT (no-update echo of current values)
- `src/app/api/accounts/me/preferences/route.ts:126` — `accounts` UPDATE (caller's preferences, keyed on `session.accountId`)

Account-management routes (per call site; targets are account rows on the auth DB; tenant-overlap on the *account* axis is enforced by `validateManagedAccountTarget` / `getAccountCustomerIds` one frame up):

- `src/app/api/accounts/[id]/route.ts:63` — `accounts` SELECT (target row for GET handler)
- `src/app/api/accounts/[id]/route.ts:129` — `accounts` SELECT (target row for PATCH precondition)
- `src/app/api/accounts/[id]/route.ts:228` — `accounts` ⨝ `roles` count (System Administrator headcount on PATCH)
- `src/app/api/accounts/[id]/route.ts:246` — `accounts` ⨝ `roles` count (System Administrator headcount on PATCH, secondary check)
- `src/app/api/accounts/[id]/route.ts:300` — `accounts` UPDATE (PATCH commit)
- `src/app/api/accounts/[id]/route.ts:311` — `accounts` SELECT (post-update refetch)
- `src/app/api/accounts/[id]/route.ts:368` — `accounts` SELECT (target row for DELETE precondition)
- `src/app/api/accounts/[id]/route.ts:403` — `accounts` ⨝ `roles` count (System Administrator headcount on DELETE)
- `src/app/api/accounts/[id]/route.ts:418` — `accounts` DELETE
- `src/app/api/accounts/[id]/customers/route.ts:44` — `accounts` existence SELECT (GET)
- `src/app/api/accounts/[id]/customers/route.ts:141` — `accounts` existence SELECT (POST)
- `src/app/api/accounts/[id]/unlock/route.ts:31` — `accounts` SELECT (target row)
- `src/app/api/accounts/[id]/unlock/route.ts:64` — `accounts` UPDATE (unlock active account)
- `src/app/api/accounts/[id]/unlock/route.ts:86` — `accounts` UPDATE (restore suspended account)
- `src/app/api/accounts/[id]/password-reset/route.ts:51` — `accounts` SELECT (target row)
- `src/app/api/accounts/[id]/password-reset/route.ts:91` — `accounts` UPDATE (password hash + status, within transaction)
- `src/app/api/accounts/[id]/password-reset/route.ts:100` — `password_history` INSERT (within transaction)
- `src/app/api/accounts/[id]/password-reset/route.ts:106` — `sessions` UPDATE (revoke target's sessions, within transaction)
- `src/app/api/accounts/[id]/mfa-reset/route.ts:55` — `accounts` SELECT (target row)
- `src/app/api/accounts/[id]/mfa-reset/route.ts:122` — `accounts` SELECT (caller's password hash for confirm)
- `src/app/api/accounts/route.ts:252` — `accounts` ⨝ `roles` count (System Administrator headcount on create)
- `src/app/api/accounts/route.ts:369` — `accounts` INSERT…WHERE NOT EXISTS (within create transaction)
- `src/app/api/accounts/route.ts:378` — `account_customer` INSERT (within create transaction; links to caller-supplied `customerIds` already validated above)
- `src/app/api/accounts/route.ts:395` — `password_history` INSERT (within create transaction)
- `src/app/api/accounts/route.ts:402` — `account_customer` INSERT (secondary insert path within the same create transaction)
- `src/app/api/accounts/route.ts:436` — `accounts` post-insert refetch

Roles routes:

- `src/app/api/roles/[id]/mfa-required/route.ts:33` — `roles` SELECT (existence check)
- `src/app/api/roles/[id]/mfa-required/route.ts:41` — `roles` UPDATE (`mfa_required` toggle)

Dashboard / admin (admin-only at the route layer; tables touched carry no `customer_id`):

- `src/lib/dashboard/queries.ts:37` — `sessions` ⨝ `accounts` SELECT (active sessions list)
- `src/lib/dashboard/queries.ts:56` — `accounts` ⨝ `roles` SELECT (locked / suspended accounts list)
- `src/app/api/dashboard/sessions/[sid]/revoke/route.ts:30` — `sessions` SELECT (existence + ownership for the revoke target)

E2E test-only:

- `src/app/api/e2e/reset-mfa-policy/route.ts:18` — `system_settings` write (test fixture; behind `NODE_ENV !== "production"`)

### Admin-only

(No call sites in this bucket. The previously listed
`/api/audit-logs/route.ts` SELECTs are now classified `LEAK` below
because the permission gate alone does not enforce customer scope —
that is the §1 / #386 finding.)

### LEAK

Per-call-site SQL locus of the §1 / §7 LEAK findings. Counted once in
§7; reproduced here so §2 lists every site at the proper class rather
than parking them under another bucket.

- `src/app/api/audit-logs/route.ts:181` — `SELECT COUNT(*) FROM audit_logs ${where}` (count). No `customer_id` predicate against the caller's effective scope; gated by `audit-logs:read` only. SQL locus of the §1 audit-logs viewer LEAK; fix owned by **#386** (§7 #1)
- `src/app/api/audit-logs/route.ts:189` — `SELECT … FROM audit_logs ${where} ORDER BY timestamp DESC LIMIT $… OFFSET $…` (page). Same shape and same finding as `:181`
- `src/app/api/customers/[id]/route.ts:218` — `SELECT * FROM customers WHERE id = $1` (DELETE precondition). Reachable without a caller-scope check on `customer_id`; SQL locus of the §1 DELETE LEAK (§7 #6)
- `src/app/api/customers/[id]/route.ts:232` — `SELECT customer_id FROM account_customer WHERE customer_id = $1 LIMIT 1` (refuses delete while any link remains; **does not** verify the caller's own scope). Same finding as `:218`
- `src/app/api/customers/[id]/route.ts:245` — `DELETE FROM customers WHERE id = $1` (DELETE commit). Same finding as `:218`

### Unknown

Per-call-site SQL locus of the §4 enumeration finding (§7 #2). The
SELECT itself is scope-deferred — it runs before the tenant-scope
check, so `unknown` is the right class for the SELECT proper; the
LEAK is the error message that echoes missing IDs back to the caller
(see §4).

- `src/app/api/accounts/[id]/customers/route.ts:159` — `SELECT id FROM customers WHERE id = ANY($1)`; existence check used to validate request input. Runs before the tenant-scope check at line 173. The error path at line 167 is the §4 enumeration LEAK (§7 #2)
- `src/app/api/accounts/route.ts:318` — `SELECT id FROM customers WHERE id = ANY($1)` validating the `customerIds` payload of POST /api/accounts. Same shape as `:159`; the error path at `:326` is the §4 enumeration LEAK (same §7 #2)

---

## 3. Audit log call-site inventory

Every `auditLog.record(...)` call site across `src/lib/**` and
`src/app/api/**`. The `audit_logs.customer_id` column already exists; this
section verifies whether each emission populates it.

### Customer-scoped actions — `customerId` populated correctly

| File:line | Action | Notes |
|---|---|---|
| `src/lib/node/node-create-update.ts:62` | `node.create` | `Number(args.customerId)` |
| `src/lib/node/node-create-update.ts:141` | `node.update` | derived from canonical node |
| `src/lib/node/node-create-update.ts:183` | `service.set_mode` | derived from node |
| `src/lib/node/draft.ts:603` | `service.draft_save` | derived from node |
| `src/lib/node/status.ts:125` | `node.restart` | resolved from node |
| `src/lib/node/status.ts:155` | `node.shutdown` | resolved from node |
| `src/app/api/nodes/[id]/route.ts:221` | `node.delete` | resolved from node |

### Customer-scoped actions — `customerId` MISSING (LEAK)

| File:line | Action | Notes |
|---|---|---|
| `src/lib/node/apply-actions.ts:340` | `node.apply` | `customerId` not passed; emitted in the wrapper around the apply-attempt happy path |
| `src/lib/node/apply-attempt-cleanup.ts:738` | `node.apply` | `customerId` not passed; emitted by the recovery sweep that re-emits a missing `node.apply` audit |
| `src/app/api/accounts/[id]/customers/route.ts:244` | `customer.assign` | top-level `customerId` omitted; assigned ids only present in `details.customerIds` (and may be a multi-id batch) |
| `src/app/api/accounts/[id]/customers/[customerId]/route.ts:87` | `customer.unassign` | top-level `customerId` omitted; id present in `details.customerId` |
| `src/app/api/customers/route.ts:146` | `customer.create` | Targets a specific customer (`targetId` populated, `details.name` / `databaseName` populated) but top-level `customerId` omitted. POST is gated only by `customers:write`, **not** `customers:access-all` — a non-`access-all` tenant admin can perform the action. Once #386 scopes the audit-log viewer on `audit_logs.customer_id`, the row will be invisible to the only operator who plausibly owns it after assignment |
| `src/app/api/customers/[id]/route.ts:177` | `customer.update` | Tenant-scope-checked endpoint (gated by `customers:write` + `account_customer` JOIN) targeting a specific customer; top-level `customerId` omitted. Same downstream visibility consequence as `customer.create` |
| `src/app/api/customers/[id]/route.ts:248` | `customer.delete` | Targets a specific customer; top-level `customerId` omitted. The handler is gated only by `customers:delete` with no caller-scope check (see §1 LEAK) — even if the visibility consequence is paired with a separate authorization gap, the audit-row contract is the same |

The two `node.apply` sites are the same underlying bug observed in two
emitters (the wrapper and the recovery sweep). The two
`customer.{assign,unassign}` sites are the same underlying bug at the
customer-assignment endpoints. The three `customer.{create,update,delete}`
sites are the same underlying bug at the customer-CRUD endpoints. Counted
as three distinct findings in §7.

Impact: once #386 lands and the audit-log viewer applies a `customer_id IN
(...)` predicate, rows with `customer_id IS NULL` will be invisible to the
restricted operator who actually owns the customer. The audit row is not
*lost*, but it is silently invisible to the only operator who would
plausibly be looking for it.

### Customer-agnostic actions — `customerId` correctly omitted

Every remaining production `auditLog.record(...)` call site is enumerated
below with action name and `customerId` status. All omit `customerId`,
intentionally — these are session / account / role / MFA / system-settings
actions whose intended audience is the global admin or the account-holder
themselves, not a customer-scoped operator. (Customer-axis tenant-scoped
account-management routes — e.g. `account.unlock`, `account.update`,
`mfa.admin.reset` — *target* an account, not a customer; the `audit_logs`
row's `customer_id` predicate is irrelevant for them. They are
cross-checked against the §1 / §2 reclassification of those routes as
`scoped`.)

Auth — sign-in / sign-out / reauth:

| File:line | Action | `customerId` |
|---|---|---|
| `src/lib/auth/sign-in.ts:107` | `auth.sign_in.success` | omitted (correct) |
| `src/app/api/auth/sign-in/route.ts:59` | `auth.sign_in.failure` (reason `account_locked`) | omitted (correct) |
| `src/app/api/auth/sign-in/route.ts:74` | `auth.sign_in.failure` (`account_locked`, lock-not-yet-expired) | omitted (correct) |
| `src/app/api/auth/sign-in/route.ts:100` | `auth.sign_in.failure` (`account_inactive`) | omitted (correct) |
| `src/app/api/auth/sign-in/route.ts:137` | `account.suspend` (stage-2 lockout) | omitted (correct — targets account, not customer) |
| `src/app/api/auth/sign-in/route.ts:159` | `account.lock` (stage-1 lockout) | omitted (correct) |
| `src/app/api/auth/sign-in/route.ts:180` | `auth.sign_in.failure` (`invalid_credentials`) | omitted (correct) |
| `src/app/api/auth/sign-in/route.ts:222` | `auth.sign_in.failure` (`rate_limited`) | omitted (correct) |
| `src/app/api/auth/sign-in/route.ts:252` | `auth.sign_in.failure` (`invalid_credentials`, no actor) | omitted (correct) |
| `src/app/api/auth/sign-in/route.ts:272` | `auth.sign_in.failure` (`ip_restricted`) | omitted (correct) |
| `src/app/api/auth/sign-in/route.ts:336` | `mfa.enforcement.blocked` | omitted (correct) |
| `src/app/api/auth/sign-in/route.ts:357` | `auth.sign_in.failure` (post-MFA-gate failure) | omitted (correct) |
| `src/app/api/auth/sign-out/route.ts:28` | `auth.sign_out` | omitted (correct) |
| `src/app/api/auth/sign-out-all/route.ts:39` | `session.revoke` (all-sessions) | omitted (correct) |
| `src/app/api/auth/reauth/route.ts:47` | `session.reauth_failure` | omitted (correct) |
| `src/app/api/auth/reauth/route.ts:72` | `session.reauth_success` | omitted (correct) |
| `src/app/api/auth/password/route.ts:141` | `password.change` | omitted (correct) |

Auth — guard / session-state:

| File:line | Action | `customerId` |
|---|---|---|
| `src/lib/auth/guard.ts:202` | `session.absolute_timeout` | omitted (correct) |
| `src/lib/auth/guard.ts:221` | `session.idle_timeout` | omitted (correct) |
| `src/lib/auth/guard.ts:252` | `session.*` IP/UA-risk action (computed; e.g. `session.ip_change`, `session.ua_change`) | omitted (correct) |
| `src/app/api/dashboard/sessions/[sid]/revoke/route.ts:45` | `session.revoke` (single session) | omitted (correct) |

MFA:

| File:line | Action | `customerId` |
|---|---|---|
| `src/lib/auth/emergency-mfa-reset.ts:58` | `mfa.emergency.reset` | omitted (correct) |
| `src/app/api/accounts/[id]/mfa-reset/route.ts:142` | `mfa.admin.reset` | omitted (correct — targets account, tenant-scoped on account axis at the route layer) |
| `src/app/api/auth/mfa/enrollment-complete/route.ts:26` | `mfa.enrollment.complete` | omitted (correct) |
| `src/app/api/auth/mfa/totp/route.ts:53` | `mfa.totp.remove` | omitted (correct) |
| `src/app/api/auth/mfa/totp/verify-setup/route.ts:80` | `mfa.totp.enroll` | omitted (correct) |
| `src/app/api/auth/mfa/totp/verify-setup/route.ts:94` | `mfa.recovery.generate` (auto-issued during enrolment) | omitted (correct) |
| `src/app/api/auth/mfa/totp/challenge/route.ts:75` | `mfa.totp.verify.failure` | omitted (correct) |
| `src/app/api/auth/mfa/totp/challenge/route.ts:101` | `mfa.totp.verify.success` | omitted (correct) |
| `src/app/api/auth/mfa/webauthn/credentials/[id]/route.ts:127` | `mfa.webauthn.remove` | omitted (correct) |
| `src/app/api/auth/mfa/webauthn/register/verify/route.ts:119` | `mfa.webauthn.register` | omitted (correct) |
| `src/app/api/auth/mfa/webauthn/register/verify/route.ts:134` | `mfa.recovery.generate` (auto-issued during enrolment) | omitted (correct) |
| `src/app/api/auth/mfa/webauthn/challenge/route.ts:80` | `mfa.webauthn.verify.failure` | omitted (correct) |
| `src/app/api/auth/mfa/webauthn/challenge/route.ts:112` | `mfa.webauthn.verify.failure` | omitted (correct) |
| `src/app/api/auth/mfa/webauthn/challenge/route.ts:126` | `mfa.webauthn.verify.failure` | omitted (correct) |
| `src/app/api/auth/mfa/webauthn/challenge/route.ts:158` | `mfa.webauthn.verify.success` | omitted (correct) |
| `src/app/api/auth/mfa/recovery/challenge/route.ts:47` | `mfa.recovery.use` (failure path) | omitted (correct) |
| `src/app/api/auth/mfa/recovery/challenge/route.ts:74` | `mfa.recovery.use` (success path) | omitted (correct) |
| `src/app/api/auth/mfa/recovery/generate/route.ts:72` | `mfa.recovery.generate` | omitted (correct) |

Account / role / system-settings management:

| File:line | Action | `customerId` |
|---|---|---|
| `src/app/api/accounts/route.ts:420` | `account.create` | omitted (correct — targets account, tenant-overlap on account axis) |
| `src/app/api/accounts/[id]/route.ts:323` | `account.update` | omitted (correct) |
| `src/app/api/accounts/[id]/route.ts:426` | `account.delete` | omitted (correct) |
| `src/app/api/accounts/[id]/unlock/route.ts:72` | `account.unlock` | omitted (correct) |
| `src/app/api/accounts/[id]/unlock/route.ts:94` | `account.restore` | omitted (correct) |
| `src/app/api/accounts/[id]/password-reset/route.ts:114` | `password.reset` | omitted (correct) |
| `src/app/api/roles/route.ts:78` | `role.create` | omitted (correct — roles are system-wide) |
| `src/app/api/roles/[id]/route.ts:68` | `role.update` | omitted (correct) |
| `src/app/api/roles/[id]/route.ts:112` | `role.delete` | omitted (correct) |
| `src/app/api/roles/[id]/mfa-required/route.ts:46` | `role.update` (`mfaRequired` toggle path) | omitted (correct) |
| `src/app/api/system-settings/[key]/route.ts:35` | `system_settings.update` | omitted (correct — single-row global config) |

(`customer.{create,update,delete}` were previously listed in the
customer-agnostic bucket as "admin-gated by `customers:access-all`". That
was wrong — the endpoints are gated by `customers:write` /
`customers:delete`, which are not necessarily admin-only — and they
target a specific customer, so they belong in the LEAK bucket above.)

### Unknown

None.

---

## 4. Error / log message scan

Scope: `logger.warn`, `logger.error`, `logger.info`, `console.error`,
`console.warn`, `throw new Error`, and `NextResponse.json({ error: ... })`
across `src/**` (excluding tests). Looking for messages that embed a
customer identifier (name, ID, sensor name, hostname, IP) and could be
returned to a caller without scope on that customer.

### Findings — caller-reachable existence disclosure

| File:line | Snippet | Risk |
|---|---|---|
| `src/app/api/accounts/route.ts:326` | `error: \`Customers not found: ${missing.join(", ")}\`` | A non-`access-all` caller with `accounts:write` can probe arbitrary customer IDs in the `customerIds` array of an account-create payload; the missing-IDs list discloses which are present. Existence check at line 318–329 runs *before* the scope check at line 333+ |
| `src/app/api/accounts/[id]/customers/route.ts:167` | same `Customers not found: ${missing.join(", ")}` | Same pattern at the bulk-assign endpoint. Existence check (line 163) runs before the scope check (line 173) |

### Server-side only — server logs / audit details

These are not returned in HTTP responses but embed identifiers in
server-side log lines or audit details. Risk only materialises if
server logs are routed to a less-privileged operator (e.g. a SIEM with
relaxed RBAC).

| File:line | Snippet | Note |
|---|---|---|
| `src/lib/node/apply-attempts.ts:259, 266, 269` | `Node ${id} is not in the caller's customer scope.` / `Node ${id} was not found.` | `NodePermissionError` instances are caught one frame up in `createApplyAttempt` and collapsed; not surfaced verbatim. Server-side only |
| `src/lib/node/apply-actions.ts` (audit details) | `appliedServices: [...]` | Service kinds, not customer-identifying |
| `src/lib/node/node-create-update.ts` (audit details) | hostname / address-range fields when present | Customer-scoped row; visible only to the audit viewer of the same customer once §3 is fixed |
| `src/lib/auth/emergency-mfa-reset.ts:45, 69` | `Emergency MFA reset: account not found for username "${username}"` | Console-only break-glass path |

### No findings

No `logger.error` / `console.error` line in `src/lib/node/`,
`src/lib/detection/`, `src/app/api/customers/`, `src/app/api/nodes/`,
`src/app/api/services/`, `src/app/api/dashboard/`, or
`src/app/api/audit-logs/` interpolates a customer name, sensor name, IP, or
node identifier into a string that is returned to the HTTP caller without
first passing a scope check.

---

## 5. `graphqlRequest` / `graphqlRequestTo` call sites

Defined in `src/lib/graphql/client.ts`. Every call signs a fresh Context
JWT per request via `signContextJwt(role, customerIds)`; the cached
`GraphQLClient` instance carries no per-customer state (only the mTLS
dispatcher), so client reuse does not cross scopes.

### Direct `graphqlRequest` / `graphqlRequestTo` call sites

The two thin wrappers in `src/lib/graphql/external-client.ts` are the
only files that call `graphqlRequestTo` directly outside of
`src/lib/graphql/client.ts` itself. Both take a `RequestContext`
(`{ role, customerIds }`) parameter and pass it straight through to
`graphqlRequestTo`, which signs a fresh Context JWT per request:

| File:line | Function | Endpoint | Context source |
|---|---|---|---|
| `src/lib/graphql/external-client.ts:47` | `gigantoClient` | `getGigantoEndpoint()` | `RequestContext` parameter (caller-supplied) |
| `src/lib/graphql/external-client.ts:69` | `tivanClient` | `getTivanEndpoint()` | `RequestContext` parameter (caller-supplied) |

Neither wrapper derives or augments the context internally — the
caller (a Node-track server action that has already run
`buildDispatchContext`) is responsible for passing
`{ role, customerIds }` materialised from the session. The wrappers
exist only so the URL is resolved at call time rather than module-load
time. The mTLS dispatcher held in `clientsByEndpoint` (see §6) carries
no per-customer state.

### Verified — every production caller flows through a dispatch context

The callers of `graphqlRequest` (manager) and the two
`gigantoClient` / `tivanClient` wrappers above all materialise customer
scope before the call:

| File | Function(s) | Dispatch context |
|---|---|---|
| `src/lib/node/server-actions.ts` | `listNodes`, `getNode`, `fetchSlimNodeMetadata`, `listNodeStatuses`, `insertNode`, `updateNodeDraft`, `removeNodes`, `nodeReboot`, `nodeShutdown`, `getGigantoStatus`, `getGigantoConfig`, `updateGigantoConfig`, `getTivanStatus`, `getTivanConfig`, `updateTivanConfig` | `buildDispatchContext(session)` from `src/lib/node/dispatch-context.ts`; the resulting `{ role, customerIds }` is forwarded into `gigantoClient` / `tivanClient` for every external call |
| `src/lib/node/apply.ts` | `_internal_applyNodeViaManager`, `fetchCanonicalNode`, `readGigantoConfigAsString`, `readTivanConfigAsString`, `dispatchGigantoUpdateConfig`, `dispatchTivanUpdateConfig` | Inherited — receives a `DispatchContext` from the caller, never re-derives |
| `src/lib/node/apply-attempts.ts:244` | `readCanonicalNode` | `buildDispatchContext(session)` |
| `src/lib/node/draft.ts:91` | `fetchNodeForReplay` | Inherited from caller |
| `src/lib/detection/server-actions.ts` | `searchEvents`, `dispatchCounter` (used by every `countEventsBy*`), `fetchEventByLocator`, `eventFrequencySeries`, `lookupIpLocation` | Local `buildDispatchContext(session, filter)` defined in the same file (Detection track) |

No production caller invokes `graphqlRequest` / `graphqlRequestTo`
directly from a `route.ts`; every request reaches the wire via a server
action (or one of the two `external-client.ts` wrappers above) that has
materialised customer scope first.

### Findings

None.

---

## 6. Client-side cache surfaces

### Server-side caches (no cross-customer risk)

- `src/lib/auth/{password,session,lockout,jwt,mfa}-policy.ts` — system
  policies (TTL'd, system-wide). Not customer-scoped.
- `src/lib/auth/permissions.ts` — role-permission cache. Roles are
  system-wide.
- `src/lib/rate-limit/{limiter,store}.ts` — IP / account rate-limit
  buckets. Not customer-scoped.
- `src/lib/graphql/client.ts:9` — `clientsByEndpoint` keyed by URL. The
  cached object holds only the mTLS dispatcher; the Context JWT is
  re-signed per request with the caller's `customerIds`. No leak vector.

### Client-side caches holding customer-scoped data

| Surface | Key | Invalidation | Class |
|---|---|---|---|
| `src/components/detection/detection-analytics.tsx:204` `cacheRef<Map<string, ReadyResult>>` | `${filterIdentity}|${dimension}|${topN}` | Per-component-mount only; cleared on unmount; no cross-customer key | `unknown` — see §7 P2 |
| `src/components/detection/detection-shell.tsx:1111` `sensorCache` (state) populated via `fetchSensors()` | per-mount state in the Detection shell — caches the sensor list (id / name / customerId) for the tab session | None on scope change; only refetched on `shouldTriggerSensorFetch(sensorCache)` (idle / prior error). Survives drawer close/reopen but not a tab unmount | `unknown` — see §7 P2 |
| `src/lib/detection/tabs-storage.ts` `sessionStorage["detection:tabs:v1"]` | per-tab filter / endpoints / pagination snapshot | None on scope change; sessionStorage cleared at tab close | `unknown` — see §7 P2 |
| `src/hooks/use-node-status-polling.ts:81-109` module-level `byNodeId: Map<string, NodeStatusBuffer>` (single instance shared by every `useNodeStatusPolling` consumer) populated from scoped `/api/nodes/status` (`src/app/api/nodes/status/route.ts:10-18, 31-34` → `getNodeStatusList`) | per-node id; payload includes node id and status snapshot (cpu / mem / disk / manager / ping). Driven by `NodeStatusPollingDriver` mounted in `nodes/(gate)/layout.tsx` (`src/components/node/node-status-polling-driver.tsx:7-17`) so the buffer survives every intra-segment navigation (Status ↔ Settings ↔ Detail) | `resetStoreForUnmount` (`use-node-status-polling.ts:484-496`) wipes the map only on the *last* `/nodes` segment unmount; `stopInterval` (`:469-472`) pauses polling on tab-hidden but does not clear the buffer; no explicit invalidation on a session / scope change while the user remains in `/nodes` | `unknown` — see §7 P2 |
| `src/components/providers/timezone-provider.tsx:24` | timezone preference (per-account, not per-customer) | None on scope change; remount on navigation | scoped (account-only data) |
| `src/hooks/use-sidebar.ts` `localStorage["sidebar-collapsed"]` | UI state only | n/a | scoped (no customer data) |

The Detection caches and the Nodes status buffer do not store
cross-customer payloads in a single session because (a) a session's
effective `customerIds` does not change mid-session (the JWT is
re-derived only on a new sign-in / impersonation, which already
invalidates the page), and (b) the Detection analytics cache is wiped
on unmount and never persists across reloads. The Detection
sensor-drawer cache (`sensorCache`) and the Nodes module-level status
buffer (`byNodeId`) hold customer-scoped sensor / node identifiers but
share the same mid-session-immutability assumption. The Nodes buffer is
deliberately segment-scoped (lives as long as the `/nodes` segment is
mounted) so the rolling sparkline survives intra-segment navigation; an
SSO-style scope change that keeps the user inside `/nodes` would
surface stale node ids and metrics until the next `/nodes` unmount.
Flagged as `unknown` for hardening to decide.

The React app is App-Router-based; no React Query / SWR / `unstable_cache` /
`fetch({ next: { revalidate } })` usage was found that holds customer
data. The route segments under `/api/**` are all dynamic
(per-request session resolution), so Next.js route-handler caching is not
a factor.

### No findings beyond the four `unknown` surfaces enumerated above (three Detection + one Nodes status buffer).

---

## 7. Findings summary (de-duplicated, prioritised)

### P0 — restricted-scope caller can hit today

1. **`/api/audit-logs` viewer leak.** Already known and confirmed; fix
   owned by **#386**. The §1 row is the only mention in this report;
   not re-counted from §2/§3/§4 where the same underlying viewer is the
   downstream consumer. Source: `src/app/api/audit-logs/route.ts`.

### P1 — leaks behind admin-adjacent permissions but still violating the contract

2. **Customer-ID enumeration via `Customers not found: ...` error.**
   `src/app/api/accounts/route.ts:326` and
   `src/app/api/accounts/[id]/customers/route.ts:167` echo the requested
   customer IDs that were not found in `customers`. The existence check
   runs before the scope check, so a tenant admin (`accounts:write`
   without `customers:access-all`) can probe arbitrary customer IDs and
   distinguish "exists, out of scope" (would 403 later) from "does not
   exist" (returned 400 here).

3. **`node.apply` audit emissions omit `customerId`.**
   `src/lib/node/apply-actions.ts:340` (wrapper) and
   `src/lib/node/apply-attempt-cleanup.ts:738` (recovery sweep). Once the
   audit-log viewer is scoped (#386), these rows become invisible to
   the restricted operator who owns the customer that ran the apply.
   Same underlying bug, two emitters.

4. **`customer.assign` / `customer.unassign` audit emissions omit
   top-level `customerId`.**
   `src/app/api/accounts/[id]/customers/route.ts:244` and
   `src/app/api/accounts/[id]/customers/[customerId]/route.ts:87`. Same
   downstream impact as #3.

5. **`customer.{create,update,delete}` audit emissions omit top-level
   `customerId`.**
   `src/app/api/customers/route.ts:146` (`customer.create`),
   `src/app/api/customers/[id]/route.ts:177` (`customer.update`),
   `src/app/api/customers/[id]/route.ts:248` (`customer.delete`). These
   endpoints are gated by `customers:write` / `customers:delete`, *not*
   `customers:access-all` — so a non-`access-all` tenant admin can
   perform the action. Once #386 scopes the audit-log viewer on
   `audit_logs.customer_id`, these rows become invisible to the only
   operator who plausibly has scope on the targeted customer. Same
   downstream visibility consequence as #3 / #4 — counted separately
   because the call sites and the fix shape are different (the
   emitter already has `targetId = String(customerId)`).

6. **`DELETE /api/customers/[id]` does not check caller customer
   scope.**
   `src/app/api/customers/[id]/route.ts:206-261`. Unlike GET / PATCH
   on the same resource, DELETE only checks `customers:delete` plus a
   "no remaining `account_customer` link" precondition; it never
   verifies that `session.accountId` has scope on `customerId`. A
   non-`access-all` caller with `customers:delete` can therefore drop
   any unlinked customer (including its database). Mutation-side
   isolation gap; pairs with finding #5 because the missing audit
   `customerId` makes the resulting row invisible to a scoped viewer.

### P2 — `unknown`, case-by-case decision

7. **Detection analytics in-memory cache** (`src/components/detection/detection-analytics.tsx:204`).
   Cache key does not include customer scope. Risk only realises if a
   client-side scope change can occur without a page reload — confirm
   during hardening whether any sign-in / role-change / impersonation
   flow keeps the page mounted.

8. **Detection tabs `sessionStorage`** (`src/lib/detection/tabs-storage.ts`).
   Stores filter UI state only (no result rows). Same condition as #7;
   confirm that a scope change either reloads the shell or clears the
   `detection:tabs:v1` key.

9. **Detection sensor drawer cache** (`src/components/detection/detection-shell.tsx:1111`).
   Shell-state cache of the sensor list (id / name / customerId)
   populated by `fetchSensors`. Holds customer-scoped sensor labels
   for the tab session with no scope key and no explicit invalidation
   beyond unmount. Same scope-change-without-reload condition as #7
   / #8; the data set is metadata rather than result rows, so the
   blast radius is "stale labels" rather than "cross-customer
   payloads".

10. **Nodes status polling store** (`src/hooks/use-node-status-polling.ts:81-109`).
    Module-level `byNodeId: Map<string, NodeStatusBuffer>` populated
    from scoped `/api/nodes/status`. Deliberately segment-scoped via
    `NodeStatusPollingDriver` (`src/components/node/node-status-polling-driver.tsx:7-17`)
    so the rolling sparkline buffer survives intra-segment navigation
    (Status ↔ Settings ↔ Detail) and is only torn down on the last
    `/nodes` unmount via `resetStoreForUnmount`
    (`use-node-status-polling.ts:484-496`). Same
    scope-change-without-reload condition as #7 / #8 / #9; if a
    customer-scope change can occur while the user remains inside
    `/nodes`, stale node ids and status snapshots from the prior
    scope would shadow the next snapshot until the segment unmounts
    or the next poll lands. Blast radius: node ids + system metrics
    (cpu / memory / disk / manager flag / ping), not event payloads.

### Out of scope of this report (already owned elsewhere)

- **#384** — Detection BFF intersection check on `filter.customers`. The
  second confirmed leak from the umbrella; tracked in the Detection
  track. Not duplicated here.
- **#386** — `/api/audit-logs` viewer scoping. Referenced in P0 only.

---

## 8. Recommendations (one-liners for #387)

| # | Finding | Direction |
|---|---|---|
| 1 (P0) | `/api/audit-logs` viewer leak | Owned by **#386**; no action under #387 |
| 2 (P1) | `Customers not found: <ids>` enumeration | Reorder: run the tenant-scope check on input IDs first; fold "not found" and "out of scope" into a single 403/404 with no ID enumeration. (Optionally subset the response only to IDs the caller has scope on.) |
| 3 (P1) | `node.apply` audit missing `customerId` | Resolve the node's `customer_id` from `apply_attempts` (or the canonical node) inside the audit wrapper and pass it as `customerId`. The recovery sweep already SELECTs `node_id`; extend the SELECT to include `customer_id` from `apply_attempts` (or join the cached node row). |
| 4 (P1) | `customer.{assign,unassign}` audit missing `customerId` | Set `customerId` on the audit event. For the bulk `customer.assign` case (`uniqueIds.length > 1`) emit one audit row per assigned `customerId` so each is correctly scoped, rather than one row with a list in `details`. |
| 5 (P1) | `customer.{create,update,delete}` audit missing `customerId` | Pass `customerId: customer.id` (or the parsed `customerId` for PATCH / DELETE) on the audit event in `src/app/api/customers/route.ts:146` and `src/app/api/customers/[id]/route.ts:177, 248`. The numeric id is already in scope at the emit site. |
| 6 (P1) | `DELETE /api/customers/[id]` missing caller-scope check | Add the same `access-all`-or-`account_customer`-JOIN check used by GET / PATCH on the same route before the linked-accounts check, so a non-`access-all` caller cannot delete a customer outside their scope. |
| 7 (P2) | Detection analytics cache key | If hardening confirms the scope-change-without-reload pathway exists, prefix the cache key with the session's `accountId` or invalidate the cache on a "scope changed" signal from the auth provider. |
| 8 (P2) | Detection tabs `sessionStorage` | Same disposition: namespace the `sessionStorage` key by `accountId` or wipe on sign-in. |
| 9 (P2) | Detection sensor drawer cache (`sensorCache`) | Same disposition: reset `sensorCache` on a "scope changed" signal from the auth provider, or refetch eagerly when the session's `accountId` / `customerIds` differs from the value the cache was filled under. |
| 10 (P2) | Nodes status polling store (`byNodeId` in `use-node-status-polling.ts`) | Same disposition: extend `resetStoreForUnmount` (or expose a sibling reset) and call it on a "scope changed" signal from the auth provider so the segment-scoped buffer is wiped without waiting for the `/nodes` unmount. Alternatively, key the buffer by `${session.accountId}|${nodeId}` and discard entries on key mismatch. |

#388 should additionally:

- Add a static check that any new `auditLog.record({ action: ... })` call
  whose `action` matches the customer-scoped subset (`node.*`,
  `service.*`, `customer.*`) sets `customerId` (or explicitly opts out
  with `customerId: null` and a `// scope-allowlist:` comment).
- Cover findings 2–6 with the cross-customer integration test matrix
  under `src/__integration__/multi-tenancy/`.
- Cover findings 7–10 once the scope-change-without-reload pathway is
  confirmed or ruled out under #387.
