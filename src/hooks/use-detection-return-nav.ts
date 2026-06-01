"use client";

import { useCallback } from "react";

import { useScopeFingerprint } from "@/components/providers/scope-fingerprint-provider";
import { useRouter } from "@/i18n/navigation";
import { resolveDetectionReturnHref } from "@/lib/detection/last-detection-url";

/**
 * Click handler for the sidebar / mobile Detection nav link (#668).
 *
 * The bare `/detection` href drops the active tab's `?f=...&tab=...`
 * query string, so an SPA return rebuilds a fresh default tab and the
 * operator's previous results vanish. This intercepts a plain
 * left-click and routes to the last Detection URL stored for the
 * current scope, restoring the active tab + results via the same SSR
 * path a full reload (F5) already uses.
 *
 * It only overrides when a valid scoped URL is stored; modifier-clicks
 * (open-in-new-tab), middle-clicks, and the missing / expired /
 * malformed / cross-scope cases all fall through to the bare
 * `/detection` default bootstrap.
 */
export function useDetectionReturnNav(): React.MouseEventHandler<HTMLAnchorElement> {
  const router = useRouter();
  const scopeFingerprint = useScopeFingerprint();

  return useCallback(
    (event: React.MouseEvent<HTMLAnchorElement>) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }
      const href = resolveDetectionReturnHref(scopeFingerprint);
      if (!href) return;
      event.preventDefault();
      router.push(href);
    },
    [router, scopeFingerprint],
  );
}
