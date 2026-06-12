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

import {
  useResolvedTimeFormat,
  useTimezone,
} from "@/components/providers/account-preferences-provider";
import {
  formatDateTime,
  formatDateTimeCompact,
  type ResolvedTimeFormat,
} from "@/lib/format-date";
import { reservedTimestampCh } from "@/lib/timestamp-width";

/**
 * Reserved widths (in `ch`) for the pre-mount placeholder slot under the
 * **default** (unset) time-display format — the global worst case across
 * the curated locale list for browser-locale / locale-default hour cycle
 * / seconds shown / no tz label. With a stored preference (#766) the slot
 * is resized from the resolved options via {@link reservedTimestampCh};
 * this constant is the default baseline the deterministic SSR /
 * first-paint placeholder reserves before the client resolves the
 * preference. Pinned by a unit test that measures the real worst-case
 * formatter outputs, so an undersized reservation fails CI.
 */
const DEFAULT_RESOLVED: ResolvedTimeFormat = {
  locale: undefined,
  hourCycle: undefined,
  seconds: true,
  tzLabel: false,
};

export const TIMESTAMP_RESERVED_CH = {
  general: reservedTimestampCh(DEFAULT_RESOLVED, false),
  compact: reservedTimestampCh(DEFAULT_RESOLVED, true),
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

function slotStyle(reservedCh: number): CSSProperties {
  return {
    display: "inline-block",
    minWidth: `${reservedCh}ch`,
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
  const timeFormat = useResolvedTimeFormat();

  const iso = toIso(at);
  const style = slotStyle(reservedTimestampCh(timeFormat, compact));

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
    ? formatDateTimeCompact(at, timezone, locale, timeFormat)
    : formatDateTime(at, timezone, timeFormat);

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
  const timeFormat = useResolvedTimeFormat();

  const format = useCallback(
    (at: Date | string): string | null =>
      mounted ? formatDateTime(at, timezone, timeFormat) : null,
    [mounted, timezone, timeFormat],
  );

  const formatCompact = useCallback(
    (at: Date | string): string | null =>
      mounted ? formatDateTimeCompact(at, timezone, locale, timeFormat) : null,
    [mounted, timezone, locale, timeFormat],
  );

  return { resolved: mounted, format, formatCompact };
}
