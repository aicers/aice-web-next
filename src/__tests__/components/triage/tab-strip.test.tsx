import { describe, expect, it } from "vitest";

import { tabsForMode } from "@/components/triage/tab-strip";

/**
 * #490 acceptance: "/triage menu in Baseline mode shows three peer
 * views: Asset list, Stories, Pivot. In 'With my policies' mode the
 * Stories tab is hidden from the tab strip entirely (not rendered as
 * disabled or empty). A test asserts both modes' tab strip composition."
 */
describe("tabsForMode — Stories tab visibility per mode", () => {
  it("includes Stories between Asset list and Pivot in baseline mode", () => {
    expect(tabsForMode("baseline")).toEqual(["asset-list", "stories", "pivot"]);
  });

  it("omits Stories entirely in policies mode (corpus B has no event_group rows)", () => {
    const tabs = tabsForMode("policies");
    expect(tabs).toEqual(["asset-list", "pivot"]);
    expect(tabs).not.toContain("stories");
  });
});
