"use client";

/**
 * Centralized, client-resolved timestamp rendering (RFC 0004).
 *
 * Every timestamp surface renders through this module so timezone +
 * locale resolution, hydration safety, and the display format live in a
 * single place. The mechanism mirrors aimer-web's `<Timestamp>` after
 * its UTC-flash rework:
 *
 * - Pre-mount (server render + first client paint) a deterministic,
 *   layout-stable placeholder is shown. Because the placeholder is a
 *   static constant, the server markup and the first client paint are
 *   byte-identical, so there is no hydration mismatch even when the
 *   server timezone/locale differs from the browser's.
 * - Post-mount the timezone is resolved from {@link useTimezone} and the
 *   value is formatted with the existing {@link formatDateTime} /
 *   {@link formatDateTimeCompact} formatters.
 *
 * The new API never paints a UTC or server-zone value first: pre-mount
 * is a hidden placeholder, not a formatted instant.
 */

import { useLocale } from "next-intl";
import { type CSSProperties, useCallback, useEffect, useState } from "react";

import { useTimezone } from "@/components/providers/timezone-provider";
import { formatDateTime, formatDateTimeCompact } from "@/lib/format-date";

/**
 * Reserved widths (in `ch`) for the pre-mount placeholder slot, sized
 * for the worst-case representative `en` / `ko` outputs. CJK/Hangul
 * glyphs render about `2ch`, so a fully-spelled Korean timestamp is the
 * widest case. The {@link TIMESTAMP_RESERVED_CH} export is pinned by a
 * unit test that measures the real worst-case formatter outputs, so an
 * undersized reservation fails CI.
 */
export const TIMESTAMP_RESERVED_CH = {
  general: 28,
  compact: 19,
} as const;

/**
 * Static placeholder glyphs shown (hidden) while the timezone resolves.
 * Must stay a compile-time constant so SSR and first client paint are
 * byte-identical — never derive it from `at`, the locale, or the zone.
 */
const PLACEHOLDER = " "; // FIGURE SPACE — fixed-width, non-announced

function useMounted(): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);
  return mounted;
}

function toIso(at: Date | string): string {
  return typeof at === "string" ? at : at.toISOString();
}

function slotStyle(compact: boolean): CSSProperties {
  return {
    display: "inline-block",
    minWidth: `${
      compact ? TIMESTAMP_RESERVED_CH.compact : TIMESTAMP_RESERVED_CH.general
    }ch`,
  };
}

export interface TimestampProps {
  /** The instant to render: a `Date` or an ISO string. */
  at: Date | string;
  /** Compact form (no year, no seconds) for tight surfaces. */
  compact?: boolean;
  className?: string;
}

/**
 * Render an instant as a semantic `<time dateTime={iso}>`, resolving the
 * timezone on the client behind a layout-stable placeholder.
 */
export function Timestamp({ at, compact = false, className }: TimestampProps) {
  const mounted = useMounted();
  const timezone = useTimezone();
  const locale = useLocale();

  const iso = toIso(at);
  const style = slotStyle(compact);

  if (!mounted) {
    return (
      <time aria-busy="true" className={className} dateTime={iso} style={style}>
        <span aria-hidden="true" style={{ visibility: "hidden" }}>
          {PLACEHOLDER}
        </span>
      </time>
    );
  }

  const formatted = compact
    ? formatDateTimeCompact(at, timezone, locale)
    : formatDateTime(at, timezone);

  return (
    <time className={className} dateTime={iso} style={style}>
      {formatted}
    </time>
  );
}

export interface TimestampFormatter {
  /** `false` pre-mount, `true` once the client timezone has resolved. */
  resolved: boolean;
  /** Returns the general-format string, or `null` pre-mount. */
  format: (at: Date | string) => string | null;
  /** Returns the compact-format string, or `null` pre-mount. */
  formatCompact: (at: Date | string) => string | null;
}

/**
 * Hook companion to {@link Timestamp} for call sites that consume the
 * formatted value as **data** (a string) rather than JSX — shared-table
 * row mappings, translation interpolation, `title` attributes, and
 * breadcrumb labels, including the `.map()` loops where a per-value hook
 * cannot be called.
 *
 * Pre-mount, `resolved` is `false` and both formatters return `null`;
 * the caller owns the null handling (render nothing or a fallback).
 * `format` / `formatCompact` keep stable identities keyed on the
 * resolved timezone/locale, so they are safe to list in effect/memo
 * dependency arrays.
 */
export function useTimestampFormatter(): TimestampFormatter {
  const mounted = useMounted();
  const timezone = useTimezone();
  const locale = useLocale();

  const format = useCallback(
    (at: Date | string): string | null =>
      mounted ? formatDateTime(at, timezone) : null,
    [mounted, timezone],
  );

  const formatCompact = useCallback(
    (at: Date | string): string | null =>
      mounted ? formatDateTimeCompact(at, timezone, locale) : null,
    [mounted, timezone, locale],
  );

  return { resolved: mounted, format, formatCompact };
}
