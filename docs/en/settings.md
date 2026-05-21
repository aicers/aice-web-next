# Settings

The Settings page is accessed from the sidebar. It contains tabs
for managing accounts, roles, customers, policies, and account
status. Each tab is gated by permissions — you only see tabs your
role allows.

## Accounts

Navigate to **Settings → Accounts** to manage user accounts.
Requires `accounts:read` to view, `accounts:write` to create
and edit, `accounts:delete` to disable.

### Account List

The account list shows all accounts with filtering and pagination.

![Account list](../assets/accounts-list-en.png)

Available filters:

- **Search** — filter by username or display name.
- **Role** — filter by assigned role.
- **Status** — filter by account status (active, locked,
  suspended, disabled).
- **Customer** — filter by assigned customer.

### Creating an Account

Click the **+** button to open the account creation dialog.

![Account creation dialog](../assets/account-create-en.png)

Fields:

- **Username** — unique login identifier (immutable after
  creation).
- **Display name** — shown in the UI (required).
- **Email** — optional contact email.
- **Phone** — optional contact phone.
- **Role** — determines permissions. System Administrators can
  assign any role. Tenant Administrators can only create accounts
  with Security Monitor-equivalent roles.
- **Customer assignment** — required for roles that need customer
  scope.
- **Password** — set the initial password for the account.

### Editing an Account

Click the edit icon (pencil) on an account row. Display name,
email, and phone can be modified. Username, role, and customer
assignments are immutable after creation.

### Disabling Accounts

Click the delete icon (trash) on an account row. A confirmation
dialog appears. Role hierarchy is enforced — you cannot delete
accounts with a role equal to or higher than your own.

### Resetting MFA

If a user loses access to their MFA device, an administrator
can reset all MFA methods for that account. Open the dropdown
menu (⋮) on the account row and select **Reset MFA** (only
visible for accounts that have MFA enrolled).

![MFA reset confirmation dialog](../assets/mfa-reset-en.png)

A confirmation dialog asks for **your own password** (step-up
authentication). After confirmation:

- All TOTP credentials, passkeys, and recovery codes are
  removed.
- All active sessions for the account are revoked.
- The user must re-enroll MFA on their next sign-in if their
  role requires it.

**Restrictions:**

- You cannot reset MFA for accounts with a role equal to or
  higher than your own.
- You cannot reset your own MFA through this screen (manage
  your own MFA from **Profile → Two-Factor Authentication**).

### Emergency MFA Reset (break-glass)

If all administrators are locked out by MFA, a server-level
emergency reset is available.

1. Set the environment variable `EMERGENCY_MFA_RESET` to the
   username of the locked-out account.
2. Restart the server.
3. The server removes all MFA credentials and revokes all
   sessions for that account on startup.
4. Remove the environment variable after use.

A per-username marker file
(`$DATA_DIR/.emergency_mfa_reset_consumed_{username}`) prevents
repeated execution on subsequent restarts. An audit event
(`mfa.emergency.reset`) is recorded with actor `system`.

If the same user needs an emergency reset again later, delete
the marker file before restarting:

```bash
rm "$DATA_DIR/.emergency_mfa_reset_consumed_<username>"
```

!!! warning
    This mechanism bypasses all authentication checks. Use it
    only for disaster recovery and remove the environment
    variable immediately after the reset.

### Account Status

| Status | Description |
|--------|-------------|
| Active | Normal operating state |
| Locked | Temporarily locked due to failed sign-in attempts (auto-recovers) |
| Suspended | Permanently locked after repeated lockouts (admin restore required) |
| Disabled | Deactivated by an administrator |

## Roles

Navigate to **Settings → Roles** to manage roles. Requires
`roles:read` to view, `roles:write` to create, edit, and clone,
`roles:delete` to delete.

![Role list](../assets/roles-list-en.png)

### Built-In Roles

Three roles are provided out of the box and cannot be edited or
deleted (marked with a **BUILTIN** badge):

- **System Administrator** — full access to all features.
- **Tenant Administrator** — manage operations and Security
  Monitor accounts within assigned customers.
- **Security Monitor** — read-only access to events, dashboards,
  and detection within a single assigned customer.

### Custom Roles

Click the **+** button to create a custom role, or click the
clone icon (copy) on an existing role.

![Role creation dialog](../assets/role-create-en.png)

The permission grid shows all available permissions grouped by
resource:

| Group | Permissions |
|-------|-------------|
| Dashboard | `dashboard:read`, `dashboard:write` |
| Detection | `detection:read` |
| Triage | `triage:read`, `triage:policy:write`, `triage:exclusion:write`, `triage:exclusion:global:write` |
| Accounts | `accounts:read`, `accounts:write`, `accounts:delete` |
| Roles | `roles:read`, `roles:write`, `roles:delete` |
| Customers | `customers:read`, `customers:write`, `customers:delete`, `customers:access-all` |
| System Settings | `system-settings:read`, `system-settings:write` |
| Audit Logs | `audit-logs:read` |

### MFA Required

Each role has an **MFA Required** flag. When enabled, users
with that role must enroll at least one MFA method (TOTP or
passkey) before accessing the dashboard. The System
Administrator role has MFA required by default.

![Role list with MFA Required column](../assets/roles-mfa-en.png)

To toggle MFA enforcement for a role, click the dropdown
menu (⋯) on the role row and select **Toggle MFA**. This
works for both built-in and custom roles. The `roles:write`
permission is required.

Individual accounts can override the role default using the
`mfa_override` field:

| Override | Behavior |
|----------|----------|
| *(none)* | Follows the role's MFA Required setting |
| Exempt | MFA is never required, even if the role requires it |
| Required | MFA is always required, even if the role does not require it |

## Customers

Navigate to **Settings → Customers** to manage customers.
Requires `customers:read` to view, `customers:write` to create
and edit, `customers:delete` to delete.

![Customer list](../assets/customers-list-en.png)

### Creating a Customer

Click the **+** button to open the customer creation dialog.

![Customer creation dialog](../assets/customer-create-en.png)

Fields:

- **Name** — customer display name (required).
- **Description** — optional description.
- **External Key** — optional cross-system bridge identifier paired
  with the matching customer on aimer-web. Globally unique. Leave
  blank if the customer is not yet onboarded for *Send to Aimer*.
  See [External Key](#external-key) below for the agreement and
  validation rules.

When a customer is created, the system provisions a dedicated
database automatically.

<!-- TODO: screenshot - aimer-bridge batch -->

### Editing a Customer

Open the row's kebab menu and choose **Edit** to update the name,
description, or external key. Editing the **external key** to a
different value (or clearing it back to blank) opens a non-dismissable
confirmation dialog before the change is saved — see
[External Key](#external-key) below for why the warning matters.

<!-- TODO: screenshot - aimer-bridge batch -->

### External Key

The external key is the operator-supplied identifier that pairs an
AICE customer with the matching customer on aimer-web. The value is
the same string both sides carry, so the cross-system bridge can map
audit and event traffic back to a single business entity.

- **When to set it.** Only after the value has been agreed with the
  aimer-web System Administrator over an out-of-band secure channel
  (in-house SSO messenger, in person, etc.). The recommended
  identifiers are a domain (e.g. `acmecorp.com`), a business
  registration number, or a contract code.
- **Validation.** Trimmed before storage. Empty / whitespace-only
  inputs clear the value back to blank. Non-empty values are limited
  to 256 characters and may not contain control characters. The
  external key is globally unique — submitting a value already in use
  by another customer returns a typed conflict.
- **Effect of a change.** Setting or changing the external key
  rewrites the cross-system mapping; the matching customer on
  aimer-web must be updated to keep the mapping intact, and a single
  bridge test is recommended right after.
- **Effect of clearing.** Clearing the external key disables
  *Send to Aimer* for the customer until a value is set again. Any
  existing mapping with the aimer-web side is no longer reachable
  from this side.
- **Customers without an external key.** Edits and queries continue
  to work normally; only the *Send to Aimer* button is disabled per
  customer until a value is populated.

For the full operator playbook (agreement workflow, recovery from
mismatches, audit forensics) see the canonical
[Cross-system customer identification](https://github.com/aicers/aimer-web/blob/main/docs/operations/cross-system-customer-identification.md)
guide on aimer-web.

<!-- TODO: screenshot - aimer-bridge batch -->

### Deleting a Customer

Deletion requires the `customers:delete` permission (System
Administrator only). No accounts may be assigned to the customer.
On deletion, the customer's database is dropped.

## Policies

Navigate to **Settings → Policies** to configure system-wide
policies. Requires `system-settings:read` to view,
`system-settings:write` to edit.

![Policies settings](../assets/system-settings-en.png)

Settings are organized into tabs:

### Password Policy

| Setting | Default | Description |
|---------|---------|-------------|
| Minimum length | 12 | Minimum password length |
| Maximum length | 128 | Maximum password length |
| Complexity | Enabled | Require uppercase, lowercase, digits, and symbols |
| Reuse ban count | 5 | Number of previous passwords that cannot be reused |

### Session Policy

| Setting | Default | Description |
|---------|---------|-------------|
| Idle timeout | 30 min | Time before inactive session expires |
| Absolute timeout | 8 hours | Maximum session duration |
| Max sessions | Unlimited | Maximum concurrent sessions per account |

### Lockout Policy

| Setting | Default | Description |
|---------|---------|-------------|
| Stage 1 threshold | 5 | Failed attempts before temporary lock |
| Stage 1 duration | 30 min | Duration of temporary lockout |

Stage 2 (permanent suspension) triggers automatically when an
account is locked a second time.

### JWT Policy

| Setting | Default | Description |
|---------|---------|-------------|
| Token expiration | 15 min | JWT access token lifetime |

### MFA Policy

| Setting | Default | Description |
|---------|---------|-------------|
| WebAuthn (FIDO2) | Enabled | Allow hardware key / platform authenticator |
| TOTP | Enabled | Allow time-based one-time passwords |

### Rate Limits

**Sign-in rate limits:**

| Setting | Default | Description |
|---------|---------|-------------|
| Per-IP count / window | 20 / 5 min | Requests per IP address |
| Per-account-IP count / window | 5 / 5 min | Requests per account + IP |
| Global count / window | 100 / 1 min | Total sign-in requests |

**API rate limits:**

| Setting | Default | Description |
|---------|---------|-------------|
| Per-user count / window | 100 / 1 min | Requests per authenticated user |

All changes to policy settings are recorded in the audit log.

## Triage exclusions

Triage exclusions remove unwanted source addresses, hostnames,
URIs, or domain patterns from the Triage corpus so they neither
score nor surface in the asset list. Two scopes are available:

- **Global exclusions** — managed at **Settings → Triage
  exclusions (global)** (the dedicated tab next to the
  per-customer page). Apply to every active customer. Requires
  the `triage:exclusion:global:write` permission to mutate; the
  tab is visible to anyone with `triage:read`.
- **Customer exclusions** — managed at **Settings → Triage
  exclusions**. Apply only to one customer's tenant database.
  The page accepts a `customer_id` query parameter
  (`/settings/triage-exclusions?customer_id=42`) so a deep link
  loads the requested customer's list directly; out-of-scope ids
  fall back to the first customer the caller can access. Read
  access requires `triage:read`; mutate access requires
  `triage:exclusion:write` plus that the customer is in the
  caller's effective scope.

Both scopes share the same column shape and the same retroactive
behavior: an ADD removes matching rows from the Triage baseline
corpus tables under the customer's cadence advisory lock so
cadence and the retroactive path always agree on the same final
corpus.

![Triage exclusions list (wireframe)](../assets/triage-exclusions-list-en.svg)

![Triage exclusions (global) page (wireframe)](../assets/triage-exclusions-global-en.svg)

> **Wireframe stand-ins.** The figures above and the Add dialog
> figure below are SVG wireframes per the
> [authoring exception for infrastructure-gated features](../AUTHORING.md#screenshot-exception-for-infrastructure-gated-features).
> The Triage exclusions UI depends on a populated
> `global_triage_exclusion` / per-tenant `triage_exclusion` corpus
> that the worktree's local environment cannot stand up without
> the cadence pager (which lands with aicers/review-web#842).
> They will be replaced with real PNG captures once the
> dependent infrastructure is available.

### Kind and value

Each exclusion has a **kind** (one of four) and a **value**
normalized at creation time:

| Kind | Value semantics |
|---|---|
| **IP address** | Single IP or CIDR. A single IP is upgraded to `/32` (IPv4) or `/128` (IPv6); host bits are zeroed (`192.168.1.5/24` → `192.168.1.0/24`). |
| **Hostname** | DNS name. Lowercased; trailing dot stripped. |
| **URI** | Exact match. Trimmed of leading and trailing whitespace; otherwise byte-preserving. |
| **Domain (regex)** | A regex pattern. Compiled at INSERT time; uncompilable patterns are rejected. |

Maximum length per value is **1024 characters** to bound regex
compile cost and keep the index footprint predictable.

### Domain regex preview

![Add exclusion dialog (wireframe)](../assets/triage-exclusions-add-dialog-en.svg)

The Add dialog runs a suffix-reducer over the supplied regex and
shows one of four previews. The reducer is conservative: it only
maps a regex to a SQL `host LIKE` predicate when the predicate
matches the regex's exact set of hosts.

- **Reduces to exact hostname `foo.example.com`** — the pattern
  `^foo\.example\.com$` reduces to an exact hostname. Past corpus
  rows with exactly that hostname are removed.
- **Reduces to suffix `.example.com` (subdomains only)** —
  patterns like `^.*\.example\.com$` or `^.+\.example\.com$`
  require at least one label before the literal `.example.com`,
  so the bare host `example.com` is **not** part of the regex's
  match set. The exclusion deletes past corpus rows whose `host`
  or `dns_query` ends with `.example.com`; bare `example.com` is
  left untouched.
- **Reduces to exact-or-suffix `.example.com`** — the
  repeating-label pattern `^([a-z0-9-]+\.)*example\.com$`
  permits zero label prefixes, so both bare `example.com` and
  any `*.example.com` are removed.
- **Full-regex-only** — anything else (alternations, anchored
  prefixes, single-label-only `^[^.]+\.example\.com$`,
  wildcards in the middle, etc.). The exclusion still takes
  effect on **future cadence ticks** but does **not**
  retroactively delete past corpus rows. The dialog calls this
  out so the operator is not surprised.

### Forward and retroactive enforcement

| Path | What happens |
|---|---|
| **Forward (cadence)** | The cadence runner reads the active union (global + customer-scoped) on every page and excludes matching events before they are written to the corpus. |
| **Retroactive (ADD)** | Adding a customer-scoped exclusion runs `DELETE` against `baseline_triaged_event` and `observed_event_meta` (and `policy_triaged_event` once the corpus B table exists), batched at 10,000 rows per statement. The INSERT and the **first** DELETE batch share one transaction so a crashed runner cannot leave a row inserted with no DELETE applied; subsequent batches drain in fresh per-batch transactions to bound lock duration and WAL pressure. The cadence advisory lock releases between the first batch and the drain. If the drain phase fails the dialog reports a hard error: the row is durable (visible on refresh) but past-corpus cleanup is incomplete and must be finished via the admin recovery surface, since cadence does not revisit already-ingested historical rows. Adding a **global** exclusion enqueues per-customer fanout jobs; the worker drains them under each customer's cadence advisory lock following the same first-batch-then-drain protocol, and re-checks the global row between tenant batches so a concurrent global delete cannot leave the worker dropping corpus rows for an exclusion that is no longer in the active set. |
| **Removing** | Future cadence ticks only. Past corpus rows that were excluded stay excluded. |

NTLM events have `host`, `dns_query`, and `uri` set to NULL, so
they only match retroactive **IP address** exclusions. Hostname,
URI, and Domain exclusions cannot retroactively delete NTLM rows
by definition.

### Audit

Each ADD and REMOVE emits an audit row:

- `triage_exclusion.global_add` / `.global_remove` —
  customer-agnostic, recorded against the `auth_db` global table.
- `triage_exclusion.customer_add` / `.customer_remove` — bound to
  the customer dimension. The fanout-driven `customer_add` rows
  carry `details.origin = "global_fanout"` and the originating
  `globalExclusionId` so the spread of a global ADD is visible in
  the audit log viewer.
- `triage_exclusion.fanout_failed` — emitted when a per-customer
  fanout job exhausts its retry budget (5 attempts with
  exponential backoff: 1m → 5m → 25m → 2h → 12h).
- `triage_exclusion.global_recover` / `.customer_recover` —
  emitted when an operator resets a `failed` cleanup row from the
  exclusion list's **Re-trigger cleanup** menu item (or from the
  internal recovery route). The menu item appears on rows whose
  past-corpus cleanup is stuck — either a `failed` sentinel in the
  `auth_db` fanout queue, or (for customer-scoped exclusions) a
  `triage_exclusion.customer_add` audit row recording
  `details.drainStatus = 'failed'` that has not yet been recovered.
  This audit-row fallback covers the rare case where the failed ADD
  path's sentinel insert itself failed (auth_db blip) so the queue
  has no row: clicking **Re-trigger cleanup** backfills a fresh
  `pending` sentinel from the audit record. Otherwise the click
  transitions the existing queue row back to `pending`. Either way
  the fanout worker picks it up on the next tick.
  `global_recover` is customer-agnostic; `customer_recover` carries
  `customer_id`.

### Background retention

The cron container runs four retention sweeps so the corpus, the
fanout queue, and the audit-snapshot tables do not grow without
bound:

- **Baseline corpus** (`run-triage-baseline-retention.sh`, daily
  at 03:15 UTC) — prunes `baseline_triaged_event` older than 180
  days and `observed_event_meta` older than 30 days, batched at
  10,000 rows per `DELETE` statement.
- **Policy corpus B** (`run-triage-policy-retention.sh`, every 6
  hours) — flips stuck `policy_triage_run` rows in `computing`
  state (>30 min) to `failed` with
  `last_error = 'timeout: runner did not finalize'`, then applies
  differential retention (ready 30d / superseded 7d / failed 1d)
  and prunes rows whose `owner_account_id` no longer resolves.
  `policy_triaged_event` rows cascade.
- **Condition snapshots** (`run-triage-snapshot-retention.sh`,
  daily at 04:15 UTC, one hour after the corpus A sweep) — prunes
  `exclusion_snapshot` and `policy_snapshot` rows whose
  fingerprints are no longer referenced by any
  `baseline_triaged_event` or `policy_triage_run` row, with a
  30-day grace counted from when the fingerprint was first
  observed as unreferenced (tracked via the `unreferenced_since`
  tombstone, not from `captured_at`). The sweep runs three phases
  per table — tombstone newly orphaned rows, clear the tombstone
  if a later corpus row revives the fingerprint, then delete rows
  still tombstoned past the grace. `baseline_version_snapshot` is
  retained forever and is skipped. Token:
  `TRIAGE_SNAPSHOT_RETENTION_INTERNAL_TOKEN`.
- **Engagement signals** (`run-triage-engagement-retention.sh`,
  daily at 05:15 UTC) — prunes `engagement_impression` rows
  older than 90 days and `engagement_action` rows older than
  180 days, batched at 10,000 rows per `DELETE` statement. The
  cadence is independent of the corpus / snapshot retention
  passes; the 05:15 slot only clusters the morning log window.
  Token: `TRIAGE_ENGAGEMENT_RETENTION_INTERNAL_TOKEN`.
- **Aimer Phase 2 manual-mint ledger**
  (`run-aimer-phase2-manual-mint-retention.sh`, daily at 06:15
  UTC) — prunes `aimer_phase2_manual_mint` rows older than 24
  hours (consumed or not). Every manual Send-to-aimer-web mints
  one ledger row; abandoned sends that never reach `ack-manual`
  would otherwise grow the table without bound. The 24h window
  is well outside the single-use JTI TTL, so any late
  `ack-manual` would have already been rejected at the JTI
  validity layer. Token:
  `AIMER_PHASE2_MANUAL_MINT_RETENTION_INTERNAL_TOKEN`.
- **Exclusion fanout** (`run-triage-exclusion-fanout.sh`, every
  minute) — drains the `triage_exclusion_fanout_job` queue. The
  minute cadence matches the worker's first-tier backoff (1 min)
  so a transient tenant-DB outage retries promptly.

Each wrapper writes a timestamped JSON response to
`/var/log/cron/` and re-emits an `overall != 'ok'` warning to
stderr; alerting should key on the structured log lines tagged
`cron-baseline-retention`, `cron-policy-retention`,
`cron-snapshot-retention`, `cron-engagement-retention`,
`cron-aimer-manual-mint-retention`, and `cron-fanout`.

## Profile

The Profile page is accessed from **Settings → Profile**. It
allows users to manage personal preferences, two-factor
authentication, and passkeys.

### Preferences

Users can configure their language and timezone preferences.

![Profile preferences](../assets/preferences-en.png)

### Two-Factor Authentication (TOTP)

The TOTP card shows the current enrollment status and allows
users to enable or disable time-based one-time passwords.

The card displays one of four states depending on the TOTP
enrollment status and administrator policy:

| State | Display |
|-------|---------|
| Available, not enrolled | "Disabled" badge with **Enable TOTP** button |
| Available, enrolled | "Enabled" badge with **Disable TOTP** button |
| Disabled by admin, enrolled | "Enabled" badge with admin notice and **Remove TOTP** button |
| Not available | "Disabled" badge with "TOTP is not available" message |

![TOTP — available, not enrolled](../assets/totp-disabled-en.png)

#### Enabling TOTP

1. Click **Enable TOTP** to open the setup wizard.
2. Scan the QR code with your authenticator app (e.g., Google
   Authenticator, Authy). Alternatively, click **Can't scan?
   Enter this key manually** to copy the secret key.
3. Enter the 6-digit code displayed in your authenticator app.
4. Click **Verify** to complete setup.

![TOTP setup wizard](../assets/totp-setup-en.png)

After successful verification, TOTP is enabled and you will be
prompted for a code on subsequent sign-ins.

![TOTP — available, enrolled](../assets/totp-enabled-en.png)

#### Disabling TOTP

1. Click **Disable TOTP** (or **Remove TOTP** if disabled by
   admin).
2. Enter your current 6-digit TOTP code to confirm.
3. Click **Disable TOTP** (or **Remove TOTP**) to remove the
   credential.

![TOTP disable dialog](../assets/totp-disable-en.png)

#### Disabled by Administrator

When an administrator removes TOTP from the allowed MFA
methods while a user still has TOTP enrolled, the card shows
an "Enabled" badge with a notice that TOTP has been disabled
by an administrator. The user can click **Remove TOTP** to
remove the stale credential.

![TOTP — disabled by admin](../assets/totp-admin-disabled-en.png)

#### Not Available

When the administrator has not enabled TOTP in the MFA policy
and the user has no TOTP credential enrolled, the card shows a
"Disabled" badge with a "TOTP is not available" message. No
action is available to the user.

![TOTP — not available](../assets/totp-not-available-en.png)

#### MFA Sign-In

When TOTP is enabled, sign-in requires an additional step after
entering your password. Enter the 6-digit code from your
authenticator app and click **Verify**.

![MFA sign-in challenge](../assets/mfa-sign-in-en.png)

### Passkeys (WebAuthn)

The Passkeys card shows registered passkey credentials and allows
users to register, rename, or remove passkeys for passwordless
sign-in verification.

The card displays one of four states depending on enrollment and
administrator policy:

| State | Display |
|-------|---------|
| Available, not enrolled | "Disabled" badge with **Register Passkey** button |
| Available, enrolled | "Enabled" badge with credential list and **Add Passkey** button |
| Disabled by admin, enrolled | "Enabled" badge with admin notice and credential list (remove only) |
| Not available | "Disabled" badge with "Passkeys are not available" message |

![Passkeys — available, not enrolled](../assets/webauthn-disabled-en.png)

#### Registering a Passkey

1. Click **Register Passkey** (or **Add Passkey** if you already
   have one registered).
2. Optionally enter a display name (e.g., "MacBook Touch ID").
3. Click **Register Passkey** to start the browser prompt.
4. Follow your browser's prompt to create the passkey.

![Passkey registration](../assets/webauthn-register-en.png)

After successful registration, the passkey appears in the
credential list.

![Passkeys — available, enrolled](../assets/webauthn-enabled-en.png)

#### Renaming a Passkey

Click the pencil icon next to a passkey, enter the new name,
and click **Save**.

#### Removing a Passkey

1. Click the trash icon next to the passkey you want to remove.
2. Enter your account password to confirm.
3. Click **Remove Passkey** to delete the credential.

#### Disabled by Administrator

When an administrator removes WebAuthn from the allowed MFA
methods while a user still has passkeys enrolled, the card shows
an "Enabled" badge with a notice that passkeys have been disabled
by an administrator. The user can still remove credentials but
cannot register new ones.

![Passkeys — disabled by admin](../assets/webauthn-admin-disabled-en.png)

#### Not Available

When the administrator has not enabled WebAuthn in the MFA policy
and the user has no passkeys enrolled, the card shows a "Disabled"
badge with a "Passkeys are not available" message. No action is
available to the user.

![Passkeys — not available](../assets/webauthn-not-available-en.png)

#### MFA Sign-In with Passkey

When a passkey is enrolled, sign-in requires an additional step
after entering your password. Follow your browser's prompt to
verify your identity with the passkey. If both TOTP and WebAuthn
are enrolled, you can switch between methods.

![MFA method selection](../assets/mfa-method-select-en.png)

#### Recovery Code Sign-In

If you lose access to your authenticator app or passkey, you
can use a recovery code to sign in. On the MFA verification
step, click **Use a recovery code**, enter one of your saved
codes, and click **Verify**.

![Recovery code sign-in](../assets/mfa-recovery-sign-in-en.png)

Each recovery code can only be used once.

### Recovery Codes

Recovery codes provide a backup way to sign in when your
primary MFA method (TOTP or passkey) is unavailable. Ten
single-use codes are generated and stored as hashed values.

![Recovery codes card](../assets/recovery-codes-en.png)

#### Automatic Generation

When you enroll your first MFA method, 10 recovery codes
are automatically generated and displayed. Save these codes
in a secure location — they will not be shown again.

![Recovery codes after enrollment](../assets/enroll-mfa-codes-en.png)

#### Generating Recovery Codes

If you have no recovery codes or want to replace existing
ones:

1. Navigate to **Settings → Profile**.
2. In the Recovery Codes card, click **Generate Recovery
   Codes** (or **Regenerate Codes** if codes already exist).
3. Enter your account password to confirm.
4. Click **Generate Recovery Codes** in the dialog.

![Generate recovery codes dialog](../assets/recovery-codes-generate-en.png)

The new codes are displayed once. Use **Copy All** to copy
them to your clipboard or **Download** to save them as a
text file.

![Recovery codes displayed](../assets/recovery-codes-display-en.png)

Regenerating codes invalidates all previous codes.

#### Recovery Code Count

The card shows how many unused codes remain (e.g.,
"9/10 remaining"). A warning badge appears when 3 or
fewer codes remain.

### Mandatory MFA Enrollment

When a role has MFA required and a user has not enrolled
any MFA method, the user is redirected to the mandatory
enrollment page after signing in. The user cannot access
any dashboard page until at least one MFA method is enrolled.

![Mandatory MFA enrollment page](../assets/enroll-mfa-en.png)

The enrollment page automatically starts the TOTP setup
wizard:

1. Scan the QR code with your authenticator app, or click
   **Enter this key manually** to copy the secret key.
2. Enter the 6-digit code from your authenticator app.
3. Click **Verify** to complete enrollment.

After verification, your recovery codes are displayed.
Save them securely, then click **Done** to proceed to the
dashboard.

## Account Status

Navigate to **Settings → Account Status** to view operational
monitoring cards. Requires `dashboard:read` permission to view.

![Account status](../assets/dashboard-en.png)

### Active Sessions

Lists all currently active sessions. Users with the
`dashboard:write` permission can terminate individual sessions
using the **Revoke** button.

### Locked and Suspended Accounts

Shows accounts that are currently locked or suspended. Users
with the `accounts:write` permission can:

- **Unlock** a temporarily locked account.
- **Restore** a suspended account.

### Suspicious Activity

Displays security alerts detected in the last 24 hours,
categorized by severity (critical, high, medium, low). Each
alert shows the rule name, description, occurrence count, and
the most recent timestamp.

### Certificate Expiry

Displays mTLS certificate status with severity indicators:

- **OK** — certificate is valid with plenty of time remaining.
- **Warning** — certificate will expire soon.
- **Critical** — certificate is expired or expiring imminently.

## Aimer Integration

Navigate to **Settings → Aimer Integration** to configure the
system-wide prerequisites for the Send to Aimer flow. This
section is reserved for the **System Administrator** role —
Tenant Administrator and Security Monitor are denied access at
the page route, the public-JWK / thumbprint read endpoint, and
every mutation endpoint, regardless of any custom permission
grants.

<!-- TODO: screenshot - aimer-bridge batch -->

### Setup status

Analyze with Aimer requires five system-wide prerequisites:

1. **`aice_id`** — the deployment hostname. Used as the JWT
   `iss` claim and as the `aice_id` claim sent to aimer-web.
   aimer-web's `trust_registry` joins on this value, so it must
   match the entry registered there.
2. **`aimer_web_bridge_url`** — the base URL of the aimer-web
   instance whose `/api/analysis/analyze-bridge` endpoint
   receives the top-level multipart POST. HTTPS only.
3. **`aimer_default_model_name`** — the default LLM vendor /
   model-family identifier embedded as the `model_name` claim
   in the `analyze_params_token` JWS. The accepted catalog is
   owned by aimer-side configuration; any non-empty string is
   structurally valid here.
4. **`aimer_default_model`** — the default LLM model identifier
   embedded as the `model` claim. Same shape rules as
   `aimer_default_model_name`.
5. **Context-token signing keypair** — a dedicated ES256 keypair
   stored under `data/keys/aimer-context-signing.json`.

When all five are set the page shows **Configured (system-wide)**.
Any missing prerequisite turns the badge red and lists what is
missing. Customer-level `external_key` is a per-customer setting
and is intentionally **not** part of system-wide setup status; the
page shows an informational line linking to the customers page.

<!-- TODO: screenshot - aimer-bridge batch -->

### Context-token signing keypair

The signing keypair is **separate** from the JWT signing key and
from mTLS keys, by design — keeping the trust domains independent
prevents a compromise of one from invalidating the others.

#### Thumbprint

After **Generate**, the page shows the public JWK and the RFC 7638
SHA-256 Thumbprint in two formats simultaneously:

- **base64url** (43 characters, no padding) — canonical. Use this
  when accuracy matters; copy and compare it with the value shown
  on aimer-web's environment registration screen.
- **colon-separated hex** — the same SHA-256 (32 bytes / 64 hex
  characters) grouped in 4-byte blocks. Visual aid for verbal or
  mental comparison.

Both formats encode the same bytes; only the rendering differs.
The Thumbprint is computed server-side from the public JWK and
the **private key never leaves the server** — the UI receives only
the public JWK and the thumbprint via API responses.

<!-- TODO: screenshot - aimer-bridge batch -->

#### Rotation lifecycle

The rotation state machine has four states:

| State | Available actions |
| --- | --- |
| Empty | **Generate** |
| Active only | **Rotate** |
| Active + pending | **Switch** (requires confirmation checkbox) |
| Active + previous | **Deactivate** (after the retention window) |

1. **Generate** — first-boot. Creates the active kid.
2. **Rotate** — mints a *pending* kid alongside the active one.
   The active kid keeps signing tokens until you Switch.
3. **Switch** — promotes the pending kid to active and demotes the
   old kid to *previous*. **Required precondition**: the new kid
   must already be registered on aimer-web's trust registry, or
   tokens signed by the new kid will be rejected. The page asks
   you to tick a confirmation checkbox before the button enables.
4. **Deactivate** — drops the previous kid from disk. Auto-eligible
   after a short retention window (default: 5 minutes — sized to
   the context-token TTL plus a clock-skew margin) so in-flight
   verification on aimer-web's side has time to complete via
   redelivery.

A dashboard banner warns when rotation is approaching:

- **Yellow** at 30 days before the recommended rotation date.
- **Red** at 7 days.
- **Gray** after the recommended rotation date has passed.

<!-- TODO: screenshot - aimer-bridge batch -->

#### File permissions

The on-disk file is written with mode `0600` and the parent
`data/keys/` directory with `0700`. If the file mode drifts (for
example, when an operator restores a backup with looser perms),
the page surfaces a permission alert with operator guidance to
fix it before continuing. The boot log also records a warning.

The application **fails closed** if it cannot set `0600` on a
new key file — it refuses to leave a private key with looser
permissions on disk.

### `aice_id`

Hostname (RFC 1123) identifying this AICE instance to aimer-web.
Underscores are intentionally rejected — `aice_id` is also the
JWT `iss` claim, so a strict hostname keeps the trust-registry
join key portable.

Example: `acme.example.com`.

### `aimer_web_bridge_url`

Base URL of the aimer-web instance, HTTPS-only. The path is
normalized to a canonical form (no trailing slash). Credentials,
query strings, and fragments are rejected.

Example: `https://aimer.example.com`.

### `aimer_default_model_name`

Default LLM vendor / model-family identifier sent as the
`model_name` claim of the `analyze_params_token` JWS. Any
non-empty string up to 256 characters is structurally valid;
the accepted catalog is owned by aimer-side configuration.

Example: `anthropic`.

### `aimer_default_model`

Default LLM model identifier sent as the `model` claim of the
`analyze_params_token` JWS. Any non-empty string up to 256
characters is structurally valid; the accepted catalog is
owned by aimer-side configuration.

Example: `claude-sonnet-4-6`.

### Effect-warning modal

Editing any of `aice_id`, `aimer_web_bridge_url`,
`aimer_default_model_name`, or `aimer_default_model` triggers
a non-dismissable modal that warns:

> After this change, the operator must re-register this
> environment on aimer-web. Existing registrations are
> invalidated and any context tokens issued in the interim
> will be rejected.

You must explicitly confirm before the change is committed.

<!-- TODO: screenshot - aimer-bridge batch -->

### Audit log

The Aimer integration page records:

- `aimer_signing_key.generated`, `.rotated`, `.switched`,
  `.deactivated` — keypair lifecycle events.
- `aimer_integration_setting.changed` — any of `aice_id`,
  `aimer_web_bridge_url`, `aimer_default_model_name`, or
  `aimer_default_model` changed, with the `{key, old, new}`
  triple.

The Analyze with Aimer flow records, on every browser-initiated
envelope mint (issued by the `POST /api/aimer/analyze-envelope`
endpoint that the **Analyze with Aimer** button calls in the
background):

- `aimer_analyze_envelope.issued` — success. The audit row is
  bound to the resolved customer and carries the issued `jti`,
  the active signing-key `kid`, the locator's `event_key`, the
  resolved `lang`, the `force` flag, and whether the
  `event_data` source was the baseline corpus or the REview
  fallback, so a forensic analyst can correlate the envelope
  with the matching record on `aimer-web`.
- `aimer_analyze_envelope.denied` — failure. Carries a `reason`
  detail enumerating the gate that rejected the request:
  `aimer_integration_not_configured` (one of the five
  prerequisites in the [Setup status](#setup-status) section is
  missing), `customer_external_key_missing` (the resolved
  customer has no `external_key`), `event_not_found_for_customer`
  (the locator did not resolve under the chosen customer's
  scope — also covers the access-denied branch, which is
  intentionally masked behind the same status to avoid leaking
  customer existence), or `rate_limited` (the per-account+IP
  bridge bucket — 30 requests / 60 seconds — was exhausted).

All actions are part of the closed audit-action union, so the
audit log viewer surfaces them automatically.

### Backup

The signing keypair file (`data/keys/aimer-context-signing.json`)
is included in the on-disk backup target alongside the JWT signing
key. See `decisions/backup-restore.md` for the full backup scope.

### Phase 2 sync status

The **Phase 2 sync status** block at the bottom of the page surfaces a
per-customer, three-track view of opportunistic baseline-event /
story pushes (RFC 0002 §7), manual policy-run sends, and the
withdraw-policy-event notice queue. Pick a customer from the dropdown
to load that customer's status; the panel auto-polls every few
seconds and exposes the operator actions described below.

![Phase 2 sync status block (wireframe)](../assets/aimer-phase2-status-block-en.svg)

> Wireframe stand-in per `docs/AUTHORING.md` §"Screenshot exception
> for infrastructure-gated features". The Phase 2 status block reads
> `aimer_push_state` + `aimer_push_queue` rows that only exist once
> a live opportunistic-push deployment writes them; this worktree
> has no such data. A real PNG capture will replace this SVG once a
> staging tenant with seeded push state is available.

#### Tracks

- **Streaming kinds** — `baseline_event` and `story`. Each row
  shows a colored bucket dot (`synced` green / `behind` yellow /
  `way_behind` red / `paused` gray), the last-synced relative
  time, an approximate backlog ("~12,000 events, ~2 hours behind"
  or "~2 hours behind" when the count is too expensive to
  materialise), the pending unack'd notice count + oldest pending
  age, per-notice-kind badges (`withdraw × N` in amber,
  `refresh × N` in sky, `backfill × N` in slate so a real ingest
  gap stands out from operator-driven catch-up work), the most
  recent `last_error` (if any), and the pause toggle. A `paused`
  row keeps reporting its real cursor lag / approximate count so
  an operator can see how far behind the stream has fallen since
  it was paused — "Backlog unavailable" is only shown when no
  cursor data exists at all (fresh tenant, no pushes ever). The
  pause-badge actor (e.g. "Paused 5 min ago by alice") is the
  `accounts.display_name` resolved from the
  `aimer_push_state.paused_by` account UUID in one batched
  app-DB lookup; the raw UUID is only used as a fallback when
  the account row has been deleted.
- **Policy runs (manual)** — surfaces "Last sent run: #N at
  *time*" plus "Total runs sent: M", sourced from
  `policy_triage_run` β columns (`last_sent_at`, `last_sent_by`,
  `send_count`). The total is `COUNT(*) WHERE last_sent_at IS
  NOT NULL`, not `SUM(send_count)`, so re-sends of the same run
  do not double-count.
- **Policy event withdrawals** — queue-only kind, no cursor / no
  pause. Shows the unack'd `withdraw_policy_event` count, the
  oldest pending age, a `withdraw × N` badge, and the newest
  unack'd queue row's `last_error` as-is. If that newest row
  has not failed yet the field is empty even when older rows in
  the queue carry stale errors — surfacing an older error would
  misrepresent the current head of the queue.

Queue payload bodies are never returned by the underlying
`GET /api/aimer/phase2/status` route — only counts, errors, and
bucket labels.

![Phase 2 streaming-kind row (wireframe)](../assets/aimer-phase2-streaming-row-en.svg)

> Wireframe stand-in — see note above. The streaming row depends
> on the same live push data as the parent block.

#### Sync now

A **Sync now** button appears under the tracks when at least one
streaming kind is **not** paused, or when there are pending
unack'd `withdraw_policy_event` notices. The button is hidden
when both streaming kinds are paused AND there are zero pending
policy-event notices.

Click sequence:

1. The browser POSTs to `/api/aimer/phase2/sync-now`. The route
   records one `aimer_phase2.sync_now` audit row (with the static
   `triggeredKinds` list and the targeted `customerId`) and
   returns `204 No Content`. The server never performs the
   drain.
2. After the wrapper acks, the same browser session invokes
   `drainOpportunisticPushQueue` for `baseline_event`, `story`,
   and `policy_event` in parallel.
3. Live progress (`"Syncing baseline events… batch N of ~M"`) is
   shown while drains run.
4. On completion the panel shows a single-line summary
   (`"Synced: 42 baseline events, 3 stories, 7 notices drained,
   0 errors"`). The "notices drained" count covers both
   successfully withdrawn rows and successfully ack'd
   `not_found` no-ops, because either way the queue row is
   removed; reporting only the withdrawn count would render
   "0 notices drained" for a successful all-not-found drain.
   The completion counts are **client-side informational
   state**, not an audit source of truth — the audit row only
   records the operator click.

#### Pause / Resume

The pause toggle next to each streaming row flips
`opportunistic_enabled` for that kind. A confirmation dialog
appears before the change is committed; on confirm the wrapper
route `POST /api/aimer/phase2/pause-toggle` calls
`setOpportunisticEnabled` and emits
`aimer_phase2.opportunistic_paused` (or
`aimer_phase2.opportunistic_resumed` on the reverse direction,
with `pausedDurationSeconds`). Manual Send and admin Backfill
keep working while a kind is paused.

`policy_run` and `policy_event` have no pause toggle by design:
the first is operator-driven per-run, the second has no
opportunistic background drain.

#### Backfill

The **Backfill historical window** form below the tracks queues
a backfill for an existing baseline / story window. Pick the
kind, supply a half-open `[from, to)` window, confirm in the
dialog, and submit. The wrapper route
`POST /api/aimer/phase2/backfill` validates the window, calls
the same `runPhase2Backfill` helper as the internal-token route,
emits `aimer_phase2.backfill`, and returns the list of enqueued
notice ids. The Settings panel surfaces the count in a toast.

Window bounds (enforced by both the UI and the underlying route):

- `from` must be strictly before `to`.
- `to` must not extend into the future (60 s skew slack).
- `from` may not be older than 180 days, the
  `baseline_triaged_event` retention horizon.
- A window that spans more than one `baseline_version` is
  rejected with a `400 multi_version` error — narrow the window
  so all rows share one version.

![Phase 2 backfill historical window form (wireframe)](../assets/aimer-phase2-backfill-form-en.svg)

> Wireframe stand-in — see note above. The form itself is fully
> client-driven, but a meaningful screenshot needs the surrounding
> status block populated, which is what the live push data gates.

#### Audit actions

The Phase 2 block records:

- `aimer_phase2.sync_now` — emitted by the wrapper route at
  click time. `details.triggeredKinds` is the static list
  `["baseline_event", "story", "policy_event"]`. Per-kind
  delivery counts live in client-side state only.
- `aimer_phase2.backfill` — `details: { kind, from, to,
  enqueuedNoticeCount }`.
- `aimer_phase2.opportunistic_paused` — `details: { kind }`.
- `aimer_phase2.opportunistic_resumed` — `details: { kind,
  pausedDurationSeconds }`.

All four are customer-scoped, so the audit-log viewer surfaces
them under the tenant operator's effective customer scope.

### Login banner

If any customer is in the `behind` / `way_behind` / `paused`
bucket for a tracked kind, the dashboard renders a one-line
banner at the top of the app shell summarizing the situation and
linking to **Settings → Aimer integration**. The banner is
fetched client-side after first paint via
`GET /api/aimer/phase2/status/summary` so it never blocks SSR or
initial document render; the summary route applies bounded
per-customer concurrency, a short server-side TTL cache, and
skips the expensive backlog-count fast path because the banner
only needs the bucket label.

The banner is dismissible per page; a reload or navigation
re-fetches and shows it again if the condition still holds. It
is gated on the System Administrator role, same as the
underlying summary route.

The banner copy lists the worst bucket across all flagged
customers, the customer count, and the union of contributing
kinds. A "paused kinds" marker is appended whenever **any**
customer has at least one paused streaming kind — even when
that customer's worst bucket is `behind` or `way_behind` (for
example, baseline paused AND policy_event way behind on the
same tenant). Otherwise a mixed-state customer would silently
drop the pause signal because pause ranks below behind /
way_behind in `worst_bucket` severity.

The summary route restricts the customer set to active tenants
(`customers.status = 'active'`) so the banner only warns about
customers an operator can actually act on — the Phase 2
customer picker on **Settings → Aimer integration** is itself
filtered to active customers, and warning about a suspended /
deleted tenant the operator cannot select would link to a page
where that customer is absent.

### Internal-token backfill route

The Settings UI Backfill form is a session-authenticated wrapper
around `POST /api/internal/aimer/phase2/backfill`. Deployment
schedulers and ops runbooks may invoke the internal route
directly before the Settings UI is available.

- **Env var** — `AIMER_PHASE2_BACKFILL_INTERNAL_TOKEN`. The
  route refuses every request (including ones with a valid-
  looking Bearer header) if the env var is unset on the
  deployment.
- **Auth** — `Authorization: Bearer <token>`, constant-time
  compared.
- **Body schema** —

  ```json
  {
    "customer_id": <positive integer>,
    "kind": "baseline_event" | "story",
    "from": "<ISO-8601 timestamp>",
    "to":   "<ISO-8601 timestamp>"
  }
  ```

  Window is half-open `[from, to)`.
- **Response codes** —
  - `200 OK` with `{ "enqueued_notice_ids": ["<id>", ...] }`.
  - `400 Bad Request` — malformed body, unknown kind, inverted
    window, future `to`, `from` older than the retention
    horizon, or a window that spans more than one
    `baseline_version`.
  - `401 Unauthorized` — missing / wrong / unset Bearer token.
  - `404 Not Found` — unknown customer id.
  - `500 Internal Server Error` — DB error during payload
    construction or enqueue.
- **Window bounds** — `to` may not be in the future (60 s
  skew slack); `from` may not be older than
  `BASELINE_TRIAGED_EVENT_RETENTION_DAYS` (180 days). Older
  windows would yield empty / partial payloads because the
  local rows have been swept.

Example invocation:

```sh
curl -sS -X POST "https://aice.example.com/api/internal/aimer/phase2/backfill" \
  -H "Authorization: Bearer ${AIMER_PHASE2_BACKFILL_INTERNAL_TOKEN}" \
  -H "Content-Type: application/json" \
  --data '{
    "customer_id": 42,
    "kind": "baseline_event",
    "from": "2026-04-01T00:00:00Z",
    "to":   "2026-04-02T00:00:00Z"
  }'
```
