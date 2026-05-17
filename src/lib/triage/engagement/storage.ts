import "server-only";

import type pg from "pg";

import { ENGAGEMENT_TUNABLES } from "../baseline/engagement-tunables";
import { getCustomerPool } from "../policy/customer-db";
import {
  hmacAssetKey,
  hmacCountry,
  hmacDomain,
  hmacFingerprint,
  hmacIp,
  hmacNormalized,
} from "./hmac";
import { ensureEngagementModelSnapshot } from "./snapshot";
import type {
  EngagementAction,
  EngagementImpressionBatch,
  EngagementPivotDimension,
} from "./types";

/**
 * Insert one menu-load's worth of impression rows. Idempotent per the
 * schema-level UNIQUE constraint on `(menu_load_id, event_key)` — a
 * replay of the same batch is a no-op.
 *
 * Returns the number of rows actually written (zero on a replay).
 *
 * Implementation note: a single multi-row `INSERT ... VALUES (...)`
 * batched as one statement avoids the round-trip cost of one-row
 * inserts. The impression batch is bounded by the same caps the menu
 * itself applies (`TRIAGE_HARD_EVENT_CAP + STORY_PROTECTED_HARD_CAP`
 * = 7,000 rows worst case), so a single statement is acceptable.
 */
export async function recordImpressions(
  accountIdHmac: string,
  batch: EngagementImpressionBatch,
): Promise<number> {
  if (batch.impressions.length === 0) return 0;
  const pool = await getCustomerPool(batch.customerId);
  // RFC 0003 §8.2: the snapshot row keyed on the active
  // `engagement_model_version` must exist before any impression
  // references it. The helper is idempotent (`ON CONFLICT DO NOTHING`)
  // and per-pool cached so the cost is paid once per pool per process.
  await ensureEngagementModelSnapshot(pool);
  return insertImpressions(pool, accountIdHmac, batch);
}

async function insertImpressions(
  pool: pg.Pool,
  accountIdHmac: string,
  batch: EngagementImpressionBatch,
): Promise<number> {
  // The shared columns (`menu_load_id`, `surface`,
  // `engagement_model_version`, …) are bound once and reused by
  // every row's placeholder tuple. Per-row columns (`event_key`,
  // `kind`, `slot_bucket`, `rank`, `baseline_version`, `shown_by`)
  // consume six placeholders each.
  //
  // RFC 0003 §8.3: `engagement_model_version` is resolved server-
  // side from the tunables module rather than carried on the wire.
  // The client is not authoritative for the model version that was
  // in effect at projection time — keeping the resolution server-
  // side means a stale client cannot falsify the audit record.
  const SHARED_COUNT = 8;
  const PER_ROW = 6;
  const sharedValues: unknown[] = [
    batch.menuLoadId,
    batch.surface,
    batch.periodStartIso,
    batch.periodEndIso,
    batch.strictnessStop,
    batch.customerId,
    accountIdHmac,
    ENGAGEMENT_TUNABLES.engagementModelVersion,
  ];
  const placeholders: string[] = [];
  const perRowValues: unknown[] = [];
  for (let i = 0; i < batch.impressions.length; i++) {
    const row = batch.impressions[i];
    const base = SHARED_COUNT + i * PER_ROW;
    placeholders.push(
      `($1, $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $2, $${base + 5}, $3, $4, $${base + 6}, $5, $6, $7, $8)`,
    );
    perRowValues.push(
      row.eventKey,
      row.kind,
      row.slotBucket,
      row.rank,
      row.baselineVersion,
      row.shownBy,
    );
  }
  const sql = `INSERT INTO engagement_impression (
        menu_load_id,
        event_key,
        kind,
        slot_bucket,
        rank,
        surface,
        baseline_version,
        period_start_ts,
        period_end_ts,
        shown_by,
        strictness_stop,
        customer_id,
        account_id_hmac,
        engagement_model_version
    ) VALUES ${placeholders.join(", ")}
    ON CONFLICT (menu_load_id, event_key) DO NOTHING`;
  const result = await pool.query(sql, [...sharedValues, ...perRowValues]);
  return result.rowCount ?? 0;
}

/**
 * Insert one engagement-action row. Sparse table — one row per
 * action.
 */
export async function recordAction(
  accountIdHmac: string,
  action: EngagementAction,
): Promise<void> {
  const pool = await getCustomerPool(action.customerId);
  await insertAction(pool, accountIdHmac, action);
}

/**
 * Pick the right normalizer + HMAC for the pivot dimension. The
 * dimension labels mirror the {@link PivotDimensionId} ids that the
 * Triage pivot panel emits at click time (`src/lib/triage/pivot/dimensions.ts`).
 * Keeping the switch keyed to those exact ids — rather than ad-hoc
 * column names — is what makes the dimension-specific normalizers
 * actually run: an IPv4 leading-zero form, an IPv6 non-canonical
 * spelling, a punycode-vs-Unicode SNI, an uppercase JA3, etc. all
 * collapse to the same HMAC join key. Falling back to
 * {@link hmacNormalized} for an unknown id is intentional so a future
 * pivot dimension (e.g. a new structured field) does not error out
 * at write time, but the typed normalizers should cover every
 * value-bearing dimension the panel actually fires.
 */
function hmacForDimension(
  dimension: EngagementPivotDimension,
  rawValue: string,
): string {
  switch (dimension) {
    case "externalIp":
    case "internalIp":
    case "dnsAnswer":
      return hmacIp(rawValue);
    case "host":
    case "registrableDomain":
    case "dnsQuery":
    case "sni":
      return hmacDomain(rawValue);
    case "ja3":
    case "ja3s":
    case "sshHassh":
    case "sshHasshServer":
    case "sshClient":
    case "sshServer":
      return hmacFingerprint(rawValue);
    case "country":
      return hmacCountry(rawValue);
    default:
      return hmacNormalized(rawValue.trim());
  }
}

async function insertAction(
  pool: pg.Pool,
  accountIdHmac: string,
  action: EngagementAction,
): Promise<void> {
  const cols = {
    action_type: action.type,
    event_key: null as string | null,
    kind: null as string | null,
    baseline_version: null as string | null,
    customer_id: action.customerId,
    account_id_hmac: accountIdHmac,
    surface: action.surface,
    asset_key_hmac: null as string | null,
    dimension: null as string | null,
    pivot_value_join_id: null as string | null,
    pivot_value_hmac: null as string | null,
    story_id: null as string | null,
    exclusion_id: null as string | null,
    strictness_from: null as string | null,
    strictness_to: null as string | null,
    // RFC 0003 §2.2: row-bound action types (`pivot_click`,
    // `story_pivot_click`) carry `menu_load_id` so the §7 aggregate
    // can JOIN back to the impression's `slot_bucket`. Non-row-bound
    // types leave it NULL (the schema CHECK enforces this).
    menu_load_id: null as string | null,
  };
  switch (action.type) {
    case "asset_select":
      cols.asset_key_hmac = hmacAssetKey(action.assetAddress);
      break;
    case "pivot_click":
      cols.event_key = action.eventKey;
      cols.kind = action.kind;
      cols.baseline_version = action.baselineVersion;
      cols.dimension = action.dimension;
      cols.pivot_value_join_id = action.pivotValueJoinId ?? null;
      cols.pivot_value_hmac =
        action.pivotValue !== undefined
          ? hmacForDimension(action.dimension, action.pivotValue)
          : null;
      cols.menu_load_id = action.menuLoadId;
      break;
    case "story_pivot_click":
      cols.event_key = action.eventKey;
      cols.kind = action.kind;
      cols.baseline_version = action.baselineVersion;
      cols.dimension = action.dimension;
      cols.pivot_value_join_id = action.pivotValueJoinId ?? null;
      cols.pivot_value_hmac =
        action.pivotValue !== undefined
          ? hmacForDimension(action.dimension, action.pivotValue)
          : null;
      cols.story_id = action.storyId;
      cols.menu_load_id = action.menuLoadId;
      break;
    case "exclusion_create":
      cols.exclusion_id = action.exclusionId;
      break;
    case "strictness_change":
      cols.strictness_from = action.strictnessFrom;
      cols.strictness_to = action.strictnessTo;
      break;
  }
  await pool.query(
    `INSERT INTO engagement_action (
        action_type,
        event_key,
        kind,
        baseline_version,
        customer_id,
        account_id_hmac,
        surface,
        asset_key_hmac,
        dimension,
        pivot_value_join_id,
        pivot_value_hmac,
        story_id,
        exclusion_id,
        strictness_from,
        strictness_to,
        menu_load_id
     ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16
     )`,
    [
      cols.action_type,
      cols.event_key,
      cols.kind,
      cols.baseline_version,
      cols.customer_id,
      cols.account_id_hmac,
      cols.surface,
      cols.asset_key_hmac,
      cols.dimension,
      cols.pivot_value_join_id,
      cols.pivot_value_hmac,
      cols.story_id,
      cols.exclusion_id,
      cols.strictness_from,
      cols.strictness_to,
      cols.menu_load_id,
    ],
  );
}
