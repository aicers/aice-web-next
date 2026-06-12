"use client";

/**
 * Client-side account-preferences provider (#766).
 *
 * Generalizes the former `TimezoneProvider`: it fetches
 * `/api/accounts/me/preferences` once on mount and resolves **both** the
 * timezone and the four time-display options (#766) from that single
 * response — no extra round-trip. The resolved {@link ResolvedTimeFormat}
 * is exposed to `<Timestamp>` / `useTimestampFormatter` and the Detection
 * grid so the preference has a single client-side entry point.
 *
 * `refresh()` lets `PreferencesForm` re-pull preferences after a
 * successful save so every already-mounted `<Timestamp>` reflects the new
 * format immediately — `router.refresh()` alone re-renders server
 * components but does not re-run this client provider's effect.
 *
 * The stored time-format preference is **seeded from the server** via
 * `initialTimeFormat` (the dashboard layout already reads the account row
 * for the username, so the four columns ride along with no extra query).
 * Seeding it means the resolved format — and therefore the `<Timestamp>`
 * placeholder width — is correct on the very first paint: a user with a
 * wider stored format (e.g. 24-hour + seconds + tz label) reserves the
 * right width up front instead of resolving the default first and shifting
 * the line when the client fetch returns. The self-fetch effect still runs
 * for the browser-timezone fallback and for `refresh()`; for the format it
 * just re-confirms the seeded value, so there is no layout shift.
 */

import { useLocale } from "next-intl";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import type { ResolvedTimeFormat } from "@/lib/format-date";
import {
  DEFAULT_STORED_TIME_FORMAT,
  resolveTimeFormat,
  type StoredTimeFormat,
} from "@/lib/time-format";

function browserTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

interface AccountPreferencesContextValue {
  timezone: string;
  /** Resolved `Intl` options for the sanctioned formatters. */
  resolvedTimeFormat: ResolvedTimeFormat;
  /** Re-fetch preferences from the API (call after a successful save). */
  refresh: () => void;
}

const DEFAULT_RESOLVED: ResolvedTimeFormat = {
  locale: undefined,
  hourCycle: undefined,
  seconds: true,
  tzLabel: false,
};

const AccountPreferencesContext = createContext<AccountPreferencesContextValue>(
  {
    timezone: browserTimezone(),
    resolvedTimeFormat: DEFAULT_RESOLVED,
    refresh: () => {},
  },
);

/** Current resolved IANA timezone identifier. */
export function useTimezone(): string {
  return useContext(AccountPreferencesContext).timezone;
}

/** Resolved time-display options for the sanctioned formatters (#766). */
export function useResolvedTimeFormat(): ResolvedTimeFormat {
  return useContext(AccountPreferencesContext).resolvedTimeFormat;
}

/** Trigger a re-fetch of account preferences (e.g. after a save). */
export function useRefreshAccountPreferences(): () => void {
  return useContext(AccountPreferencesContext).refresh;
}

export function AccountPreferencesProvider({
  children,
  initialTimeFormat,
}: {
  children: ReactNode;
  /**
   * Server-seeded stored time-format preference (#766). When omitted the
   * provider starts from the app default and resolves the real preference
   * from its self-fetch; seeding it avoids a first-paint width shift for
   * accounts with a non-default format.
   */
  initialTimeFormat?: StoredTimeFormat;
}) {
  const appLocale = useLocale();
  const [timezone, setTimezone] = useState(browserTimezone);
  const [stored, setStored] = useState<StoredTimeFormat>(
    initialTimeFormat ?? DEFAULT_STORED_TIME_FORMAT,
  );
  // Bumped by refresh() to re-run the fetch effect after a save.
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  // `tick` is a re-fetch trigger bumped by refresh(); it is intentionally
  // the effect's only dependency even though it is not read in the body.
  // biome-ignore lint/correctness/useExhaustiveDependencies: tick triggers a re-fetch
  useEffect(() => {
    let cancelled = false;
    fetch("/api/accounts/me/preferences")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled || !data?.data) return;
        const d = data.data as Partial<StoredTimeFormat> & {
          timezone?: string | null;
        };
        setTimezone(d.timezone ?? browserTimezone());
        setStored({
          timeFormatLocale: d.timeFormatLocale ?? null,
          timeFormatHourCycle: d.timeFormatHourCycle ?? null,
          timeFormatSeconds: d.timeFormatSeconds ?? null,
          timeFormatTzLabel: d.timeFormatTzLabel ?? null,
        });
      })
      .catch(() => {
        // Fall back to the browser default — already set.
      });
    return () => {
      cancelled = true;
    };
  }, [tick]);

  const resolvedTimeFormat = useMemo(
    () => resolveTimeFormat(stored, appLocale),
    [stored, appLocale],
  );

  const value = useMemo(
    () => ({ timezone, resolvedTimeFormat, refresh }),
    [timezone, resolvedTimeFormat, refresh],
  );

  return (
    <AccountPreferencesContext.Provider value={value}>
      {children}
    </AccountPreferencesContext.Provider>
  );
}
