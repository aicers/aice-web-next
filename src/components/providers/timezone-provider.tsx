"use client";

import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from "react";

interface TimezoneContextValue {
  timezone: string;
}

const TimezoneContext = createContext<TimezoneContextValue>({
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
});

export function useTimezone(): string {
  return useContext(TimezoneContext).timezone;
}

export function TimezoneProvider({ children }: { children: ReactNode }) {
  const [timezone, setTimezone] = useState(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
  );

  useEffect(() => {
    let cancelled = false;
    fetch("/api/accounts/me/preferences")
      .then((res) => {
        if (!res.ok) return null;
        return res.json();
      })
      .then((data) => {
        if (cancelled) return;
        if (data?.data?.timezone) {
          setTimezone(data.data.timezone);
        }
      })
      .catch(() => {
        // Fallback to browser timezone — already set
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <TimezoneContext.Provider value={{ timezone }}>
      {children}
    </TimezoneContext.Provider>
  );
}
