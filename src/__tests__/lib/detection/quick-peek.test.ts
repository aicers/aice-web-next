import { describe, expect, it } from "vitest";

import {
  type QuickPeekSelection,
  revalidateQuickPeekSelection,
} from "@/lib/detection/quick-peek";
import type { Event as DetectionEvent } from "@/lib/detection/types";

function event(overrides: Partial<DetectionEvent> = {}): DetectionEvent {
  return {
    __typename: "HttpThreat",
    time: "2026-04-22T00:00:00.000Z",
    sensor: "sensor-1",
    confidence: 0.8,
    category: null,
    level: "HIGH",
    triageScores: null,
    ...overrides,
  } as DetectionEvent;
}

describe("revalidateQuickPeekSelection", () => {
  it("returns null when nothing is selected", () => {
    expect(revalidateQuickPeekSelection(null, [event()], ["c-0"])).toBeNull();
  });

  it("preserves the selection when the cursor is still in the new slice", () => {
    const kept = event({ sensor: "sensor-1" });
    const selection: QuickPeekSelection = { event: kept, key: "c-0" };
    const result = revalidateQuickPeekSelection(
      selection,
      [kept, event({ sensor: "sensor-2" })],
      ["c-0", "c-1"],
    );
    // Same cursor, same payload reference — returns the same object
    // so downstream referential equality checks don't churn.
    expect(result).toBe(selection);
  });

  it("refreshes the event payload when the cursor moved to a new object", () => {
    const original = event({ sensor: "sensor-1", confidence: 0.5 });
    const refreshed = event({ sensor: "sensor-1", confidence: 0.9 });
    const selection: QuickPeekSelection = { event: original, key: "c-0" };
    const result = revalidateQuickPeekSelection(
      selection,
      [refreshed],
      ["c-0"],
    );
    expect(result).not.toBe(selection);
    expect(result?.key).toBe("c-0");
    expect(result?.event).toBe(refreshed);
  });

  it("clears the selection when the cursor is no longer in the result set", () => {
    const dropped = event({ sensor: "sensor-1" });
    const selection: QuickPeekSelection = { event: dropped, key: "c-0" };
    // The filter changed and the inspected event disappeared; only
    // a different cursor survives.
    const result = revalidateQuickPeekSelection(
      selection,
      [event({ sensor: "sensor-2" })],
      ["c-9"],
    );
    expect(result).toBeNull();
  });

  it("clears the selection when the result set goes empty (zero results / error branch)", () => {
    const selection: QuickPeekSelection = {
      event: event(),
      key: "c-0",
    };
    // Error path: the shell resets events/eventKeys to empty arrays.
    // The inspector must not stay open with the prior event visible.
    expect(revalidateQuickPeekSelection(selection, [], [])).toBeNull();
  });

  it("clears when the cursor array reports a hit but the parallel events slot is missing", () => {
    // Defensive against a partially-committed result set: the shell
    // keeps `events` and `eventKeys` parallel, but a bug anywhere in
    // that invariant should still close the inspector rather than
    // crash or leak a stale event.
    const selection: QuickPeekSelection = {
      event: event(),
      key: "c-0",
    };
    const sparse: DetectionEvent[] = [];
    const result = revalidateQuickPeekSelection(selection, sparse, ["c-0"]);
    expect(result).toBeNull();
  });
});
