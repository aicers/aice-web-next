"use server";

/**
 * Client-callable wrapper for the curated-Story save (#490). The
 * underlying `saveAnalystCuratedStory` in
 * `@/lib/triage/story/actions` is a server-only helper; this module
 * exposes a slim `"use server"` action so the "Save as Story" modal
 * (a client component) can invoke it through Next's server-action
 * channel.
 *
 * Errors from the helper are forwarded verbatim — the modal renders
 * the user-facing copy from its i18n labels. Authentication failures
 * are normalized to `CUSTOMER_OUT_OF_SCOPE` so the modal can show one
 * consistent message rather than crashing the client tree.
 */

import { headers } from "next/headers";

import { getCurrentSession } from "@/lib/auth/session";
import type { TriagePeriod } from "@/lib/triage/period";
import {
  type LoadStoriesResult,
  loadStoriesForPeriod,
  loadStoryDetail,
  saveAnalystCuratedStory,
} from "@/lib/triage/story/actions";
import type {
  SaveCuratedStoryInput,
  SaveCuratedStoryResult,
  StoriesSortOrder,
  TriageStoryMemberDetail,
} from "@/lib/triage/story/types";
import {
  cutoffForStop,
  DEFAULT_STRICTNESS_STOP_ID,
  parseStrictnessStopId,
  type StrictnessStopId,
} from "@/lib/triage/strictness/stops";

/**
 * Refetch the Stories list for the current period with explicit sort
 * and "Show only unsent" toggles. Pushes both axes into SQL so the
 * UI controls operate against the entire period — not the
 * already-truncated first page the initial server-render returned.
 * The unsent toggle is what consumes the partial index
 * `(score DESC) WHERE last_sent_at IS NULL` named in #490's spec.
 *
 * Returns `null` when the caller's session lapsed; the client falls
 * back to the previously-rendered list and surfaces no error toast
 * (a refetch failure is a UX downgrade, not an outright error).
 */
export async function refreshTriageStories(
  period: TriagePeriod,
  options: { sortOrder: StoriesSortOrder; unsentOnly: boolean },
): Promise<LoadStoriesResult | null> {
  const session = await getCurrentSession();
  if (!session) return null;
  try {
    return await loadStoriesForPeriod(session, period, options);
  } catch {
    return null;
  }
}

export async function submitSaveAnalystCuratedStory(
  input: SaveCuratedStoryInput,
  period: TriagePeriod,
): Promise<SaveCuratedStoryResult> {
  const session = await getCurrentSession();
  if (!session) {
    return {
      ok: false,
      error: { code: "CUSTOMER_OUT_OF_SCOPE", customerId: input.customerId },
    };
  }
  const hdrs = await headers();
  const ip =
    hdrs.get("x-forwarded-for")?.split(",")[0].trim() ??
    hdrs.get("x-real-ip") ??
    undefined;
  return saveAnalystCuratedStory(session, input, { period, ip });
}

/**
 * Story detail member fetch. The list-time top-3 preview is enough
 * for the card; opening a Story drills into the full
 * `event_group_member ⨝ baseline_triaged_event` join with the
 * read-time `cume_dist()`-derived `baseline_score`, plus the
 * dangling-member delta needed for the
 * `"<shown> of <stored> events shown — <aged> aged past corpus A
 *  retention"` notice.
 *
 * Returns `null` when the caller's session lapsed, when the
 * `customerId` is no longer in the caller's effective scope, or
 * when the lookup encountered an unexpected error — the client
 * renders the empty-state copy and lets the operator close the
 * panel.
 */
export interface StoryDetailFetchResult {
  members: TriageStoryMemberDetail[];
  hasDanglingMembers: boolean;
  storedMemberCount: number;
}

export async function fetchStoryDetail(
  customerId: number,
  storyId: string,
  storedMemberCount: number,
  period: TriagePeriod,
  strictness:
    | StrictnessStopId
    | string
    | null
    | undefined = DEFAULT_STRICTNESS_STOP_ID,
): Promise<StoryDetailFetchResult | null> {
  const session = await getCurrentSession();
  if (!session) return null;
  // `strictness` arrives from the client either as a known stop id or
  // as a raw URL/hash string; normalize before resolving the cutoff so
  // a stale persisted value never throws here.
  const stop = parseStrictnessStopId(
    typeof strictness === "string" ? strictness : null,
  );
  const cutoff = cutoffForStop(stop);
  try {
    return await loadStoryDetail(
      session,
      customerId,
      storyId,
      storedMemberCount,
      period,
      cutoff,
    );
  } catch {
    return null;
  }
}
