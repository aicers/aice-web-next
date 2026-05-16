import { describe, expect, it } from "vitest";

import {
  type BaselineRefreshEvent,
  buildBaselineRefreshPayloads,
  buildStoryRefreshPayloads,
  PHASE2_REFRESH_PAYLOAD_MAX_BYTES,
  type StoryRefreshItem,
} from "@/lib/aimer/phase2/payload-builders";

function makeBaselineEvent(
  i: number,
  eventTime: string,
  padBytes = 0,
): BaselineRefreshEvent {
  return {
    event_key: String(1_000_000_000 + i),
    event_time: eventTime,
    kind: "http",
    sensor: "s1",
    baseline_version: "v1",
    exclusions_fp: "fp",
    payload_summary: padBytes > 0 ? "x".repeat(padBytes) : null,
  };
}

function makeStory(i: number, end: string, padBytes = 0): StoryRefreshItem {
  return {
    story_id: String(2_000_000 + i),
    story_version: "v1",
    kind: "auto_correlated",
    members: [{ event_key: String(3_000_000 + i), role: "primary" }],
    time_window_end: end,
    time_window_start: end,
    summary_payload: padBytes > 0 ? "y".repeat(padBytes) : null,
  };
}

describe("phase2 payload builders", () => {
  it("exposes the provisional 1 MiB byte budget", () => {
    expect(PHASE2_REFRESH_PAYLOAD_MAX_BYTES).toBe(1 * 1024 * 1024);
  });

  describe("buildBaselineRefreshPayloads", () => {
    it("emits one empty notice covering the parent window when events[] is empty", () => {
      const { payloads, warnings } = buildBaselineRefreshPayloads({
        window: {
          from: "2026-01-01T00:00:00.000Z",
          to: "2026-01-02T00:00:00.000Z",
        },
        baselineVersion: "v1",
        events: [],
      });
      expect(payloads).toHaveLength(1);
      expect(payloads[0].window).toEqual({
        kind: "baseline_event",
        from: "2026-01-01T00:00:00.000Z",
        to: "2026-01-02T00:00:00.000Z",
      });
      expect(payloads[0].events).toEqual([]);
      expect(warnings).toEqual([]);
    });

    it("packs all rows into one sub-window when the serialized JSON fits the budget", () => {
      const events = [
        makeBaselineEvent(1, "2026-01-01T00:00:00.000Z"),
        makeBaselineEvent(2, "2026-01-01T00:01:00.000Z"),
        makeBaselineEvent(3, "2026-01-01T00:02:00.000Z"),
      ];
      const { payloads, warnings } = buildBaselineRefreshPayloads({
        window: {
          from: "2026-01-01T00:00:00.000Z",
          to: "2026-01-01T01:00:00.000Z",
        },
        baselineVersion: "v1",
        events,
      });
      expect(payloads).toHaveLength(1);
      expect(payloads[0].events).toHaveLength(3);
      expect(payloads[0].baseline_version).toBe("v1");
      expect(warnings).toEqual([]);
    });

    it("sub-divides into adjacent non-overlapping windows when the payload exceeds the budget", () => {
      // Each event padded to ~600 bytes; a 4-event tight budget forces
      // a split halfway.
      const events = [
        makeBaselineEvent(1, "2026-01-01T00:00:00.000Z", 600),
        makeBaselineEvent(2, "2026-01-01T00:01:00.000Z", 600),
        makeBaselineEvent(3, "2026-01-01T00:02:00.000Z", 600),
        makeBaselineEvent(4, "2026-01-01T00:03:00.000Z", 600),
      ];
      const { payloads } = buildBaselineRefreshPayloads({
        window: {
          from: "2026-01-01T00:00:00.000Z",
          to: "2026-01-01T01:00:00.000Z",
        },
        baselineVersion: "v1",
        events,
        maxBytes: 1500,
      });
      expect(payloads.length).toBeGreaterThanOrEqual(2);
      // Adjacent + non-overlapping by construction.
      expect(payloads[0].window.from).toBe("2026-01-01T00:00:00.000Z");
      expect(payloads[payloads.length - 1].window.to).toBe(
        "2026-01-01T01:00:00.000Z",
      );
      for (let i = 1; i < payloads.length; i += 1) {
        expect(payloads[i].window.from).toBe(payloads[i - 1].window.to);
      }
      // Every event accounted for exactly once.
      const totalEvents = payloads.reduce((sum, p) => sum + p.events.length, 0);
      expect(totalEvents).toBe(4);
    });

    it("never splits rows that share the same event_time", () => {
      const events = [
        makeBaselineEvent(1, "2026-01-01T00:00:00.000Z", 600),
        // Three rows share the same slice value — atomicity rule keeps
        // them in the same sub-window even at a tight budget.
        makeBaselineEvent(2, "2026-01-01T00:01:00.000Z", 600),
        makeBaselineEvent(3, "2026-01-01T00:01:00.000Z", 600),
        makeBaselineEvent(4, "2026-01-01T00:01:00.000Z", 600),
        makeBaselineEvent(5, "2026-01-01T00:02:00.000Z", 600),
      ];
      const { payloads } = buildBaselineRefreshPayloads({
        window: {
          from: "2026-01-01T00:00:00.000Z",
          to: "2026-01-01T01:00:00.000Z",
        },
        baselineVersion: "v1",
        events,
        maxBytes: 2500,
      });
      // The three same-time rows MUST all land in the same sub-window.
      const groupSliceCount = payloads.filter((p) =>
        p.events.some((e) => e.event_time === "2026-01-01T00:01:00.000Z"),
      );
      expect(groupSliceCount).toHaveLength(1);
      const sameTimeCount = groupSliceCount[0].events.filter(
        (e) => e.event_time === "2026-01-01T00:01:00.000Z",
      );
      expect(sameTimeCount).toHaveLength(3);
    });

    it("emits an oversize single-group sub-window with a warning", () => {
      // Two rows sharing the same event_time, each ~3000 bytes, with
      // maxBytes=1000 the group is unavoidably oversized.
      const events = [
        makeBaselineEvent(1, "2026-01-01T00:00:00.000Z", 3000),
        makeBaselineEvent(2, "2026-01-01T00:00:00.000Z", 3000),
      ];
      const { payloads, warnings } = buildBaselineRefreshPayloads({
        window: {
          from: "2026-01-01T00:00:00.000Z",
          to: "2026-01-01T01:00:00.000Z",
        },
        baselineVersion: "v1",
        events,
        maxBytes: 1000,
      });
      // Exactly one over-budget sub-window holds the two rows.
      const groupWindow = payloads.find((p) => p.events.length === 2);
      expect(groupWindow).toBeDefined();
      expect(warnings.length).toBeGreaterThanOrEqual(1);
      expect(warnings[0].sliceValue).toBe("2026-01-01T00:00:00.000Z");
      expect(warnings[0].rowCount).toBe(2);
    });

    it("warns when an oversize same-slice group lands in the middle of a window", () => {
      // Layout: small group A, then an oversize same-slice group B,
      // then small group C. The accumulator first packs A, closes at
      // B, then is forced to close B alone before reaching C. The
      // close-and-restart path must surface the warning for B.
      const events = [
        makeBaselineEvent(1, "2026-01-01T00:00:00.000Z", 200),
        makeBaselineEvent(2, "2026-01-01T00:01:00.000Z", 3000),
        makeBaselineEvent(3, "2026-01-01T00:01:00.000Z", 3000),
        makeBaselineEvent(4, "2026-01-01T00:02:00.000Z", 200),
      ];
      const { payloads, warnings } = buildBaselineRefreshPayloads({
        window: {
          from: "2026-01-01T00:00:00.000Z",
          to: "2026-01-01T01:00:00.000Z",
        },
        baselineVersion: "v1",
        events,
        maxBytes: 1500,
      });
      const oversizeWindow = payloads.find((p) =>
        p.events.some((e) => e.event_time === "2026-01-01T00:01:00.000Z"),
      );
      expect(oversizeWindow?.events).toHaveLength(2);
      const matchingWarning = warnings.find(
        (w) => w.sliceValue === "2026-01-01T00:01:00.000Z",
      );
      expect(matchingWarning).toBeDefined();
      expect(matchingWarning?.rowCount).toBe(2);
    });

    it("warns when an oversize same-slice group lands at the end of a window", () => {
      // Small group at the start, then an oversize group as the final
      // group. The final-close path must also surface the warning.
      const events = [
        makeBaselineEvent(1, "2026-01-01T00:00:00.000Z", 200),
        makeBaselineEvent(2, "2026-01-01T00:01:00.000Z", 3000),
        makeBaselineEvent(3, "2026-01-01T00:01:00.000Z", 3000),
      ];
      const { warnings } = buildBaselineRefreshPayloads({
        window: {
          from: "2026-01-01T00:00:00.000Z",
          to: "2026-01-01T01:00:00.000Z",
        },
        baselineVersion: "v1",
        events,
        maxBytes: 1500,
      });
      const matchingWarning = warnings.find(
        (w) => w.sliceValue === "2026-01-01T00:01:00.000Z",
      );
      expect(matchingWarning).toBeDefined();
      expect(matchingWarning?.rowCount).toBe(2);
    });
  });

  describe("buildStoryRefreshPayloads", () => {
    it("emits one empty notice when stories[] is empty", () => {
      const { payloads } = buildStoryRefreshPayloads({
        window: {
          from: "2026-01-01T00:00:00.000Z",
          to: "2026-01-02T00:00:00.000Z",
        },
        stories: [],
      });
      expect(payloads).toHaveLength(1);
      expect(payloads[0].window.kind).toBe("story");
      expect(payloads[0].stories).toEqual([]);
    });

    it("slices on time_window_end and keeps same-end stories together", () => {
      const stories = [
        makeStory(1, "2026-01-01T00:00:00.000Z", 500),
        makeStory(2, "2026-01-01T00:01:00.000Z", 500),
        makeStory(3, "2026-01-01T00:01:00.000Z", 500),
        makeStory(4, "2026-01-01T00:02:00.000Z", 500),
      ];
      const { payloads } = buildStoryRefreshPayloads({
        window: {
          from: "2026-01-01T00:00:00.000Z",
          to: "2026-01-01T01:00:00.000Z",
        },
        stories,
        maxBytes: 1500,
      });
      // Adjacency / boundary preserved.
      expect(payloads[0].window.from).toBe("2026-01-01T00:00:00.000Z");
      expect(payloads[payloads.length - 1].window.to).toBe(
        "2026-01-01T01:00:00.000Z",
      );
      // The two same-time stories land in one sub-window together.
      const groupSlice = payloads.find((p) =>
        p.stories.some((s) => s.time_window_end === "2026-01-01T00:01:00.000Z"),
      );
      expect(groupSlice).toBeDefined();
      const sameEnd = groupSlice?.stories.filter(
        (s) => s.time_window_end === "2026-01-01T00:01:00.000Z",
      );
      expect(sameEnd).toHaveLength(2);
    });
  });
});
