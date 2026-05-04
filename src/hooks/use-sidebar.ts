"use client";

import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "sidebar-collapsed";
const COOKIE_KEY = "sidebar-collapsed";
// 1 year — long enough that the operator's choice survives normal sessions
// without committing to "forever."
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

interface UseSidebarOptions {
  initialCollapsed?: boolean;
  hasCookie?: boolean;
}

function writeCookie(value: boolean): void {
  if (typeof document === "undefined") return;
  // biome-ignore lint/suspicious/noDocumentCookie: Cookie Store API not universally supported
  document.cookie = `${COOKIE_KEY}=${value ? "true" : "false"}; path=/; max-age=${COOKIE_MAX_AGE_SECONDS}; samesite=lax`;
}

function persist(value: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(value));
  } catch {
    // localStorage may be unavailable (private mode, quota); the cookie
    // still carries the preference forward.
  }
  writeCookie(value);
}

export function useSidebar(options: UseSidebarOptions = {}) {
  const { initialCollapsed = false, hasCookie = false } = options;
  const [collapsed, setCollapsed] = useState(initialCollapsed);

  useEffect(() => {
    // Cookie is authoritative when present — server already rendered with
    // initialCollapsed, so skip the localStorage fallback to avoid an
    // unnecessary state flip.
    if (hasCookie) return;
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "true") {
      setCollapsed(true);
    }
  }, [hasCookie]);

  const toggle = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      persist(next);
      return next;
    });
  }, []);

  const collapse = useCallback(() => {
    setCollapsed(true);
    persist(true);
  }, []);

  const expand = useCallback(() => {
    setCollapsed(false);
    persist(false);
  }, []);

  return { collapsed, toggle, collapse, expand } as const;
}
