"use client";

import {
  createContext,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useContext,
  useEffect,
  useState,
} from "react";

import { usePathname } from "@/i18n/navigation";

/**
 * A meaningful label for the active dynamic breadcrumb segment, keyed
 * by the pathname it was registered for. Keying by pathname lets the
 * consumer ignore a stale override left behind by a previous page and
 * lets a registrar's cleanup compare-and-clear without wiping the next
 * page's label during a route transition.
 */
interface BreadcrumbLabelOverride {
  /** Locale-stripped pathname this label applies to. */
  pathname: string;
  /** The rendered label for the last (dynamic) segment. */
  label: string;
}

interface BreadcrumbLabelContextValue {
  override: BreadcrumbLabelOverride | null;
  setOverride: Dispatch<SetStateAction<BreadcrumbLabelOverride | null>>;
}

const BreadcrumbLabelContext = createContext<BreadcrumbLabelContextValue>({
  override: null,
  setOverride: () => {},
});

/** Read the active dynamic-segment label override (or `null`). */
export function useBreadcrumbLabel(): BreadcrumbLabelOverride | null {
  return useContext(BreadcrumbLabelContext).override;
}

/**
 * Register a meaningful label for the current page's dynamic breadcrumb
 * segment. The label is keyed by the active pathname so a route
 * transition cannot leave a stale value, and cleanup is
 * compare-and-clear: it drops the override only when the stored value
 * is still the one this page published, so the next page's label
 * (which may mount before this page's effect cleanup runs) survives.
 *
 * Passing `null`/empty registers nothing — the breadcrumb then shows
 * the static fallback for the dynamic child.
 */
export function useRegisterBreadcrumbLabel(label: string | null): void {
  const { setOverride } = useContext(BreadcrumbLabelContext);
  const pathname = usePathname();

  useEffect(() => {
    if (!label) return;
    setOverride({ pathname, label });
    return () => {
      setOverride((prev) => (prev?.pathname === pathname ? null : prev));
    };
  }, [label, pathname, setOverride]);
}

export function BreadcrumbLabelProvider({ children }: { children: ReactNode }) {
  const [override, setOverride] = useState<BreadcrumbLabelOverride | null>(
    null,
  );

  return (
    <BreadcrumbLabelContext.Provider value={{ override, setOverride }}>
      {children}
    </BreadcrumbLabelContext.Provider>
  );
}
