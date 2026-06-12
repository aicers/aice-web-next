import "server-only";

import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { routing } from "@/i18n/routing";
import { withAuth } from "@/lib/auth/guard";
import { query } from "@/lib/db/client";
import { isValidHourCycle, isValidTimeFormatLocale } from "@/lib/time-format";
import { isValidTimezone } from "@/lib/timezone";

// ── Types ───────────────────────────────────────────────────────

interface PreferencesRow {
  locale: string | null;
  timezone: string | null;
  time_format_locale: string | null;
  time_format_hour_cycle: string | null;
  time_format_seconds: boolean | null;
  time_format_tz_label: boolean | null;
}

// ── Constants ───────────────────────────────────────────────────

const NEXT_LOCALE_COOKIE = "NEXT_LOCALE";
const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;

const SELECT_COLUMNS =
  "locale, timezone, time_format_locale, time_format_hour_cycle, " +
  "time_format_seconds, time_format_tz_label";

// ── Helpers ─────────────────────────────────────────────────────

/**
 * Map a DB row (snake_case columns) to the API response shape
 * (camelCase keys matching aimer-web for cross-product API parity).
 */
function toResponse(row: PreferencesRow) {
  return {
    locale: row.locale,
    timezone: row.timezone,
    timeFormatLocale: row.time_format_locale,
    timeFormatHourCycle: row.time_format_hour_cycle,
    timeFormatSeconds: row.time_format_seconds,
    timeFormatTzLabel: row.time_format_tz_label,
  };
}

// ── Route Handlers ──────────────────────────────────────────────

/**
 * GET /api/accounts/me/preferences
 *
 * Returns the authenticated account's locale, timezone, and
 * time-display-format preferences. No special permission required —
 * self-read only.
 */
export const GET = withAuth(
  async (_request, _context, session) => {
    const { rows } = await query<PreferencesRow>(
      `SELECT ${SELECT_COLUMNS} FROM accounts WHERE id = $1`,
      [session.accountId],
    );

    if (rows.length === 0) {
      return NextResponse.json({ error: "Account not found" }, { status: 404 });
    }

    return NextResponse.json({ data: toResponse(rows[0]) });
  },
  { skipMfaEnrollCheck: true },
);

/**
 * PATCH /api/accounts/me/preferences
 *
 * Updates the authenticated account's locale, timezone, and/or
 * time-display-format options. No special permission required —
 * self-edit only.
 *
 * Body (all optional): `{ locale, timezone, timeFormatLocale,
 * timeFormatHourCycle, timeFormatSeconds, timeFormatTzLabel }`. `null`
 * for any field resets it to the app default.
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

    // timeFormatLocale validation: 'app' sentinel or a curated BCP-47 tag.
    if (body.timeFormatLocale !== undefined) {
      if (body.timeFormatLocale === null) {
        updates.push(`time_format_locale = $${idx++}`);
        params.push(null);
      } else if (typeof body.timeFormatLocale === "string") {
        if (!isValidTimeFormatLocale(body.timeFormatLocale)) {
          return NextResponse.json(
            { error: "Invalid timeFormatLocale" },
            { status: 400 },
          );
        }
        updates.push(`time_format_locale = $${idx++}`);
        params.push(body.timeFormatLocale);
      } else {
        return NextResponse.json(
          { error: "timeFormatLocale must be a string or null" },
          { status: 400 },
        );
      }
    }

    // timeFormatHourCycle validation: 'h12' / 'h23' (NULL is "auto").
    if (body.timeFormatHourCycle !== undefined) {
      if (body.timeFormatHourCycle === null) {
        updates.push(`time_format_hour_cycle = $${idx++}`);
        params.push(null);
      } else if (
        typeof body.timeFormatHourCycle === "string" &&
        isValidHourCycle(body.timeFormatHourCycle)
      ) {
        updates.push(`time_format_hour_cycle = $${idx++}`);
        params.push(body.timeFormatHourCycle);
      } else {
        return NextResponse.json(
          {
            error: "Invalid timeFormatHourCycle. Must be 'h12', 'h23', or null",
          },
          { status: 400 },
        );
      }
    }

    // timeFormatSeconds validation: boolean | null.
    if (body.timeFormatSeconds !== undefined) {
      if (
        body.timeFormatSeconds === null ||
        typeof body.timeFormatSeconds === "boolean"
      ) {
        updates.push(`time_format_seconds = $${idx++}`);
        params.push(body.timeFormatSeconds);
      } else {
        return NextResponse.json(
          { error: "timeFormatSeconds must be a boolean or null" },
          { status: 400 },
        );
      }
    }

    // timeFormatTzLabel validation: boolean | null.
    if (body.timeFormatTzLabel !== undefined) {
      if (
        body.timeFormatTzLabel === null ||
        typeof body.timeFormatTzLabel === "boolean"
      ) {
        updates.push(`time_format_tz_label = $${idx++}`);
        params.push(body.timeFormatTzLabel);
      } else {
        return NextResponse.json(
          { error: "timeFormatTzLabel must be a boolean or null" },
          { status: 400 },
        );
      }
    }

    if (updates.length === 0) {
      // Nothing to update — return current values
      const { rows } = await query<PreferencesRow>(
        `SELECT ${SELECT_COLUMNS} FROM accounts WHERE id = $1`,
        [session.accountId],
      );
      return NextResponse.json({ data: toResponse(rows[0]) });
    }

    updates.push("updated_at = NOW()");
    params.push(session.accountId);

    const { rows } = await query<PreferencesRow>(
      `UPDATE accounts SET ${updates.join(", ")} WHERE id = $${idx}
     RETURNING ${SELECT_COLUMNS}`,
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

    return NextResponse.json({ data: toResponse(rows[0]) });
  },
  { skipMfaEnrollCheck: true },
);
