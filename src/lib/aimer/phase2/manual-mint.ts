/**
 * Phase 2 manual Send-to-aimer-web mint ledger helpers (#493).
 *
 * Backs the tenant schema's `aimer_phase2_manual_mint` table. Two
 * primitives:
 *
 *  - {@link recordManualMint} — INSERT one row at `build-envelope`
 *    time, carrying the freshly minted `context_jti` + the story id +
 *    the caller account + the `force_refresh` flag.
 *  - {@link consumeManualMintAndBumpBeta} — at `ack-manual` time, a
 *    single tenant-DB transaction that (a) SELECTs the matching row
 *    FOR UPDATE (rejects already-consumed / missing rows with a
 *    structured `replay_or_unknown_jti` error), (b) UPDATEs
 *    `consumed_at = NOW()` on the ledger row, and (c) bumps the
 *    `event_group` β columns. Audit emission for `triage.story.send`
 *    happens immediately after the commit in the route — the audit
 *    DB lives in a separate database and cannot be co-committed.
 */

import "server-only";

import { getCustomerPool } from "@/lib/triage/policy/customer-db";

/**
 * Insert a manual-mint ledger row. Called by the `build-envelope`
 * route immediately after `buildPhase2Push` returns. Idempotent on
 * `context_jti` conflict (the JTI is single-use; a conflict would
 * mean a duplicate mint, which would also be rejected by aimer-web's
 * jti-replay guard).
 */
export async function recordManualMint(
  customerId: number,
  input: {
    contextJti: string;
    storyId: string;
    accountId: string;
    forceRefresh: boolean;
  },
): Promise<void> {
  const pool = await getCustomerPool(customerId);
  await pool.query(
    `INSERT INTO aimer_phase2_manual_mint
       (context_jti, story_id, account_id, force_refresh)
     VALUES ($1, $2::numeric, $3::uuid, $4)
     ON CONFLICT (context_jti) DO NOTHING`,
    [input.contextJti, input.storyId, input.accountId, input.forceRefresh],
  );
}

export interface ConsumeManualMintResult {
  /** β snapshot post-bump — `event_group.last_sent_at`. */
  lastSentAtIso: string;
  /** β snapshot post-bump — `event_group.send_count`. */
  sendCount: number;
  /** Read from the ledger row, not the request body. */
  forceRefresh: boolean;
  /** Read from the bumped `event_group` row for the audit payload. */
  storyVersion: string;
}

/**
 * Custom error class so the `ack-manual` route can map specific
 * causes to specific status codes without conflating "missing row"
 * (forgery / replay) with "story does not exist" (404).
 */
export class ManualMintConsumeError extends Error {
  readonly code: "replay_or_unknown_jti" | "story_not_found";

  constructor(code: ManualMintConsumeError["code"], message: string) {
    super(message);
    this.name = "ManualMintConsumeError";
    this.code = code;
  }
}

/**
 * Consume the ledger row + bump the `event_group` β columns in one
 * tenant-DB transaction. Throws {@link ManualMintConsumeError} on
 * replay / unknown jti / story-not-found.
 *
 * Field-by-field guards on the SELECT:
 *
 *  - `context_jti = $jti` — the JTI threaded through the browser.
 *  - `story_id = $storyId` — the focused Story; a tampered body that
 *    asks `ack-manual` to commit a different Story is rejected.
 *  - `account_id = $accountId` — the caller session. A different
 *    account using a stolen / shared JTI is rejected.
 *  - `consumed_at IS NULL` — replay guard.
 *
 * Any of these failing → `replay_or_unknown_jti` (kept as a single
 * code so a probe cannot distinguish "wrong story id" from "wrong
 * account" from "already consumed" via response inspection — all
 * four are equally suspicious).
 */
export async function consumeManualMintAndBumpBeta(
  customerId: number,
  input: {
    contextJti: string;
    storyId: string;
    accountId: string;
  },
): Promise<ConsumeManualMintResult> {
  const pool = await getCustomerPool(customerId);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: ledger } = await client.query<{
      force_refresh: boolean;
    }>(
      `SELECT force_refresh
         FROM aimer_phase2_manual_mint
        WHERE context_jti = $1
          AND story_id    = $2::numeric
          AND account_id  = $3::uuid
          AND consumed_at IS NULL
        FOR UPDATE`,
      [input.contextJti, input.storyId, input.accountId],
    );
    if (ledger.length === 0) {
      await client.query("ROLLBACK");
      throw new ManualMintConsumeError(
        "replay_or_unknown_jti",
        "manual-mint ledger row missing or already consumed",
      );
    }
    const forceRefresh = ledger[0].force_refresh;

    await client.query(
      `UPDATE aimer_phase2_manual_mint
          SET consumed_at = NOW()
        WHERE context_jti = $1`,
      [input.contextJti],
    );

    const { rows: bumped } = await client.query<{
      last_sent_at_iso: string;
      send_count: number;
      story_version: string;
    }>(
      `UPDATE event_group
          SET last_sent_at = NOW(),
              last_sent_by = $2::uuid,
              send_count   = send_count + 1
        WHERE id = $1::numeric
       RETURNING to_char(last_sent_at AT TIME ZONE 'UTC',
                         'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS last_sent_at_iso,
                 send_count,
                 story_version`,
      [input.storyId, input.accountId],
    );
    if (bumped.length === 0) {
      // The story row vanished between `build-envelope` and
      // `ack-manual` (extremely unlikely — would require a manual
      // DELETE between the two calls). Reject so the analyst gets a
      // clean error rather than a silent no-op.
      await client.query("ROLLBACK");
      throw new ManualMintConsumeError(
        "story_not_found",
        `event_group ${input.storyId} not found`,
      );
    }

    await client.query("COMMIT");
    return {
      lastSentAtIso: bumped[0].last_sent_at_iso,
      sendCount: bumped[0].send_count,
      forceRefresh,
      storyVersion: bumped[0].story_version,
    };
  } catch (err) {
    if (!(err instanceof ManualMintConsumeError)) {
      await client.query("ROLLBACK").catch(() => {});
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Cheap existence check used by `ack-manual` to confirm the focused
 * Story belongs to this tenant *before* attempting the consume.
 * Wraps `story_not_found` 404 separately from the JTI replay guard
 * so a `triage:read` user for tenant A cannot probe tenant B's
 * story ids by sending a forged JTI for a different customer.
 */
export async function storyExistsForCustomer(
  customerId: number,
  storyId: string,
): Promise<boolean> {
  const pool = await getCustomerPool(customerId);
  const { rows } = await pool.query<{ id: string }>(
    "SELECT id::text AS id FROM event_group WHERE id = $1::numeric LIMIT 1",
    [storyId],
  );
  return rows.length > 0;
}
