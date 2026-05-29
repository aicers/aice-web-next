-- Phase 2 push cadence consent flag (#651).
--
-- The browser-side opportunistic-push cadence (`createPeriodicDrain`,
-- 5-minute interval) is centralized to the dashboard app shell so it
-- runs "while signed in" rather than only while a Triage screen is
-- mounted. Per RFC 0002 Phase 2 the cadence is opt-in: it only starts
-- for a customer once an operator has consented on the Settings page.
--
-- The consent lives on `aimer_push_state`, which is per-customer-DB
-- scoped (no `customer_id` column — the database itself is the scope)
-- and keyed per streaming `kind`. There is one logical per-customer
-- toggle; it is stored on BOTH the `baseline_event` and `story` rows
-- and the Settings toggle updates both in one statement. Default off
-- (opt-in) so an unmigrated/never-consented tenant never auto-forwards.
--
-- This flag is orthogonal to `opportunistic_enabled`:
--   - `opportunistic_enabled` (default TRUE) — is this kind drainable at
--     all. The actual route-level pause gate; "Sync now" honors it.
--   - `cadence_enabled` (default FALSE) — does the client-side auto-timer
--     start for this customer. Does NOT gate manual "Sync now".
--
-- `policy_event` is intentionally not represented here: it is queue-only
-- (no `aimer_push_state` row, no cursor), so there is nothing for a
-- cadence to advance. Manual "Sync now" still drains it.
--
-- Idempotent: `ADD COLUMN IF NOT EXISTS`. Re-application against an
-- already-migrated DB is a no-op (the existing values are preserved).

ALTER TABLE aimer_push_state
  ADD COLUMN IF NOT EXISTS cadence_enabled BOOLEAN NOT NULL DEFAULT FALSE;
