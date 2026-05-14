import "server-only";

/**
 * Stories tab server actions (#490).
 *
 * Sibling module to `../server-actions.ts` — the central
 * `loadTriagePeriod` action stays focused on the Asset list / Pivot
 * read path; Story-specific read and write paths live here so the
 * Stories tab can ship without growing the existing module past its
 * already-large surface.
 *
 * All exports are `"use server"`-eligible — they take an `AuthSession`
 * and run a `triage:read` gate before touching any tenant DB.
 */

import { z } from "zod";

import { auditLog } from "@/lib/audit/logger";
import type { AuthSession } from "@/lib/auth/jwt";
import { query as centralQuery } from "@/lib/db/client";
import { buildDispatchContext } from "../dispatch-context";
import type { TriagePeriod } from "../period";
import { getCustomerPool } from "../policy/customer-db";

import {
  insertCuratedStory,
  type ListStoriesOptions,
  listStoriesForPeriod,
  readBaselineEventsByKey,
  readStoryMemberDetail,
  type StoryMemberDetailResult,
} from "./repository";
import { applyMemberCap, STORY_MEMBER_CAP } from "./rules";
import type {
  SaveCuratedStoryError,
  SaveCuratedStoryInput,
  SaveCuratedStoryResult,
  StoriesSortOrder,
  TriageStory,
} from "./types";
import { TRIAGE_STORY_PAGE_SIZE } from "./types";

const FANOUT_CONCURRENCY = 4;
const MANUAL_TITLE_MAX = 200;

/**
 * Zod schema mirroring the curated-save input contract from #490.
 *
 *   - `customerId` — Required tenant id; the server validates it is in
 *     the caller's effective scope (`CUSTOMER_OUT_OF_SCOPE` on miss).
 *   - `memberEventKeys` — `NUMERIC(39, 0)` keys as decimal strings.
 *     1..STORY_MEMBER_CAP entries; deduped server-side. Empty produces
 *     `EMPTY`; over-cap produces `OVER_CAP`.
 *   - `memberCustomerIds` — Parallel array to `memberEventKeys`. The
 *     analyst-observed tenant-of-origin for each member; any entry
 *     that does not equal `customerId` produces
 *     `MULTI_CUSTOMER_NOT_ALLOWED`. Length must match
 *     `memberEventKeys`. Per-member provenance is what makes the
 *     server's defensive single-tenant guard reachable.
 *   - `primaryAsset` — INET literal (IPv4/IPv6). Must equal `orig_addr`
 *     of at least one resolved member (`ASSET_MISMATCH` on miss).
 *   - `title` — Optional. Trimmed; max 200 chars. Absent (not the empty
 *     string) means the renderer falls back to the auto-generated title.
 */
export const saveCuratedStorySchema = z.object({
  customerId: z.number().int().positive(),
  memberEventKeys: z.array(
    z.string().min(1).regex(/^\d+$/, "event_key must be a decimal string"),
  ),
  memberCustomerIds: z.array(z.number().int().positive()),
  primaryAsset: z.string().min(1),
  // `title` is bounded server-side so direct action callers cannot
  // submit a >200-char payload and have it silently truncated into the
  // stored `manualTitle` + audit record. The trimmed-length check
  // matches the analyst-visible policy: leading/trailing whitespace
  // is not part of the user intent and must not consume the budget.
  // The schema is the single source of truth for length policy; the
  // post-parse pipeline can rely on `input.title` already fitting.
  title: z
    .string()
    .optional()
    .refine(
      (value) => value === undefined || value.trim().length <= MANUAL_TITLE_MAX,
      {
        message: `title must be at most ${MANUAL_TITLE_MAX} characters`,
      },
    ),
});

// The runtime-validated shape comes from {@link saveCuratedStorySchema};
// the {@link SaveCuratedStoryInput} export lives in `./types` so client
// callers can import it without crossing the `server-only` boundary.
export type SaveCuratedStoryParsed = z.infer<typeof saveCuratedStorySchema>;

/**
 * Per-tenant page of Stories for the menu's selected period plus the
 * server-resolved truncation flag for the Stories list.
 */
export interface LoadStoriesResult {
  stories: TriageStory[];
  /** `true` whenever any per-tenant slice hit {@link TRIAGE_STORY_PAGE_SIZE}. */
  truncated: boolean;
}

/**
 * Fan out the Stories list across the session's effective customer
 * scope and merge results on
 * `(time_window_end DESC, score DESC, customerId, storyId)`.
 *
 * Single-customer scope is a strict subset: one tenant query, one
 * merge step. The composite key (customerId, storyId) keeps both
 * single- and multi-tenant render paths on the same comparator —
 * a future link from a single-tenant session to a multi-tenant one
 * never breaks because the URL hash always carries `customerId/storyId`.
 */
export async function loadStoriesForPeriod(
  session: AuthSession,
  period: TriagePeriod,
  options?: ListStoriesOptions,
  signal?: AbortSignal,
): Promise<LoadStoriesResult> {
  const ctx = await buildDispatchContext(session);
  if (ctx.customerIds.length === 0) return { stories: [], truncated: false };

  const sortOrder: StoriesSortOrder = options?.sortOrder ?? "time-window-end";
  const unsentOnly = Boolean(options?.unsentOnly);

  const namesById = await loadCustomerNames(ctx.customerIds);
  const slices = await pMapBatched(
    ctx.customerIds,
    FANOUT_CONCURRENCY,
    async (id) => {
      const pool = await getCustomerPool(id);
      return listStoriesForPeriod(
        pool,
        id,
        namesById.get(id) ?? String(id),
        period,
        TRIAGE_STORY_PAGE_SIZE,
        { sortOrder, unsentOnly },
        signal,
      );
    },
  );
  const truncated = slices.some((s) => s.length >= TRIAGE_STORY_PAGE_SIZE);
  const merged = slices.flat();
  // Merge comparator mirrors the per-tenant SQL ORDER BY so the post-
  // merge ordering is identical to what each tenant returned, just
  // interleaved by the chosen sort axis.
  merged.sort((a, b) => {
    if (sortOrder === "score") {
      const aScore = a.score ?? Number.NEGATIVE_INFINITY;
      const bScore = b.score ?? Number.NEGATIVE_INFINITY;
      if (aScore !== bScore) return bScore - aScore;
      if (a.timeWindowEndIso !== b.timeWindowEndIso) {
        return b.timeWindowEndIso.localeCompare(a.timeWindowEndIso);
      }
    } else {
      if (a.timeWindowEndIso !== b.timeWindowEndIso) {
        return b.timeWindowEndIso.localeCompare(a.timeWindowEndIso);
      }
      const aScore = a.score ?? Number.NEGATIVE_INFINITY;
      const bScore = b.score ?? Number.NEGATIVE_INFINITY;
      if (aScore !== bScore) return bScore - aScore;
    }
    if (a.customerId !== b.customerId) return a.customerId - b.customerId;
    return a.storyId.localeCompare(b.storyId);
  });
  return { stories: merged, truncated };
}

/**
 * Read the detail-panel member table for a single Story. Validates
 * the caller's scope before touching the tenant pool — a Story id in
 * a customer outside scope returns `null`.
 */
export async function loadStoryDetail(
  session: AuthSession,
  customerId: number,
  storyId: string,
  storedMemberCount: number,
  period: TriagePeriod,
  signal?: AbortSignal,
): Promise<StoryMemberDetailResult | null> {
  const ctx = await buildDispatchContext(session);
  if (!ctx.customerIds.includes(customerId)) return null;
  const pool = await getCustomerPool(customerId);
  return readStoryMemberDetail(
    pool,
    storyId,
    storedMemberCount,
    period,
    signal,
  );
}

/**
 * Save an analyst-curated Story.
 *
 * Validation pipeline (matches the six error codes from
 * {@link SaveCuratedStoryError}):
 *
 *   1. zod parse — rejects empty `memberEventKeys`, malformed event-
 *      key strings, an over-length `title`, and a non-positive
 *      `customerId`. The empty-array branch produces `EMPTY`; over-cap
 *      is handled below explicitly so the cap error can name the cap.
 *   2. `customerId` ∈ caller's session effective scope →
 *      `CUSTOMER_OUT_OF_SCOPE` on miss.
 *   3. `memberEventKeys.length > STORY_MEMBER_CAP` → `OVER_CAP`.
 *   4. Per-member customer provenance. `memberCustomerIds` is a
 *      parallel array carrying the tenant-of-origin the analyst's
 *      pivot focus observed for each event key. Length must equal
 *      `memberEventKeys`; any entry that does not equal `customerId`
 *      → `MULTI_CUSTOMER_NOT_ALLOWED`. The check fires before any
 *      tenant DB work so a mixed-tenant input can never reach the
 *      single-pool resolution and collapse into `MEMBER_NOT_FOUND`.
 *   5. Resolve member rows in the chosen customer's tenant DB. Any
 *      missing key (including the cross-tenant case where a key
 *      resolves only in another tenant) → `MEMBER_NOT_FOUND`.
 *   6. `primaryAsset` matches at least one resolved member's
 *      `orig_addr` → `ASSET_MISMATCH` on miss.
 *
 * On success the row is inserted under one BEGIN/COMMIT transaction
 * inside the chosen customer's tenant pool, and the audit event
 * `triage.story.create` (`triage_story` target) is recorded.
 */
export async function saveAnalystCuratedStory(
  session: AuthSession,
  rawInput: SaveCuratedStoryInput | unknown,
  audit: {
    period: TriagePeriod;
    ip?: string;
  },
): Promise<SaveCuratedStoryResult> {
  const parsed = saveCuratedStorySchema.safeParse(rawInput);
  if (!parsed.success) {
    // Shape-level failure (missing required fields, malformed types,
    // title trimmed length > {@link MANUAL_TITLE_MAX}). None of the six
    // issue-defined error codes match precisely; fall through to
    // `EMPTY` rather than inventing a seventh — the audit/UI surface
    // treats this as a reject without storing anything.
    return err({ code: "EMPTY" });
  }
  const input = parsed.data;
  const trimmedTitle =
    input.title === undefined ? undefined : input.title.trim();
  // The schema rejects trimmed lengths > {@link MANUAL_TITLE_MAX}, so
  // we no longer need to truncate here — the parsed value already fits
  // the policy and what we store is exactly what the analyst submitted.
  const manualTitle =
    trimmedTitle === undefined || trimmedTitle.length === 0
      ? undefined
      : trimmedTitle;

  // Scope check.
  const ctx = await buildDispatchContext(session);
  if (!ctx.customerIds.includes(input.customerId)) {
    return err({ code: "CUSTOMER_OUT_OF_SCOPE", customerId: input.customerId });
  }

  // Per-member customer provenance must agree with the chosen tenant.
  // The parallel-array length must match (a mismatched length is a
  // client contract violation — there is no single intended tenant we
  // can pin every key to). Any per-member entry that is not
  // `input.customerId` triggers `MULTI_CUSTOMER_NOT_ALLOWED`. This
  // check fires before any DB work so a mixed-tenant input never
  // reaches the single-pool resolution and collapses into a misleading
  // `MEMBER_NOT_FOUND`.
  if (input.memberCustomerIds.length !== input.memberEventKeys.length) {
    return err({ code: "MULTI_CUSTOMER_NOT_ALLOWED" });
  }
  if (input.memberCustomerIds.some((id) => id !== input.customerId)) {
    return err({ code: "MULTI_CUSTOMER_NOT_ALLOWED" });
  }

  // Dedup and enforce the member cap before any DB work.
  const dedupedKeys = Array.from(new Set(input.memberEventKeys));
  if (dedupedKeys.length === 0) return err({ code: "EMPTY" });
  if (dedupedKeys.length > STORY_MEMBER_CAP) {
    return err({
      code: "OVER_CAP",
      cap: STORY_MEMBER_CAP,
      received: dedupedKeys.length,
    });
  }

  // Resolve members in the chosen tenant pool.
  const pool = await getCustomerPool(input.customerId);
  const resolved = await readBaselineEventsByKey(pool, dedupedKeys);
  const resolvedKeys = new Set(resolved.map((r) => r.eventKey));
  const missing = dedupedKeys.filter((k) => !resolvedKeys.has(k));
  if (missing.length > 0) {
    return err({ code: "MEMBER_NOT_FOUND", missingEventKeys: missing });
  }

  // `primaryAsset` must equal `orig_addr` of at least one resolved
  // member. This is a string equality on the `host()` projection from
  // SQL, which is the same normalization `inet`-bound `host()` produces
  // for any value the client could legitimately submit.
  const hasAssetMatch = resolved.some((r) => r.origAddr === input.primaryAsset);
  if (!hasAssetMatch) {
    return err({ code: "ASSET_MISMATCH", primaryAsset: input.primaryAsset });
  }

  // Cap + summary derive from the resolved set — never from the
  // request body — so the analyst cannot inflate `memberCount` past
  // the visible members.
  const capped = applyMemberCap(resolved);
  const timeWindowStart = capped.reduce(
    (min, m) => (m.eventTime < min ? m.eventTime : min),
    capped[0].eventTime,
  );
  const timeWindowEnd = capped.reduce(
    (max, m) => (m.eventTime > max ? m.eventTime : max),
    capped[0].eventTime,
  );

  const client = await pool.connect();
  let storyId: string;
  try {
    await client.query("BEGIN");
    const inserted = await insertCuratedStory(client, {
      primaryAsset: input.primaryAsset,
      timeWindowStart,
      timeWindowEnd,
      members: capped,
      manualTitle,
    });
    storyId = inserted.groupId;
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  await auditLog.record({
    actor: session.accountId,
    action: "triage.story.create",
    target: "triage_story",
    targetId: storyId,
    customerId: input.customerId,
    sid: session.sessionId,
    ip: audit.ip,
    details: {
      customerId: input.customerId,
      storyId,
      memberCount: capped.length,
      manualTitle: manualTitle ?? null,
    },
  });

  return { ok: true, customerId: input.customerId, storyId };
}

function err(error: SaveCuratedStoryError): SaveCuratedStoryResult {
  return { ok: false, error };
}

async function loadCustomerNames(
  customerIds: number[],
): Promise<Map<number, string>> {
  const { rows } = await centralQuery<{ id: number; name: string }>(
    "SELECT id, name FROM customers WHERE id = ANY($1::int[])",
    [customerIds],
  );
  return new Map(rows.map((r) => [r.id, r.name]));
}

async function pMapBatched<T, R>(
  inputs: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < inputs.length; i += concurrency) {
    const batch = inputs.slice(i, i + concurrency);
    const results = await Promise.all(batch.map(fn));
    out.push(...results);
  }
  return out;
}
