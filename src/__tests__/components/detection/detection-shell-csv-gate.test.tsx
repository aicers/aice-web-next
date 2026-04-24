import { createElement, useState } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { useCsvExportTotalCountGetter } from "@/components/detection/use-render-synced-ref";

/**
 * Reviewer Round 12: `useCsvExport.start()` reads
 * `getKnownTotalCount()` at click time, so the total-count value
 * threaded into the hook must be in lockstep with the header the
 * operator is looking at. `DetectionShell` owns that wiring
 * through `useCsvExportTotalCountGetter`, which combines the
 * render-synced ref and the stable lazy getter into a single
 * helper so the shell's `useCsvExport({ getKnownTotalCount })`
 * call and this test exercise the exact same production code.
 *
 * Reviewer Round 14: driving `useRenderSyncedRef` alone left the
 * test attached to the inner primitive rather than the shell
 * boundary — a regression that swapped the shell back to
 * `useRef(totalCount)` would not fail here. Importing
 * `useCsvExportTotalCountGetter` (the exact symbol the shell
 * wires into `useCsvExport`) attaches the assertion to the
 * production wiring: a shell edit that stops using this helper
 * would have to re-implement the render-time sync inline, and a
 * regression *inside* this helper fails the test directly.
 *
 * SSR never flushes `useEffect`, so `renderToString` is a
 * convenient microscope for this exact race: the render-phase
 * state update below forces a second render within the same
 * commit. With render-time ref sync, the second render's
 * assignment lands before the render returns and the captured
 * getter observes the fresh value. If someone moves the sync
 * into a `useEffect`, the effect never flushes in SSR and the
 * assertion fires with the stale value. A traditional DOM-based
 * test would need `@testing-library/react`, which this repo does
 * not ship.
 */

type Harness = {
  current: () => string | null;
};

function ExportGatePattern({ harness }: { harness: Harness }) {
  const [totalCount, setTotalCount] = useState<string | null>("500");
  // Drive the exact helper the shell wires into `useCsvExport`.
  const getKnownTotalCount = useCsvExportTotalCountGetter(totalCount);
  harness.current = getKnownTotalCount;
  // Force a render-phase state update so this render commits with
  // `totalCount === "150000"`. Matches "query just resolved; new
  // totalCount has landed in state" on the shell.
  if (totalCount === "500") {
    setTotalCount("150000");
  }
  return createElement("output", null, `count=${getKnownTotalCount()}`);
}

describe("DetectionShell CSV export — stale-count guard", () => {
  it("useCsvExportTotalCountGetter syncs during render so a click before effect flush reads the fresh count", () => {
    const harness: Harness = { current: () => null };
    const html = renderToString(createElement(ExportGatePattern, { harness }));
    // Render-time ref sync means the same commit observes the
    // post-refresh count without waiting on a passive effect.
    // An effect-based sync would leave the output at "count=500"
    // and the captured getter returning "500" — the exact
    // stale-count window Round 12 flagged.
    expect(html).toContain("count=150000");
    expect(harness.current()).toBe("150000");
  });
});
