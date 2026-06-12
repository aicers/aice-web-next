-- auth_db v1 initial schema.
--
-- The pre-release migration history (0001-0035) was squashed into this
-- single file before the first release; it creates the complete auth
-- schema and seed data on an empty database.

-- ── Roles and permissions ──────────────────────────────────────────

CREATE TABLE roles (
  id           SERIAL PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  description  TEXT,
  is_builtin   BOOLEAN NOT NULL DEFAULT false,
  mfa_required BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE role_permissions (
  role_id    INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission TEXT NOT NULL,
  PRIMARY KEY (role_id, permission)
);

-- Seed built-in roles (Discussion #32 §1.4). System Administrator
-- requires MFA by default; admins can override per account via
-- `accounts.mfa_override`.
INSERT INTO roles (name, description, is_builtin, mfa_required) VALUES
  ('System Administrator',
   'Full system, account, role, customer management',
   true, true),
  ('Tenant Administrator',
   'Tenant-scoped operations and Security Monitor account management, node and service management within assigned customers',
   true, false),
  ('Security Monitor',
   'Read-only event, dashboard, and detection access within assigned customers, node and service status read-only within assigned customer',
   true, false);

-- System Administrator: every permission, unrestricted.
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p.permission
FROM roles r,
LATERAL (VALUES
  ('accounts:read'), ('accounts:write'), ('accounts:delete'),
  ('roles:read'), ('roles:write'), ('roles:delete'),
  ('customers:read'), ('customers:write'), ('customers:delete'),
  ('customers:access-all'),
  ('audit-logs:read'),
  ('system-settings:read'), ('system-settings:write'),
  ('dashboard:read'), ('dashboard:write'),
  ('detection:read'),
  ('event:read'),
  ('nodes:read'), ('nodes:write'), ('nodes:delete'),
  ('services:read'), ('services:write'),
  ('triage:read'),
  ('triage:policy:write'),
  ('triage:exclusion:write'),
  ('triage:exclusion:global:write')
) AS p(permission)
WHERE r.name = 'System Administrator';

-- Tenant Administrator: scoped account/customer management plus
-- detection, event, triage, and node/service management within
-- assigned customers.
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p.permission
FROM roles r,
LATERAL (VALUES
  ('accounts:read'), ('accounts:write'), ('accounts:delete'),
  ('customers:read'), ('customers:write'),
  ('detection:read'),
  ('event:read'),
  ('nodes:read'), ('nodes:write'), ('nodes:delete'),
  ('services:read'), ('services:write'),
  ('triage:read'),
  ('triage:policy:write'),
  ('triage:exclusion:write')
) AS p(permission)
WHERE r.name = 'Tenant Administrator';

-- Security Monitor: read-only access within assigned customers.
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p.permission
FROM roles r,
LATERAL (VALUES
  ('detection:read'),
  ('event:read'),
  ('nodes:read'),
  ('services:read'),
  ('triage:read')
) AS p(permission)
WHERE r.name = 'Security Monitor';

-- ── Accounts and sessions ──────────────────────────────────────────

CREATE TABLE accounts (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username              TEXT NOT NULL UNIQUE,
  display_name          TEXT NOT NULL,
  password_hash         TEXT NOT NULL,
  email                 TEXT,
  phone                 TEXT,
  role_id               INTEGER NOT NULL REFERENCES roles(id),
  status                TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'locked', 'suspended', 'disabled')),
  token_version         INTEGER NOT NULL DEFAULT 0,
  must_change_password  BOOLEAN NOT NULL DEFAULT false,
  failed_sign_in_count  INTEGER NOT NULL DEFAULT 0,
  locked_until          TIMESTAMPTZ,
  max_sessions          INTEGER,
  allowed_ips           TEXT[],
  locale                TEXT,
  timezone              TEXT,
  -- User-selectable time-display format (#766). Four nullable,
  -- no-DEFAULT columns; NULL uniformly means "use the app default"
  -- (today's format), keeping "never touched the setting" distinct
  -- from any explicit choice.
  --   time_format_locale: NULL = follow browser; 'app' = follow app
  --   locale; any other value = an explicit BCP-47 tag from the
  --   curated list (app-layer validated, like timezone).
  --   time_format_hour_cycle: NULL = follow the locale's default.
  --   time_format_seconds: NULL = default (show).
  --   time_format_tz_label: NULL = default (hide).
  time_format_locale     TEXT,
  time_format_hour_cycle TEXT
                        CHECK (time_format_hour_cycle IN ('h12', 'h23')),
  time_format_seconds    BOOLEAN,
  time_format_tz_label   BOOLEAN,
  last_sign_in_at       TIMESTAMPTZ,
  password_changed_at   TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lockout_count         INTEGER NOT NULL DEFAULT 0,
  -- Per-account MFA override: NULL (follow role default), 'exempt',
  -- or 'required'.
  mfa_override          TEXT CHECK (mfa_override IN ('exempt', 'required'))
);

-- needs_reauth: flags sessions that require re-authentication due to
-- IP/UA changes (risk-based step-up auth per Discussion #32 §8.2).
-- browser_fingerprint: normalized "Family/Major" string for efficient
-- UA comparison without reparsing the full user_agent on every request.
-- Every writer supplies it explicitly (`extractBrowserFingerprint`
-- never returns an empty string), so there is no default.
CREATE TABLE sessions (
  sid                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  ip_address          TEXT NOT NULL,
  user_agent          TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_active_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked             BOOLEAN NOT NULL DEFAULT false,
  needs_reauth        BOOLEAN NOT NULL DEFAULT false,
  browser_fingerprint TEXT NOT NULL,
  -- Session-level flag for mandatory MFA enrollment.
  must_enroll_mfa     BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX idx_sessions_account_id ON sessions (account_id);

CREATE TABLE password_history (
  id            BIGSERIAL PRIMARY KEY,
  account_id    UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_password_history_account_created
  ON password_history (account_id, created_at DESC);

-- ── Customers ──────────────────────────────────────────────────────

CREATE TABLE customers (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT,
  database_name TEXT NOT NULL UNIQUE,
  status        TEXT NOT NULL DEFAULT 'active',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Aimer-bridge customer mapping (#438): pairs an aice-web-next
  -- customer with the matching customer on the aimer-web side via a
  -- globally unique operator-agreed identifier (aimer-web's
  -- `auth_db.customers.external_key` is `TEXT NOT NULL UNIQUE`; the
  -- UNIQUE here mirrors it). NULL-allowed: operators populate it per
  -- customer at their own pace, and customers without it are
  -- non-eligible for Send to Aimer (#440).
  external_key  TEXT UNIQUE
);

CREATE TABLE account_customer (
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  PRIMARY KEY (account_id, customer_id)
);

-- ── System settings ────────────────────────────────────────────────

CREATE TABLE system_settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- `aice_id` / `clumit_insight_bridge_url` identify the deployment to
-- aimer-web and point at its bridge endpoint (#437);
-- `clumit_insight_default_model_name` / `clumit_insight_default_model` are the required
-- analyze-bridge claims aice-web-next mints server-side (#629). All
-- four ship as `null` so Setup status starts "Not configured" and the
-- operator must enter them via the admin UI. The third Send-to-Aimer
-- prerequisite (the context-token signing keypair) lives on disk under
-- `data/keys/aimer-context-signing.json` — see
-- `src/lib/aimer/signing-key.ts`.
INSERT INTO system_settings (key, value) VALUES
  ('password_policy', '{
    "min_length": 12,
    "max_length": 128,
    "complexity_enabled": false,
    "reuse_ban_count": 5
  }'::jsonb),
  ('session_policy', '{
    "idle_timeout_minutes": 30,
    "absolute_timeout_hours": 8,
    "max_sessions": null
  }'::jsonb),
  ('lockout_policy', '{
    "stage1_threshold": 5,
    "stage1_duration_minutes": 30
  }'::jsonb),
  ('signin_rate_limit', '{
    "per_ip_count": 20,
    "per_ip_window_minutes": 5,
    "per_account_ip_count": 5,
    "per_account_ip_window_minutes": 5,
    "global_count": 100,
    "global_window_minutes": 1
  }'::jsonb),
  ('api_rate_limit', '{
    "per_user_count": 100,
    "per_user_window_minutes": 1
  }'::jsonb),
  ('jwt_policy', '{
    "access_token_expiration_minutes": 15
  }'::jsonb),
  ('mfa_policy', '{
    "allowed_methods": ["webauthn", "totp"]
  }'::jsonb),
  ('aice_id', 'null'::jsonb),
  ('clumit_insight_bridge_url', 'null'::jsonb),
  ('clumit_insight_default_model_name', 'null'::jsonb),
  ('clumit_insight_default_model', 'null'::jsonb);

-- ── MFA: TOTP, WebAuthn, recovery codes, challenges ────────────────

CREATE TABLE totp_credentials (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  secret      TEXT NOT NULL,
  verified    BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_totp_account UNIQUE (account_id)
);

CREATE INDEX idx_totp_account ON totp_credentials (account_id);

CREATE TABLE mfa_challenges (
  jti        UUID PRIMARY KEY,
  account_id UUID NOT NULL,
  used       BOOLEAN NOT NULL DEFAULT false,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_mfa_challenges_expires ON mfa_challenges (expires_at);

CREATE TABLE webauthn_credentials (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  credential_id   BYTEA NOT NULL,
  public_key      BYTEA NOT NULL,
  counter         BIGINT NOT NULL DEFAULT 0,
  transports      TEXT[],
  display_name    TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at    TIMESTAMPTZ,
  CONSTRAINT uq_webauthn_credential_id UNIQUE (credential_id)
);

CREATE INDEX idx_webauthn_account ON webauthn_credentials (account_id);

-- At most one pending registration challenge per account: an UPSERT in
-- the application layer replaces any existing challenge when the user
-- re-requests registration options.
CREATE TABLE webauthn_registration_challenges (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  UUID NOT NULL,
  challenge   TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  CONSTRAINT uq_webauthn_reg_challenge_account UNIQUE (account_id)
);

CREATE INDEX idx_webauthn_reg_challenge_account ON webauthn_registration_challenges (account_id);
CREATE INDEX idx_webauthn_reg_challenge_expires ON webauthn_registration_challenges (expires_at);

-- Authentication challenges are tied to a specific login attempt
-- (jti), not just the account, so concurrent sign-in attempts from
-- different tabs/devices don't overwrite each other's challenges.
CREATE TABLE webauthn_authentication_challenges (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  UUID NOT NULL,
  challenge   TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  jti         UUID NOT NULL,
  CONSTRAINT uq_webauthn_auth_challenge_jti UNIQUE (jti)
);

CREATE INDEX idx_webauthn_auth_challenge_account ON webauthn_authentication_challenges (account_id);
CREATE INDEX idx_webauthn_auth_challenge_expires ON webauthn_authentication_challenges (expires_at);

-- Recovery codes (10 per account, hashed).
CREATE TABLE recovery_codes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  code_hash   TEXT NOT NULL,
  used        BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  used_at     TIMESTAMPTZ
);

CREATE INDEX idx_recovery_codes_account ON recovery_codes (account_id);

-- ── Saved filters (Detection page) ─────────────────────────────────

-- Personal saved filters for the Detection page (#286).
--
-- v1 stores only personal entries — `owner_account_id` references
-- `accounts(id)` and `UNIQUE(owner_account_id, name)` enforces per-user
-- unique names. Tenant/team sharing is out of scope for v1.
--
-- The `mode` column exists so a future search-language phase can
-- insert `mode = 'query'` rows alongside today's `mode = 'structured'`
-- payloads without another migration. v1 server actions only insert
-- `mode = 'structured'`; load paths branch on `mode` and reject unknown
-- modes gracefully. The `filter_json` payload shape depends on `mode`:
-- structured → serialized `EventListFilterInput`; query → `{ text: ... }`.
CREATE TABLE saved_filter (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  mode             TEXT NOT NULL DEFAULT 'structured'
                     CHECK (mode IN ('structured', 'query')),
  filter_json      JSONB NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (owner_account_id, name)
);

CREATE INDEX saved_filter_owner_idx
  ON saved_filter (owner_account_id, updated_at DESC);

-- ── Apply attempts (node bulk-apply lifecycle) ─────────────────────

-- Phase Node-9a (#359): server-side ApplyAttempt table backing the
-- bulk-apply lifecycle / state machine / TTL / recovery surface.
--
-- One row per in-flight or recently-finished apply plan, holding its
-- frozen plan (`planned_dispatches`), the draft fingerprint over the
-- manager-DB draft state at plan-build time, and the lifecycle status
-- + lock + execution-deadline / retention-deadline.
--
-- Per the umbrella (#306, #314): orchestration metadata, NOT a replica
-- of manager-DB drafts. Drafts continue to live in the manager DB and
-- are read fresh on every plan build / pre-dispatch recompute.
--
-- TTL contract (configurable via env, see .env.example):
--   APPLY_ATTEMPT_TTL_MS      - non-terminal execution deadline (default 30 min)
--   APPLY_ATTEMPT_RETENTION_MS - terminal retention (default 7 days)
--   APPLY_EXECUTING_STALE_MS  - stale-lock recovery threshold (default 2.5 hours)
--
-- Audit-once contract (#361): an attempt that reaches `succeeded` must
-- emit `node.apply` exactly once, regardless of how many
-- `confirmApplyAttempt` / `retryDispatch` calls it took (and regardless
-- of concurrent calls racing on the same `attemptId`).
--
--   - `succeeded_audit_emitted_at` is the test-and-set emission slot:
--     the first caller to flip `NULL → NOW()` emits the audit, every
--     other caller observes a non-NULL value and skips emission. It
--     stays NULL for non-`succeeded` terminal states.
--   - `succeeded_audit_completed_at` distinguishes "slot claimed,
--     write pending" from "slot claimed, write confirmed": if the
--     audit DB write fails after the slot was claimed, or the process
--     dies between the slot UPDATE and the audit insert, the cleanup
--     sweep's `recoverPendingNodeApplyAudits` pass finds rows whose
--     claim has been in flight longer than `APPLY_EXECUTING_STALE_MS`,
--     re-emits the audit from the row's persisted metadata, and marks
--     `completed_at`. On a transient audit-DB error during recovery
--     the sweep deliberately leaves the slot CLAIMED (no release) so
--     the next sweep re-picks the same row; releasing would remove the
--     row from every future recovery pass.
--
-- Account-deletion durability (#361 round 8): `audit_actor` snapshots
-- the creator's account id at insert time with NO foreign key, so the
-- recovery sweep keeps an actor for the audit even if the account is
-- deleted. `created_by` is nullable with `ON DELETE SET NULL`, and the
-- BEFORE DELETE trigger below explicitly removes apply_attempts rows
-- that are NOT succeeded-audit-pending so the umbrella's
-- "cascade-delete removes the attempt row" rule still holds for the
-- common case. Surviving rows (`status = 'succeeded'` AND
-- `succeeded_audit_completed_at IS NULL`) end up with
-- `created_by = NULL`, which makes the lifecycle's ownership check
-- reject follow-up confirm/retry as `ApplyAttemptNotFoundError` while
-- the recovery sweep emits `node.apply` using the snapshotted
-- `audit_actor`.
--
-- `customer_id` (#387) persists the attempt's owning customer so both
-- `node.apply` audit emitters can populate `audit_logs.customer_id`
-- without re-reading the manager DB. NULL-able because a
-- globally-scoped caller may create an attempt against a node that
-- carries no `customerId` on either profile — for those rows the audit
-- emission stays `customer_id = NULL` (there is no owning customer to
-- scope against).

CREATE TABLE apply_attempts (
  attempt_id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id                      TEXT NOT NULL,
  draft_fingerprint            BYTEA NOT NULL,
  planned_dispatches           JSONB NOT NULL,
  created_by                   UUID REFERENCES accounts(id) ON DELETE SET NULL,
  created_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at                   TIMESTAMPTZ NOT NULL,
  executing_lock               UUID,
  claim_started_at             TIMESTAMPTZ,
  status                       TEXT NOT NULL
                               CHECK (status IN (
                                 'pending',
                                 'executing',
                                 'succeeded',
                                 'failed_retryable',
                                 'failed_terminal',
                                 'stale',
                                 'expired'
                               )),
  succeeded_audit_emitted_at   TIMESTAMPTZ,
  succeeded_audit_completed_at TIMESTAMPTZ,
  audit_actor                  UUID NOT NULL,
  customer_id                  INTEGER
);

CREATE INDEX apply_attempts_created_by_idx
  ON apply_attempts (created_by);

CREATE INDEX apply_attempts_expires_at_idx
  ON apply_attempts (expires_at);

CREATE INDEX apply_attempts_node_id_status_idx
  ON apply_attempts (node_id, status);

-- Partial index covering only rows currently holding an executing
-- lock. Drives the stale-lock recovery sweep without scanning rows
-- that aren't candidates.
CREATE INDEX apply_attempts_claim_started_at_idx
  ON apply_attempts (claim_started_at)
  WHERE executing_lock IS NOT NULL;

-- Preserve the cascade-delete observable for non-audit-pending rows.
-- Runs BEFORE the `accounts` row is actually deleted, so the explicit
-- DELETE here happens before the FK SET NULL action fires for
-- survivors.
CREATE FUNCTION cascade_apply_attempts_on_account_delete()
  RETURNS TRIGGER
  LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM apply_attempts
  WHERE created_by = OLD.id
    AND NOT (
      status = 'succeeded'
      AND succeeded_audit_completed_at IS NULL
    );
  RETURN OLD;
END;
$$;

CREATE TRIGGER cascade_apply_attempts_on_account_delete
  BEFORE DELETE ON accounts
  FOR EACH ROW
  EXECUTE FUNCTION cascade_apply_attempts_on_account_delete();

-- ── Global triage exclusions ───────────────────────────────────────

-- Global triage exclusions storage (1B-2 / discussion #447 §3.4).
--
-- Lives in `auth_db` because the table is ops-managed and globally
-- scoped; per-tenant exclusions live in each tenant DB (the customer
-- stream's `triage_exclusion`).
--
-- Both tables share the column shape so the shared exclusion helper
-- (`src/lib/triage/exclusion/`) can union them transparently. They
-- differ only in placement and in whether `created_by` references
-- `accounts(id)` directly — only the global table can, because
-- PostgreSQL does not support cross-database FKs.
CREATE TABLE global_triage_exclusion (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Exclusion kind. CHECK-constrained so a typo never silently
    -- disables matching.
    kind          TEXT NOT NULL CHECK (kind IN ('ipAddress', 'hostname', 'uri', 'domain')),
    -- User-supplied value, stored AFTER normalization. Semantics by
    -- kind:
    --   ipAddress: canonical CIDR ('192.168.1.0/24'); single IPs upgraded to /32 or /128
    --   hostname:  lowercased, trailing dot stripped
    --   uri:       byte-for-byte as supplied (exact-match semantics)
    --   domain:    regex pattern, exactly as supplied
    value         TEXT NOT NULL,
    -- Suffix-normalized form for `domain` rows that reduce to a
    -- hostname suffix or exact hostname. NULL when kind is `domain`
    -- but the regex is not suffix-reducible, and NULL when kind is
    -- not `domain`. Populated at INSERT so the retroactive DELETE
    -- planner does not re-run the reducer per ADD.
    domain_suffix TEXT,
    note          TEXT,
    -- ON DELETE RESTRICT: an account whose name is on a live exclusion
    -- cannot be hard-deleted (audit-relevant authorship). Account
    -- soft-deletion still succeeds; the row simply remains attributed.
    created_by    UUID NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Same (kind, value) cannot appear twice. Normalization is applied
    -- before INSERT so a plain UNIQUE on the stored form suffices.
    UNIQUE (kind, value)
);
CREATE INDEX global_triage_exclusion_kind_idx
    ON global_triage_exclusion (kind);

-- ── Triage exclusion fanout queue ──────────────────────────────────

-- Durable fanout queue shared by global triage-exclusion ADDs (1B-2)
-- and customer-scoped drain-failure / admin-recovery resets (#461 /
-- 1B-7).
--
-- A global ADD must apply retroactively across every active
-- customer's tenant DB. Doing this synchronously inside the HTTP
-- request risks request timeouts and partial-success ambiguity, so
-- the request enqueues one job row per active customer here and an
-- internal scheduled route (`POST /api/internal/triage/exclusion/fanout`)
-- claims rows with `FOR UPDATE SKIP LOCKED`, runs the per-customer
-- DELETE under the per-customer advisory lock, and finalizes the row.
--
-- Lives in `auth_db` because the global exclusion FK target is here.
-- Tenant DBs do not need to know about the queue.
--
-- A queue row carries EITHER a global-exclusion id (the global fanout
-- path) OR a customer-only-exclusion id (the customer drain-failure
-- sentinel) — never both, never neither; a CHECK enforces the XOR.
-- The row's "kind" is derived from which column is populated.
--
-- `customer_only_exclusion_id` deliberately has no FK because the
-- referenced tenant `triage_exclusion` row lives in a per-customer DB
-- and PostgreSQL does not support cross-database foreign keys.
-- Existence is enforced at the application layer (see the recover
-- route and the fanout worker's missing-tenant-row branch).
CREATE TABLE triage_exclusion_fanout_job (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- The global exclusion this job is fanning out. ON DELETE CASCADE:
    -- if the global row is removed before its fanout completes, the
    -- pending jobs cascade away (retroactive DELETE is moot).
    global_exclusion_id  UUID
                           REFERENCES global_triage_exclusion(id) ON DELETE CASCADE,
    customer_id          INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    status               TEXT NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending', 'running', 'completed', 'failed')),
    attempt_count        INTEGER NOT NULL DEFAULT 0,
    next_attempt_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Set when a worker claims the row (status -> 'running'). Used by
    -- the stuck-job sweep to return rows whose worker died mid-run.
    claimed_at           TIMESTAMPTZ,
    last_error           TEXT,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    customer_only_exclusion_id UUID,
    CONSTRAINT triage_exclusion_fanout_job_scope_xor_chk
    CHECK (
        (global_exclusion_id IS NOT NULL)::int
        + (customer_only_exclusion_id IS NOT NULL)::int = 1
    )
);
CREATE INDEX triage_exclusion_fanout_job_pending_idx
    ON triage_exclusion_fanout_job (next_attempt_at)
    WHERE status = 'pending';
CREATE INDEX triage_exclusion_fanout_job_running_idx
    ON triage_exclusion_fanout_job (claimed_at)
    WHERE status = 'running';

-- Two partial unique indexes deduplicate per logical scope so
-- reset-in-place recovery (which UPDATEs `status='failed'` rows to
-- `pending` with `attempt_count=0`) cannot race an insert path into
-- producing two rows for the same exclusion+customer pair. Without
-- these, the admin UI would see two "Re-trigger cleanup" entries and
-- `FOR UPDATE SKIP LOCKED` would have ambiguous claim semantics.
-- With the dedupe in place, the sentinel insert and any re-enqueue
-- path can use `ON CONFLICT (...) DO UPDATE SET status='pending', ...`
-- so the dedupe behavior collapses naturally into "reset the existing
-- row".
CREATE UNIQUE INDEX triage_exclusion_fanout_job_global_dedupe
    ON triage_exclusion_fanout_job (global_exclusion_id, customer_id)
    WHERE global_exclusion_id IS NOT NULL;

-- The customer id is always populated; without it a SELECT for "is
-- there a sentinel row for this exclusion" still has to scan, so we
-- still include it in the index even though every customer_only row
-- carries exactly one.
CREATE UNIQUE INDEX triage_exclusion_fanout_job_customer_dedupe
    ON triage_exclusion_fanout_job (customer_only_exclusion_id, customer_id)
    WHERE customer_only_exclusion_id IS NOT NULL;
