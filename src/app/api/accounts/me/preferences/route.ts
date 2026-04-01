import "server-only";

import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { routing } from "@/i18n/routing";
import { withAuth } from "@/lib/auth/guard";
import { query } from "@/lib/db/client";
import { isValidTimezone } from "@/lib/timezone";

// ── Types ───────────────────────────────────────────────────────

interface PreferencesRow {
  locale: string | null;
  timezone: string | null;
}

// ── Constants ───────────────────────────────────────────────────

const NEXT_LOCALE_COOKIE = "NEXT_LOCALE";
const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;

// ── Route Handlers ──────────────────────────────────────────────

/**
 * GET /api/accounts/me/preferences
 *
 * Returns the authenticated account's locale and timezone preferences.
 * No special permission required — self-read only.
 */
export const GET = withAuth(
  async (_request, _context, session) => {
    const { rows } = await query<PreferencesRow>(
      "SELECT locale, timezone FROM accounts WHERE id = $1",
      [session.accountId],
    );

    if (rows.length === 0) {
      return NextResponse.json({ error: "Account not found" }, { status: 404 });
    }

    return NextResponse.json({ data: rows[0] });
  },
  { skipMfaEnrollCheck: true },
);

/**
 * PATCH /api/accounts/me/preferences
 *
 * Updates the authenticated account's locale and/or timezone.
 * No special permission required — self-edit only.
 *
 * Body: `{ locale?: string | null, timezone?: string | null }`
 */
export const PATCH = withAuth(
  async (request, _context, session) => {
    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const updates: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    // Locale validation
    if (body.locale !== undefined) {
      if (body.locale === null) {
        updates.push(`locale = $${idx++}`);
        params.push(null);
      } else if (typeof body.locale === "string") {
        const locales: readonly string[] = routing.locales;
        if (!locales.includes(body.locale)) {
          return NextResponse.json(
            {
              error: `Invalid locale. Must be one of: ${routing.locales.join(", ")}`,
            },
            { status: 400 },
          );
        }
        updates.push(`locale = $${idx++}`);
        params.push(body.locale);
      } else {
        return NextResponse.json(
          { error: "locale must be a string or null" },
          { status: 400 },
        );
      }
    }

    // Timezone validation
    if (body.timezone !== undefined) {
      if (body.timezone === null) {
        updates.push(`timezone = $${idx++}`);
        params.push(null);
      } else if (typeof body.timezone === "string") {
        if (!isValidTimezone(body.timezone)) {
          return NextResponse.json(
            { error: "Invalid timezone" },
            { status: 400 },
          );
        }
        updates.push(`timezone = $${idx++}`);
        params.push(body.timezone);
      } else {
        return NextResponse.json(
          { error: "timezone must be a string or null" },
          { status: 400 },
        );
      }
    }

    if (updates.length === 0) {
      // Nothing to update — return current values
      const { rows } = await query<PreferencesRow>(
        "SELECT locale, timezone FROM accounts WHERE id = $1",
        [session.accountId],
      );
      return NextResponse.json({ data: rows[0] });
    }

    updates.push("updated_at = NOW()");
    params.push(session.accountId);

    const { rows } = await query<PreferencesRow>(
      `UPDATE accounts SET ${updates.join(", ")} WHERE id = $${idx}
     RETURNING locale, timezone`,
      params,
    );

    if (rows.length === 0) {
      return NextResponse.json({ error: "Account not found" }, { status: 404 });
    }

    // Set NEXT_LOCALE cookie when locale is updated
    if (body.locale !== undefined) {
      const cookieStore = await cookies();
      if (body.locale === null) {
        cookieStore.delete(NEXT_LOCALE_COOKIE);
      } else {
        cookieStore.set(NEXT_LOCALE_COOKIE, body.locale as string, {
          path: "/",
          maxAge: ONE_YEAR_SECONDS,
        });
      }
    }

    return NextResponse.json({ data: rows[0] });
  },
  { skipMfaEnrollCheck: true },
);
