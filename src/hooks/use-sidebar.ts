"use client";

import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "sidebar-collapsed";

export function useSidebar() {
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "true") {
      setCollapsed(true);
    }
  }, []);

  const toggle = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem(STORAGE_KEY, String(next));
      return next;
    });
  }, []);

  const collapse = useCallback(() => {
    setCollapsed(true);
    localStorage.setItem(STORAGE_KEY, "true");
  }, []);

  const expand = useCallback(() => {
    setCollapsed(false);
    localStorage.setItem(STORAGE_KEY, "false");
  }, []);

  return { collapsed, toggle, collapse, expand } as const;
}
