-- Manual Send-to-aimer-web mint ledger (sub-issue #493).
--
-- The manual Send path mints a single-Story Phase 2 envelope server-
-- side via `POST /api/aimer/phase2/story/build-envelope`, hands the
-- multipart tokens to the browser, and waits for the browser's
-- `POST /api/aimer/phase2/story/ack-manual` call (which fires after
-- aimer-web returns 2xx). The browser cannot mutate the tenant DB
-- directly, so this ledger backs the replay/forgery guard on
-- `ack-manual`: each `build-envelope` INSERTs one row keyed on the
-- minted `context_jti`, and `ack-manual` SELECTs ... FOR UPDATE on
-- the same JTI before consuming it + bumping the `event_group` β
-- columns in the same tenant-DB transaction.
--
-- The ledger lives in the tenant DB so the consume-and-bump pair is
-- atomic. Customer scope is implicit in the DB (no `customer_id`
-- column).
--
-- Idempotent (`IF NOT EXISTS` on table + index) so a second
-- application against an already-migrated DB is a no-op.

CREATE TABLE IF NOT EXISTS aimer_phase2_manual_mint (
    context_jti   TEXT             PRIMARY KEY,
    story_id      NUMERIC(39, 0)   NOT NULL,
    -- `accounts.id` lives in the auth DB; cross-DB so no FK. App-level
    -- integrity is enough — the consume side checks `account_id` ==
    -- the calling session's account.
    account_id    UUID             NOT NULL,
    force_refresh BOOLEAN          NOT NULL,
    minted_at     TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
    -- NULL until the matching `ack-manual` call commits. The
    -- replay/forgery guard rejects a SELECT that finds `consumed_at IS
    -- NOT NULL` with 409 `replay_or_unknown_jti`.
    consumed_at   TIMESTAMPTZ
);

-- Sweep helper: the retention job reaps rows older than 24h (consumed
-- or not), so an index on `minted_at` keeps the sweep cheap. Matches
-- the pattern used by #609's `aimer_push_queue` retention.
CREATE INDEX IF NOT EXISTS aimer_phase2_manual_mint_minted_at_idx
    ON aimer_phase2_manual_mint (minted_at);
