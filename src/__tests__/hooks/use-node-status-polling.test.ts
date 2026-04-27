import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  __getNodeStatusSnapshot,
  __getNodeStatusStoreForTests,
  __pushNodeStatusSample,
  __resetNodeStatusStore,
  __setNodeStatusManagerUnreachable,
  __setNodeStatusStale,
  SPARKLINE_BUFFER_SIZE,
} from "@/hooks/use-node-status-polling";
import type { NodeStatus } from "@/lib/node/types";

function makeStatus(overrides: Partial<NodeStatus> = {}): NodeStatus {
  return {
    id: "n1",
    name: "alpha",
    nameDraft: null,
    profile: { customerId: "1", description: "", hostname: "alpha.lan" },
    profileDraft: null,
    cpuUsage: 12.5,
    totalMemory: "1024",
    usedMemory: "512",
    totalDiskSpace: "1024",
    usedDiskSpace: "256",
    manager: true,
    agents: [],
    externalServices: [],
    ping: 3.2,
    ...overrides,
  };
}

describe("useNodeStatusPolling — buffer behavior", () => {
  beforeEach(() => {
    __resetNodeStatusStore();
  });

  afterEach(() => {
    __resetNodeStatusStore();
  });

  it("records the capturedAt of an incoming sample and clears stale", () => {
    const t0 = new Date("2026-01-01T00:00:00Z");
    __pushNodeStatusSample(t0, [makeStatus()]);
    expect(__getNodeStatusSnapshot().capturedAt?.toISOString()).toBe(
      t0.toISOString(),
    );
    expect(__getNodeStatusSnapshot().isStale).toBe(false);
  });

  it("marks segmentBoundary=false when gap <= 2x pollIntervalMs", () => {
    const pollMs = 10_000;
    const t0 = new Date("2026-01-01T00:00:00Z");
    const t1 = new Date(t0.getTime() + pollMs); // gap = 10s, <= 2*pollMs
    __pushNodeStatusSample(t0, [makeStatus()], pollMs);
    __pushNodeStatusSample(t1, [makeStatus({ cpuUsage: 20 })], pollMs);

    const buf = __getNodeStatusStoreForTests().byNodeId.get("n1");
    expect(buf?.samples.length).toBe(2);
    expect(buf?.samples[0]?.segmentBoundary).toBe(false);
    expect(buf?.samples[1]?.segmentBoundary).toBe(false);
  });

  it("marks segmentBoundary=true when gap > 2x pollIntervalMs and keeps prior samples", () => {
    const pollMs = 10_000;
    const t0 = new Date("2026-01-01T00:00:00Z");
    const t1 = new Date(t0.getTime() + 5 * pollMs); // gap = 50s, well past 2x
    __pushNodeStatusSample(t0, [makeStatus()], pollMs);
    __pushNodeStatusSample(t1, [makeStatus({ cpuUsage: 70 })], pollMs);

    const buf = __getNodeStatusStoreForTests().byNodeId.get("n1");
    expect(buf?.samples.length).toBe(2);
    expect(buf?.samples[0]?.segmentBoundary).toBe(false);
    expect(buf?.samples[1]?.segmentBoundary).toBe(true);
    // Previous sample is preserved — only the visual segmenting differs.
    expect(buf?.samples[0]?.cpuUsage).toBe(12.5);
  });

  it("caps the rolling buffer at SPARKLINE_BUFFER_SIZE samples", () => {
    const pollMs = 1_000;
    const start = Date.UTC(2026, 0, 1);
    for (let i = 0; i < SPARKLINE_BUFFER_SIZE + 5; i += 1) {
      __pushNodeStatusSample(
        new Date(start + i * pollMs),
        [makeStatus({ cpuUsage: i })],
        pollMs,
      );
    }
    const buf = __getNodeStatusStoreForTests().byNodeId.get("n1");
    expect(buf?.samples.length).toBe(SPARKLINE_BUFFER_SIZE);
    // The earliest 5 samples were dropped, so the first remaining
    // sample has cpuUsage === 5.
    expect(buf?.samples[0]?.cpuUsage).toBe(5);
  });

  it("does NOT backfill missed samples after a long hidden window", () => {
    const pollMs = 10_000;
    const t0 = new Date("2026-01-01T00:00:00Z");
    // Five-minute hidden window — only the t0 sample exists when the
    // tab was visible, and the next sample lands at t0 + 5 min on
    // resume. The buffer must not contain any synthetic filler points
    // between them.
    const tResume = new Date(t0.getTime() + 5 * 60 * 1000);
    __pushNodeStatusSample(t0, [makeStatus()], pollMs);
    __pushNodeStatusSample(tResume, [makeStatus()], pollMs);

    const buf = __getNodeStatusStoreForTests().byNodeId.get("n1");
    expect(buf?.samples.length).toBe(2);
    // Resume sample crosses the 2x threshold so it carries
    // segmentBoundary: true, but no synthetic samples sit between it
    // and the previous sample.
    expect(buf?.samples[1]?.segmentBoundary).toBe(true);
  });

  it("marks nodes absent from a later snapshot via latest=null but preserves their sample history", () => {
    const t0 = new Date("2026-01-01T00:00:00Z");
    __pushNodeStatusSample(t0, [
      makeStatus({ id: "n1" }),
      makeStatus({ id: "n2" }),
    ]);
    expect(__getNodeStatusStoreForTests().byNodeId.size).toBe(2);

    const t1 = new Date(t0.getTime() + 10_000);
    __pushNodeStatusSample(t1, [makeStatus({ id: "n1" })]);
    // The map entry stays; only the `latest` snapshot is cleared so
    // consumers can drop the row from the visible table. The sample
    // history is preserved for honest gap detection on reappearance.
    expect(__getNodeStatusStoreForTests().byNodeId.size).toBe(2);
    const n2 = __getNodeStatusStoreForTests().byNodeId.get("n2");
    expect(n2?.latest).toBeNull();
    expect(n2?.samples.length).toBe(1);
    expect(n2?.lastSampleAt?.toISOString()).toBe(t0.toISOString());
  });

  it("an absent node that reappears flags segmentBoundary using the preserved lastSampleAt", () => {
    const pollMs = 10_000;
    const t0 = new Date("2026-01-01T00:00:00Z");
    // Initial poll: both nodes present.
    __pushNodeStatusSample(
      t0,
      [makeStatus({ id: "n1" }), makeStatus({ id: "n2", cpuUsage: 30 })],
      pollMs,
    );

    // Next poll one interval later: n2 is absent. Without buffer
    // preservation, n2's history would be deleted here and the
    // reappearance gap would be lost.
    const t1 = new Date(t0.getTime() + pollMs);
    __pushNodeStatusSample(t1, [makeStatus({ id: "n1" })], pollMs);

    // n2 reappears five intervals later — well past the 2x threshold.
    const t2 = new Date(t0.getTime() + 6 * pollMs);
    __pushNodeStatusSample(
      t2,
      [makeStatus({ id: "n1" }), makeStatus({ id: "n2", cpuUsage: 65 })],
      pollMs,
    );

    const n2 = __getNodeStatusStoreForTests().byNodeId.get("n2");
    // Pre-absence sample is still in the buffer ahead of the new
    // reappearance sample.
    expect(n2?.samples.length).toBe(2);
    expect(n2?.samples[0]?.capturedAt.toISOString()).toBe(t0.toISOString());
    expect(n2?.samples[0]?.cpuUsage).toBe(30);
    // The reappearance sample crosses the 2x threshold relative to
    // the preserved lastSampleAt at t0, so segmentBoundary is true.
    expect(n2?.samples[1]?.capturedAt.toISOString()).toBe(t2.toISOString());
    expect(n2?.samples[1]?.cpuUsage).toBe(65);
    expect(n2?.samples[1]?.segmentBoundary).toBe(true);
    // `latest` is restored on reappearance so the consumer can render
    // the row again.
    expect(n2?.latest?.id).toBe("n2");
  });

  it("an absent node that stays absent does not get a duplicate latest=null write", () => {
    const t0 = new Date("2026-01-01T00:00:00Z");
    __pushNodeStatusSample(t0, [
      makeStatus({ id: "n1" }),
      makeStatus({ id: "n2" }),
    ]);
    const t1 = new Date(t0.getTime() + 10_000);
    __pushNodeStatusSample(t1, [makeStatus({ id: "n1" })]);
    const firstAbsentBuf = __getNodeStatusStoreForTests().byNodeId.get("n2");

    const t2 = new Date(t0.getTime() + 20_000);
    __pushNodeStatusSample(t2, [makeStatus({ id: "n1" })]);
    const stillAbsentBuf = __getNodeStatusStoreForTests().byNodeId.get("n2");

    // Buffer entry must not churn while the node remains absent —
    // re-writing it on every poll would invalidate the
    // useSyncExternalStore equality reference for downstream selectors
    // and waste re-renders.
    expect(stillAbsentBuf).toBe(firstAbsentBuf);
    expect(stillAbsentBuf?.latest).toBeNull();
    expect(stillAbsentBuf?.samples.length).toBe(1);
  });

  it("a fresh sample after a stale window flips isStale back to false", () => {
    __setNodeStatusStale(true);
    expect(__getNodeStatusSnapshot().isStale).toBe(true);

    const t0 = new Date("2026-01-01T00:00:00Z");
    __pushNodeStatusSample(t0, [makeStatus()]);
    expect(__getNodeStatusSnapshot().isStale).toBe(false);
  });

  it("each sample carries a Date capturedAt for downstream freshness logic", () => {
    const t0 = new Date("2026-01-01T00:00:00Z");
    __pushNodeStatusSample(t0, [makeStatus()]);
    const buf = __getNodeStatusStoreForTests().byNodeId.get("n1");
    expect(buf?.samples[0]?.capturedAt).toBeInstanceOf(Date);
    expect(buf?.samples[0]?.capturedAt.toISOString()).toBe(t0.toISOString());
    expect(buf?.lastSampleAt?.toISOString()).toBe(t0.toISOString());
  });

  it("a successful sample clears isManagerUnreachable", () => {
    __setNodeStatusManagerUnreachable(true);
    expect(__getNodeStatusSnapshot().isManagerUnreachable).toBe(true);

    const t0 = new Date("2026-01-01T00:00:00Z");
    __pushNodeStatusSample(t0, [makeStatus()]);
    expect(__getNodeStatusSnapshot().isManagerUnreachable).toBe(false);
  });

  it("preserves segmentBoundary semantics across multiple ids in the same snapshot", () => {
    const pollMs = 10_000;
    const t0 = new Date("2026-01-01T00:00:00Z");
    const t1 = new Date(t0.getTime() + 5 * pollMs);
    __pushNodeStatusSample(
      t0,
      [makeStatus({ id: "n1" }), makeStatus({ id: "n2" })],
      pollMs,
    );
    __pushNodeStatusSample(
      t1,
      [makeStatus({ id: "n1" }), makeStatus({ id: "n2" })],
      pollMs,
    );

    const store = __getNodeStatusStoreForTests();
    expect(store.byNodeId.get("n1")?.samples[1]?.segmentBoundary).toBe(true);
    expect(store.byNodeId.get("n2")?.samples[1]?.segmentBoundary).toBe(true);
  });
});
