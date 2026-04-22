/**
 * Detection-page constants kept out of `actions.ts` because Next's
 * `"use server"` files can only export async functions — a plain
 * constant would silently strip every export from the module.
 */

/**
 * Default page size for the result list. Pagination controls land
 * in Phase Detection-11; v1 fetches the first page and lets the
 * operator narrow with filters when the count is large.
 */
export const DEFAULT_RESULT_PAGE_SIZE = 50;
