import "server-only";

import type { NextRequest } from "next/server";

/**
 * Extract the client IP address from a Next.js request.
 *
 * Checks `X-Forwarded-For` first (first entry = original client),
 * then falls back to `request.ip` (populated by the runtime), and
 * finally to `"unknown"`.
 */
export function extractClientIp(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0].trim();
    if (first) return first;
  }
  return (request as NextRequest & { ip?: string }).ip ?? "unknown";
}
