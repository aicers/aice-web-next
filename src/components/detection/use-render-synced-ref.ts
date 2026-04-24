import { useCallback, useRef } from "react";

/**
 * Keeps a ref in lockstep with `value` by assigning during render
 * rather than in a passive `useEffect`. Callers read the ref
 * through a stable lazy getter (typically wrapped in `useCallback`)
 * so downstream hooks do not re-bind on every refresh.
 *
 * The render-time assignment matters for the CSV export gate:
 * `useCsvExport.start()` reads the latest total-count at click
 * time, and an effect-based sync would leave a one-commit window
 * where the rendered header already shows a new total but the ref
 * still carries the previous slice's count — a quick click on
 * Download CSV in that window bypasses the large-export
 * confirmation dialog.
 */
export function useRenderSyncedRef<T>(value: T): { current: T } {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

/**
 * Shell-level wiring for the CSV export's `getKnownTotalCount`
 * callback: keeps the latest `totalCount` in a render-synced ref
 * and returns a stable lazy getter so `useCsvExport`'s `start`
 * identity does not churn on every result refresh.
 *
 * Exported as a named helper (rather than inlined in
 * `DetectionShell`) so the regression test for the Round 12
 * stale-count race can import the same function the shell
 * imports. A regression that drops render-time sync here — or a
 * shell edit that bypasses this helper — leaves the test
 * exercising the exact callable the shell threads into
 * `useCsvExport`, not a local re-implementation.
 */
export function useCsvExportTotalCountGetter(
  value: string | null,
): () => string | null {
  const ref = useRenderSyncedRef(value);
  return useCallback(() => ref.current, [ref]);
}
