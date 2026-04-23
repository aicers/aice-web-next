/**
 * Default page size for the Detection result list (Phase Detection-9).
 *
 * Real pagination controls land in Phase Detection-11; until then the
 * shell fetches a fixed first-page slice large enough to be useful
 * for triage but small enough to keep the payload tight. The constant
 * lives in its own module rather than `actions.ts` because the latter
 * is `"use server"` and may only export async functions — pulling
 * the literal across the server / client boundary requires a
 * regular module.
 */
export const DEFAULT_EVENT_LIST_PAGE_SIZE = 50;
