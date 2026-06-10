"use client";

import { useCallback, useState } from "react";

const COOKIE_KEY = "sidebar-collapsed";
// 1 year — long enough that the operator's choice survives normal sessions
// without committing to "forever."
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

interface UseSidebarOptions {
  initialCollapsed?: boolean;
}

function persist(value: boolean): void {
  if (typeof document === "undefined") return;
  // biome-ignore lint/suspicious/noDocumentCookie: Cookie Store API not universally supported
  document.cookie = `${COOKIE_KEY}=${value ? "true" : "false"}; path=/; max-age=${COOKIE_MAX_AGE_SECONDS}; samesite=lax`;
}

export function useSidebar(options: UseSidebarOptions = {}) {
  const { initialCollapsed = false } = options;
  const [collapsed, setCollapsed] = useState(initialCollapsed);

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
