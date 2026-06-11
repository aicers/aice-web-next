"use client";

import { useCallback, useTransition } from "react";

import { useScopeFingerprint } from "@/components/providers/scope-fingerprint-provider";
import { useRouter } from "@/i18n/navigation";
import { resolveDetectionReturnHref } from "@/lib/detection/last-detection-url";

export interface DetectionReturnNav {
  /** Click handler for the sidebar / mobile Detection nav link. */
  onClick: React.MouseEventHandler<HTMLAnchorElement>;
  /**
   * `true` from the instant the link is clicked until the Detection
   * route commits. Callers reflect it as pending styling on the nav
   * item so the click registers visibly even though the SSR query
   * blocks the page swap.
   */
  isPending: boolean;
}

/**
 * Click handler + pending flag for the sidebar / mobile Detection nav
 * link (#668, pending feedback #751).
 *
 * The bare `/detection` href drops the active tab's `?f=...&tab=...`
 * query string, so an SPA return rebuilds a fresh default tab and the
 * operator's previous results vanish. This intercepts a plain
 * left-click and routes to the last Detection URL stored for the
 * current scope, restoring the active tab + results via the same SSR
 * path a full reload (F5) already uses.
 *
 * #751: the navigation runs inside a `useTransition` so `isPending`
 * stays `true` while the Detection page's blocking SSR query is in
 * flight — the nav item can light up immediately on click instead of
 * waiting for navigation to commit. The plain left-click is ALWAYS
 * intercepted (routing to the stored URL when present, otherwise the
 * bare `/detection`) so the bare-route path gets pending feedback too;
 * without this, the no-stored-URL case would fall through to the
 * default `<Link>` navigation and show nothing.
 *
 * Modifier-clicks (open-in-new-tab), middle-clicks, and already-handled
 * events still fall through to default `<Link>` behavior.
 */
export function useDetectionReturnNav(): DetectionReturnNav {
  const router = useRouter();
  const scopeFingerprint = useScopeFingerprint();
  const [isPending, startTransition] = useTransition();

  const onClick = useCallback(
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
      event.preventDefault();
      const href = resolveDetectionReturnHref(scopeFingerprint) ?? "/detection";
      startTransition(() => {
        router.push(href);
      });
    },
    [router, scopeFingerprint],
  );

  return { onClick, isPending };
}
