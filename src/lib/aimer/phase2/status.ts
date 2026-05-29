/**
 * Phase 2 Settings status helpers (#620).
 *
 * Builds the response DTOs used by:
 *   - `GET /api/aimer/phase2/status?customer_id=<id>` — per-customer
 *     three-track block surfaced in the Settings status indicator.
 *   - `GET /api/aimer/phase2/status/summary` — cross-customer aggregate
 *     consumed by the app-shell login banner.
 *
 * Three display tracks per customer (RFC 0002 §8 + issue #620):
 *
 *   - **Streaming kinds** (`baseline_event`, `story`) — cursor-backed,
 *     have a pause toggle, full {@link BacklogEstimate} including
 *     `cursor_lag_seconds` + `last_error` + pending count.
 *   - **Manual-only kind** (`policy_run`) — no cursor, no pause; surfaces
 *     "last sent run" + "total runs sent" sourced from
 *     `policy_triage_run` β columns (`last_sent_at`, `last_sent_by`,
 *     `send_count`). `totalRunsSent` is COUNT(*) WHERE last_sent_at IS
 *     NOT NULL — NOT SUM(send_count): the finalize route increments
 *     `send_count` per Send action including re-sends of the same run,
 *     so summing it would over-count.
 *   - **Queue-only kind** (`policy_event`) — no cursor, no pause;
 *     surfaces pending unack'd `withdraw_policy_event` count + the most
 *     recent unack'd row's `last_error` (queried straight from the
 *     queue row, since `aimer_push_state` has no row for `policy_event`).
 *
 * Neither endpoint ever surfaces queue payload bodies — only counts,
 * errors, and bucket labels.
 */

import "server-only";

import {
  type AimerPushStateRow,
  type BacklogEstimate,
  estimateBacklog,
  getAimerPushState,
  getCadenceEnabled,
  type Phase2StreamingKind,
} from "@/lib/aimer/phase2/state";
import { query } from "@/lib/db/client";
import { getCustomerPool } from "@/lib/triage/policy/customer-db";

// ── Per-customer DTO ──────────────────────────────────────────────

/**
 * Per-drain breakdown of pending notices by notice subkind. Surfaced as
 * separate badges in the Settings status block so an operator can tell
 * an `withdraw_*` backlog (a real ingest gap) apart from a
 * `refresh_*` / `backfill_*` backlog (operator-driven catch-up work).
 *
 * Streaming kinds have all three subkinds; `policy_event` only ever
 * sees `withdraw_policy_event`, so its DTO carries only `withdraw`.
 */
export interface StreamingPendingBreakdown {
  withdraw: number;
  refresh: number;
  backfill: number;
}

export interface Phase2StreamingTrackDto {
  kind: Phase2StreamingKind;
  bucket: BacklogEstimate["bucket"];
  approximate_count: number | null;
  cursor_lag_seconds: number | null;
  last_synced_at: string | null;
  last_error: string | null;
  pending_notice_count: number;
  pending_oldest_enqueued_at: string | null;
  pending_breakdown: StreamingPendingBreakdown;
  opportunistic_enabled: boolean;
  paused_at: string | null;
  /**
   * Display label for the operator who paused this kind. The customer
   * DB stores only the actor's account UUID (cross-DB, so no FK). The
   * status builder resolves that UUID against `accounts.display_name`
   * in the app DB and falls back to the raw UUID only when the account
   * row is gone (deleted operator). `null` when the kind is unpaused.
   */
  paused_by: string | null;
  /**
   * Per-customer cadence consent (#651). Both streaming rows carry the
   * same value (the Settings toggle writes them together), so the
   * Settings UI renders one toggle reflecting either row. `true` means
   * the app-shell cadence manager auto-forwards this customer every
   * 5 minutes while an operator is signed in.
   */
  cadence_enabled: boolean;
}

export interface Phase2PolicyRunTrackDto {
  kind: "policy_run";
  last_sent_run_id: string | null;
  last_sent_at: string | null;
  last_sent_by: string | null;
  total_runs_sent: number;
}

export interface Phase2PolicyEventTrackDto {
  kind: "policy_event";
  pending_notice_count: number;
  pending_oldest_enqueued_at: string | null;
  last_error: string | null;
}

export interface Phase2StatusDto {
  customer_id: number;
  streaming: readonly Phase2StreamingTrackDto[];
  policy_run: Phase2PolicyRunTrackDto;
  policy_event: Phase2PolicyEventTrackDto;
}

// ── Summary DTO (login banner) ────────────────────────────────────

export type Phase2SummaryBucket = "behind" | "way_behind" | "paused";

export interface Phase2SummaryCustomerEntry {
  customer_id: number;
  /** Worst bucket across this customer's contributing kinds. */
  worst_bucket: Phase2SummaryBucket;
  /** Kinds that contributed to this entry. */
  kinds: readonly ("baseline_event" | "story" | "policy_event")[];
  /**
   * Subset of `kinds` whose individual bucket is `paused`. Surfaced
   * separately because `worst_bucket` aggregates with severity ranking
   * (paused < behind < way_behind), so a customer whose baseline is
   * paused AND whose policy_event is way_behind reports `worst_bucket:
   * "way_behind"`. Without `paused_kinds` the login banner would lose
   * the pause signal entirely in mixed-state customers.
   */
  paused_kinds: readonly ("baseline_event" | "story")[];
}

export interface Phase2SummaryDto {
  customers: readonly Phase2SummaryCustomerEntry[];
}

// ── Builders ──────────────────────────────────────────────────────

/**
 * Build the per-customer status DTO. Issues one parallel batch of DB
 * reads:
 *   - `estimateBacklog` × 3 (baseline_event, story, policy_event).
 *   - `getAimerPushState` × 2 (baseline_event, story).
 *   - `policy_triage_run` aggregate.
 *   - latest unack'd `withdraw_policy_event` row.
 */
export async function buildPhase2StatusDto(
  customerId: number,
): Promise<Phase2StatusDto> {
  const [
    baselineEstimate,
    storyEstimate,
    policyEventEstimate,
    baselineState,
    storyState,
    policyRun,
    policyEventLastError,
    pendingDetails,
  ] = await Promise.all([
    estimateBacklog(customerId, "baseline_event"),
    estimateBacklog(customerId, "story"),
    estimateBacklog(customerId, "policy_event"),
    getAimerPushState(customerId, "baseline_event"),
    getAimerPushState(customerId, "story"),
    loadPolicyRunSummary(customerId),
    loadLatestPolicyEventError(customerId),
    loadPendingNoticeDetails(customerId),
  ]);

  // Resolve `paused_by` UUIDs from the per-customer DB against the
  // app-DB `accounts` table in one batched lookup. The UUIDs themselves
  // are not useful to an operator scanning the Settings page — the
  // parent spec asks for "paused 5 min ago by alice"-style copy.
  const pausedByIds = [baselineState?.paused_by, storyState?.paused_by].filter(
    (id): id is string => typeof id === "string" && id.length > 0,
  );
  const displayNames = await resolveAccountDisplayNames(pausedByIds);

  return {
    customer_id: customerId,
    streaming: [
      toStreamingTrackDto(
        "baseline_event",
        baselineEstimate,
        baselineState,
        pendingDetails.baseline_event,
        displayNames,
      ),
      toStreamingTrackDto(
        "story",
        storyEstimate,
        storyState,
        pendingDetails.story,
        displayNames,
      ),
    ],
    policy_run: {
      kind: "policy_run",
      last_sent_run_id: policyRun.lastSentRunId,
      last_sent_at: policyRun.lastSentAt,
      last_sent_by: policyRun.lastSentBy,
      total_runs_sent: policyRun.totalRunsSent,
    },
    policy_event: {
      kind: "policy_event",
      pending_notice_count: policyEventEstimate.pending_notice_count,
      pending_oldest_enqueued_at: pendingDetails.policy_event.oldestEnqueuedAt,
      last_error: policyEventLastError,
    },
  };
}

function toStreamingTrackDto(
  kind: Phase2StreamingKind,
  estimate: BacklogEstimate,
  state: AimerPushStateRow | null,
  pending: StreamingPendingDetail,
  displayNames: ReadonlyMap<string, string>,
): Phase2StreamingTrackDto {
  // Prefer the resolved display name; fall back to the raw UUID only
  // when the account row has been deleted so the operator at least
  // sees the audit-trail identifier instead of a blank.
  const pausedBy = state?.paused_by ?? null;
  const pausedByLabel =
    pausedBy === null ? null : (displayNames.get(pausedBy) ?? pausedBy);
  return {
    kind,
    bucket: estimate.bucket,
    approximate_count: estimate.approximate_count,
    cursor_lag_seconds: estimate.cursor_lag_seconds,
    last_synced_at: state?.last_synced_at?.toISOString() ?? null,
    last_error: state?.last_error ?? null,
    pending_notice_count: estimate.pending_notice_count,
    pending_oldest_enqueued_at: pending.oldestEnqueuedAt,
    pending_breakdown: {
      withdraw: pending.withdraw,
      refresh: pending.refresh,
      backfill: pending.backfill,
    },
    opportunistic_enabled: state?.opportunistic_enabled ?? true,
    paused_at: state?.paused_at?.toISOString() ?? null,
    paused_by: pausedByLabel,
    cadence_enabled: state?.cadence_enabled ?? false,
  };
}

/**
 * Look up `accounts.display_name` for each given account UUID. Returns
 * a map keyed by UUID; missing rows are simply absent (the caller
 * decides whether to fall back to the UUID). Fails soft to an empty
 * map so a transient app-DB hiccup does not 500 the status route.
 */
async function resolveAccountDisplayNames(
  accountIds: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const out = new Map<string, string>();
  if (accountIds.length === 0) return out;
  const uniq = Array.from(new Set(accountIds));
  try {
    const { rows } = await query<{ id: string; display_name: string }>(
      `SELECT id::text AS id, display_name
         FROM accounts
        WHERE id = ANY($1::uuid[])`,
      [uniq],
    );
    for (const row of rows) out.set(row.id, row.display_name);
  } catch {
    // swallow — see jsdoc; UUID fallback keeps the page usable.
  }
  return out;
}

interface StreamingPendingDetail {
  withdraw: number;
  refresh: number;
  backfill: number;
  oldestEnqueuedAt: string | null;
}

interface PolicyEventPendingDetail {
  oldestEnqueuedAt: string | null;
}

interface PendingNoticeDetails {
  baseline_event: StreamingPendingDetail;
  story: StreamingPendingDetail;
  policy_event: PolicyEventPendingDetail;
}

/**
 * Read pending-notice counts + oldest-enqueued timestamps per
 * `aimer_push_queue.kind` so the Settings UI can render an "oldest N
 * old" hint and a per-subkind badge (withdraw vs refresh vs backfill).
 * Fails soft to zeros so the rest of the status block still renders if
 * the per-tenant DB hiccups.
 */
async function loadPendingNoticeDetails(
  customerId: number,
): Promise<PendingNoticeDetails> {
  const empty: PendingNoticeDetails = {
    baseline_event: {
      withdraw: 0,
      refresh: 0,
      backfill: 0,
      oldestEnqueuedAt: null,
    },
    story: {
      withdraw: 0,
      refresh: 0,
      backfill: 0,
      oldestEnqueuedAt: null,
    },
    policy_event: { oldestEnqueuedAt: null },
  };
  try {
    const pool = await getCustomerPool(customerId);
    const { rows } = await pool.query<{
      kind: string;
      count: string;
      oldest: Date | null;
    }>(
      `SELECT kind,
              COUNT(*)::text AS count,
              MIN(enqueued_at) AS oldest
         FROM aimer_push_queue
        WHERE acked_at IS NULL
        GROUP BY kind`,
    );
    const out = empty;
    let baselineOldest: Date | null = null;
    let storyOldest: Date | null = null;
    for (const r of rows) {
      const n = Number(r.count);
      if (r.kind === "withdraw_baseline_event") {
        out.baseline_event.withdraw = n;
        baselineOldest = minDate(baselineOldest, r.oldest);
      } else if (r.kind === "refresh_baseline_window") {
        out.baseline_event.refresh = n;
        baselineOldest = minDate(baselineOldest, r.oldest);
      } else if (r.kind === "backfill_baseline_window") {
        out.baseline_event.backfill = n;
        baselineOldest = minDate(baselineOldest, r.oldest);
      } else if (r.kind === "withdraw_story") {
        out.story.withdraw = n;
        storyOldest = minDate(storyOldest, r.oldest);
      } else if (r.kind === "refresh_story_window") {
        out.story.refresh = n;
        storyOldest = minDate(storyOldest, r.oldest);
      } else if (r.kind === "backfill_story_window") {
        out.story.backfill = n;
        storyOldest = minDate(storyOldest, r.oldest);
      } else if (r.kind === "withdraw_policy_event") {
        out.policy_event.oldestEnqueuedAt = r.oldest?.toISOString() ?? null;
      }
    }
    out.baseline_event.oldestEnqueuedAt = baselineOldest?.toISOString() ?? null;
    out.story.oldestEnqueuedAt = storyOldest?.toISOString() ?? null;
    return out;
  } catch {
    return empty;
  }
}

function minDate(a: Date | null, b: Date | null): Date | null {
  if (a === null) return b;
  if (b === null) return a;
  return a.getTime() <= b.getTime() ? a : b;
}

interface PolicyRunSummary {
  lastSentRunId: string | null;
  lastSentAt: string | null;
  lastSentBy: string | null;
  totalRunsSent: number;
}

async function loadPolicyRunSummary(
  customerId: number,
): Promise<PolicyRunSummary> {
  try {
    const pool = await getCustomerPool(customerId);
    const [{ rows: latest }, { rows: total }] = await Promise.all([
      pool.query<{
        id: string;
        last_sent_at: Date | null;
        last_sent_by: string | null;
      }>(
        `SELECT id::text AS id,
                last_sent_at,
                last_sent_by::text AS last_sent_by
           FROM policy_triage_run
          WHERE last_sent_at IS NOT NULL
          ORDER BY last_sent_at DESC
          LIMIT 1`,
      ),
      pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM policy_triage_run
          WHERE last_sent_at IS NOT NULL`,
      ),
    ]);
    const row = latest[0];
    return {
      lastSentRunId: row?.id ?? null,
      lastSentAt: row?.last_sent_at?.toISOString() ?? null,
      lastSentBy: row?.last_sent_by ?? null,
      totalRunsSent: Number(total[0]?.count ?? "0"),
    };
  } catch {
    // Either the migration hasn't applied yet on a fresh tenant, or a
    // planner timeout — the Settings indicator should still render the
    // bucket label / pending counts for the other tracks instead of
    // 500-ing the whole route.
    return {
      lastSentRunId: null,
      lastSentAt: null,
      lastSentBy: null,
      totalRunsSent: 0,
    };
  }
}

async function loadLatestPolicyEventError(
  customerId: number,
): Promise<string | null> {
  try {
    const pool = await getCustomerPool(customerId);
    // Surface the newest unack'd row's `last_error` as-is — even when
    // it is NULL. Filtering on `last_error IS NOT NULL` would otherwise
    // resurrect a stale error from an older notice after the current
    // most-recent pending notice has cleared its own error.
    const { rows } = await pool.query<{ last_error: string | null }>(
      `SELECT last_error
         FROM aimer_push_queue
        WHERE kind = 'withdraw_policy_event'
          AND acked_at IS NULL
        ORDER BY id DESC
        LIMIT 1`,
    );
    return rows[0]?.last_error ?? null;
  } catch {
    return null;
  }
}

// ── Summary builder ───────────────────────────────────────────────

/**
 * Build the cross-customer aggregate for the app-shell login banner.
 *
 * Per-customer work is bounded:
 *   - Skips the `approximate_count` fast-path (the banner only needs
 *     the bucket label, not the count).
 *   - Reads `aimer_push_state` + `aimer_push_queue` counts directly
 *     instead of computing the full {@link BacklogEstimate} shape.
 *
 * Concurrency is bounded by {@link SUMMARY_PER_CUSTOMER_CONCURRENCY} so
 * a long tenant list does not fan out into one DB connection per
 * customer simultaneously. Results are memoised in a process-local TTL
 * cache keyed on the sorted customer-id list — a busy app shell on
 * many tabs collapses to one query per TTL window.
 */
export async function buildPhase2StatusSummary(
  customerIds: readonly number[],
): Promise<Phase2SummaryDto> {
  if (customerIds.length === 0) return { customers: [] };
  const sortedIds = [...customerIds].sort((a, b) => a - b);
  const cacheKey = sortedIds.join(",");
  const cached = summaryCache.get(cacheKey);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }
  // Inflight de-dup so concurrent requests for the same key share one
  // round of DB work even before the TTL row lands in the cache.
  const inflight = summaryInflight.get(cacheKey);
  if (inflight) return inflight;
  const promise = (async () => {
    try {
      const entries = await mapWithConcurrency(
        sortedIds,
        SUMMARY_PER_CUSTOMER_CONCURRENCY,
        summarizeCustomer,
      );
      const customers = entries.filter(
        (e): e is Phase2SummaryCustomerEntry => e !== null,
      );
      const value: Phase2SummaryDto = { customers };
      summaryCache.set(cacheKey, { value, expiresAt: now + SUMMARY_TTL_MS });
      return value;
    } finally {
      summaryInflight.delete(cacheKey);
    }
  })();
  summaryInflight.set(cacheKey, promise);
  return promise;
}

/**
 * Process-local TTL cache. 15s sits inside the visibility-hidden→back
 * window most operators experience (sub-second) yet absorbs fan-out
 * from multiple tabs on a single page refresh.
 */
const SUMMARY_TTL_MS = 15_000;
const SUMMARY_PER_CUSTOMER_CONCURRENCY = 4;

interface SummaryCacheEntry {
  value: Phase2SummaryDto;
  expiresAt: number;
}

const summaryCache = new Map<string, SummaryCacheEntry>();
const summaryInflight = new Map<string, Promise<Phase2SummaryDto>>();

/**
 * Reset the summary cache. Exposed for tests so an assertion does not
 * have to wait out the TTL between cases.
 */
export function __resetPhase2SummaryCacheForTests(): void {
  summaryCache.clear();
  summaryInflight.clear();
}

const BUCKET_SEVERITY: Record<Phase2SummaryBucket, number> = {
  paused: 1,
  behind: 2,
  way_behind: 3,
};

function worseBucket(
  a: Phase2SummaryBucket,
  b: Phase2SummaryBucket,
): Phase2SummaryBucket {
  return BUCKET_SEVERITY[a] >= BUCKET_SEVERITY[b] ? a : b;
}

async function summarizeCustomer(
  customerId: number,
): Promise<Phase2SummaryCustomerEntry | null> {
  try {
    const pool = await getCustomerPool(customerId);
    const [stateRows, pendingRows] = await Promise.all([
      pool.query<{
        kind: Phase2StreamingKind;
        last_pushed_event_time: Date | null;
        opportunistic_enabled: boolean;
      }>(
        `SELECT kind,
                last_pushed_event_time,
                opportunistic_enabled
           FROM aimer_push_state`,
      ),
      pool.query<{ kind: string; pending: string }>(
        `SELECT kind, COUNT(*)::text AS pending
           FROM aimer_push_queue
          WHERE acked_at IS NULL
          GROUP BY kind`,
      ),
    ]);

    const pendingByDrain = aggregatePendingByDrain(pendingRows.rows);
    const contributing: {
      kind: "baseline_event" | "story" | "policy_event";
      bucket: Phase2SummaryBucket;
    }[] = [];

    for (const drainKind of [
      "baseline_event",
      "story",
    ] as const satisfies readonly Phase2StreamingKind[]) {
      const state = stateRows.rows.find((r) => r.kind === drainKind);
      const pending = pendingByDrain[drainKind] ?? 0;
      const bucket = bucketForStreamingFast(state, pending);
      if (bucket !== null) {
        contributing.push({ kind: drainKind, bucket });
      }
    }

    const policyEventPending = pendingByDrain.policy_event ?? 0;
    const policyEventBucket = bucketForPolicyEventFast(policyEventPending);
    if (policyEventBucket !== null) {
      contributing.push({ kind: "policy_event", bucket: policyEventBucket });
    }

    if (contributing.length === 0) return null;
    const worst = contributing.reduce<Phase2SummaryBucket>(
      (acc, c) => worseBucket(acc, c.bucket),
      contributing[0].bucket,
    );
    const pausedKinds = contributing
      .filter(
        (c): c is { kind: "baseline_event" | "story"; bucket: "paused" } =>
          c.bucket === "paused" &&
          (c.kind === "baseline_event" || c.kind === "story"),
      )
      .map((c) => c.kind);
    return {
      customer_id: customerId,
      worst_bucket: worst,
      kinds: contributing.map((c) => c.kind),
      paused_kinds: pausedKinds,
    };
  } catch {
    // A tenant whose pool fails to connect (DB migration mid-flight,
    // network blip) must not 500 the global banner; skip and let other
    // tenants surface normally.
    return null;
  }
}

function aggregatePendingByDrain(
  rows: readonly { kind: string; pending: string }[],
): {
  baseline_event: number;
  story: number;
  policy_event: number;
} {
  const out = { baseline_event: 0, story: 0, policy_event: 0 };
  for (const r of rows) {
    const count = Number(r.pending);
    if (
      r.kind === "withdraw_baseline_event" ||
      r.kind === "refresh_baseline_window" ||
      r.kind === "backfill_baseline_window"
    ) {
      out.baseline_event += count;
    } else if (
      r.kind === "withdraw_story" ||
      r.kind === "refresh_story_window" ||
      r.kind === "backfill_story_window"
    ) {
      out.story += count;
    } else if (r.kind === "withdraw_policy_event") {
      out.policy_event += count;
    }
  }
  return out;
}

// Mirror the thresholds in `estimateBacklog` exactly so the summary's
// bucket boundaries match the per-customer page; if either changes,
// both must change.
const BEHIND_SECONDS = 5 * 60;
const WAY_BEHIND_SECONDS = 60 * 60;
const BEHIND_PENDING = 10;
const WAY_BEHIND_PENDING = 100;

function bucketForStreamingFast(
  state:
    | {
        last_pushed_event_time: Date | null;
        opportunistic_enabled: boolean;
      }
    | undefined,
  pending: number,
): Phase2SummaryBucket | null {
  if (state && !state.opportunistic_enabled) return "paused";
  const lagSeconds =
    state?.last_pushed_event_time === null ||
    state?.last_pushed_event_time === undefined
      ? null
      : Math.max(
          0,
          Math.floor(
            (Date.now() - state.last_pushed_event_time.getTime()) / 1000,
          ),
        );
  if (
    pending >= WAY_BEHIND_PENDING ||
    (lagSeconds !== null && lagSeconds >= WAY_BEHIND_SECONDS)
  ) {
    return "way_behind";
  }
  if (
    pending >= BEHIND_PENDING ||
    (lagSeconds !== null && lagSeconds >= BEHIND_SECONDS)
  ) {
    return "behind";
  }
  return null;
}

function bucketForPolicyEventFast(pending: number): Phase2SummaryBucket | null {
  if (pending >= WAY_BEHIND_PENDING) return "way_behind";
  if (pending >= BEHIND_PENDING) return "behind";
  return null;
}

// ── Cadence config (app-shell manager) ────────────────────────────

export interface Phase2CadenceConfigEntry {
  customer_id: number;
  cadence_enabled: boolean;
}

export interface Phase2CadenceConfigDto {
  customers: readonly Phase2CadenceConfigEntry[];
}

/**
 * Per-customer cadence-consent map for the app-shell cadence manager
 * (#651). The manager fetches this once on mount (and again when the
 * Settings toggle dispatches its change event) to decide which
 * customers to start a {@link createPeriodicDrain} for.
 *
 * Only customers whose cadence is enabled are returned — the manager
 * needs no row for an opted-out customer. Per-customer reads are bounded
 * by {@link SUMMARY_PER_CUSTOMER_CONCURRENCY} (shared with the summary
 * fan-out) and fail soft: a tenant whose pool hiccups is simply omitted
 * (treated as opted-out) rather than 500-ing the whole config.
 */
export async function buildPhase2CadenceConfig(
  customerIds: readonly number[],
): Promise<Phase2CadenceConfigDto> {
  if (customerIds.length === 0) return { customers: [] };
  const sortedIds = [...customerIds].sort((a, b) => a - b);
  const entries = await mapWithConcurrency(
    sortedIds,
    SUMMARY_PER_CUSTOMER_CONCURRENCY,
    async (customerId): Promise<Phase2CadenceConfigEntry | null> => {
      try {
        return (await getCadenceEnabled(customerId))
          ? { customer_id: customerId, cadence_enabled: true }
          : null;
      } catch {
        return null;
      }
    },
  );
  return {
    customers: entries.filter((e): e is Phase2CadenceConfigEntry => e !== null),
  };
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (true) {
        const index = cursor++;
        if (index >= items.length) return;
        results[index] = await mapper(items[index]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}
