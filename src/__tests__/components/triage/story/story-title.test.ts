/**
 * Direct coverage for the Story title formatter — the renderer code
 * paths are exercised through {@link "./stories-view.test.tsx"}; this
 * file pins the minute/hour duration math that the renderer relies on.
 */

import { describe, expect, it } from "vitest";

import {
  autoStoryTitle,
  type StoryDurationLabels,
} from "@/components/triage/story/story-title";
import type { StorySummaryPayload } from "@/lib/triage/story/types";

const DURATION_EN: StoryDurationLabels = {
  lessThanMinute: "< 1 min",
  minutesTemplate: "{n} min",
  hoursTemplate: "{n} h",
  hoursMinutesTemplate: "{h} h {m} min",
};

const DURATION_KO: StoryDurationLabels = {
  lessThanMinute: "1분 미만",
  minutesTemplate: "{n}분",
  hoursTemplate: "{n}시간",
  hoursMinutesTemplate: "{h}시간 {m}분",
};

function payload(durationMs: number): StorySummaryPayload {
  return {
    durationMs,
    memberCount: 1,
    distinctAssetCount: 1,
    topRawScore: 0,
    kindHistogram: {},
    categoryHistogram: {},
  };
}

describe("formatDuration — minute overflow guard", () => {
  // Regression for Round 4 Item 2: the prior implementation floored
  // hours and rounded the remaining minutes independently, so a Story
  // lasting 1h59m40s rendered "1 h 60 min" (and "1시간 60분" in KO)
  // instead of normalizing the carry into the next hour.
  it("normalizes a 1h59m40s duration to '2 h' rather than '1 h 60 min'", () => {
    const ms = 60 * 60 * 1000 + 59 * 60 * 1000 + 40 * 1000;
    const en = autoStoryTitle("10.0.0.1", payload(ms), DURATION_EN);
    expect(en).toBe("10.0.0.1 · 2 h · —");
    const ko = autoStoryTitle("10.0.0.1", payload(ms), DURATION_KO);
    expect(ko).toBe("10.0.0.1 · 2시간 · —");
  });

  it("renders a 1h30m duration as '1 h 30 min'", () => {
    const ms = 90 * 60 * 1000;
    expect(autoStoryTitle("10.0.0.1", payload(ms), DURATION_EN)).toBe(
      "10.0.0.1 · 1 h 30 min · —",
    );
  });

  it("renders a 59m30s duration as '1 h' once the carry lifts it past the hour boundary", () => {
    // 59m30s rounds to 60 minutes; the 60-minute total normalizes to
    // 1 hour with zero leftover minutes, so the title uses the
    // hours-only template instead of "60 min".
    const ms = 59 * 60 * 1000 + 30 * 1000;
    expect(autoStoryTitle("10.0.0.1", payload(ms), DURATION_EN)).toBe(
      "10.0.0.1 · 1 h · —",
    );
  });

  it("keeps sub-minute durations on the 'less than a minute' branch", () => {
    expect(autoStoryTitle("10.0.0.1", payload(30 * 1000), DURATION_EN)).toBe(
      "10.0.0.1 · < 1 min · —",
    );
  });
});
