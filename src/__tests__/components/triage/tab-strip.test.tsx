import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  TriageTabStrip,
  type TriageTabStripLabels,
  tabsForMode,
} from "@/components/triage/tab-strip";

const LABELS: TriageTabStripLabels = {
  legend: "Triage views",
  assetList: "Asset list",
  stories: "Threat story",
  pivot: "Pivot",
  descriptions: {
    assetList: "Source assets ranked by score, highest first.",
    stories: "Correlated events grouped into a single threat story.",
    pivot: "Follow events that share an attribute with the selected asset.",
  },
};

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

/**
 * #719 acceptance: "Each Triage tab shows its one-line description
 * beneath the active tab." The caption reflects the active tab and
 * updates when the analyst switches tabs.
 */
describe("TriageTabStrip — active-tab description caption", () => {
  it("renders the active tab's description beneath the tablist", () => {
    render(
      <TriageTabStrip
        tab="asset-list"
        mode="baseline"
        onChange={vi.fn()}
        labels={LABELS}
      />,
    );
    expect(
      screen.getByText("Source assets ranked by score, highest first."),
    ).toBeTruthy();
    expect(
      screen.queryByText(
        "Correlated events grouped into a single threat story.",
      ),
    ).toBeNull();
  });

  it("shows the description for whichever tab is active", () => {
    render(
      <TriageTabStrip
        tab="pivot"
        mode="baseline"
        onChange={vi.fn()}
        labels={LABELS}
      />,
    );
    expect(
      screen.getByText(
        "Follow events that share an attribute with the selected asset.",
      ),
    ).toBeTruthy();
  });

  it("invokes onChange when a non-active tab is clicked", () => {
    const onChange = vi.fn();
    render(
      <TriageTabStrip
        tab="asset-list"
        mode="baseline"
        onChange={onChange}
        labels={LABELS}
      />,
    );
    fireEvent.click(screen.getByTestId("triage-tab-stories"));
    expect(onChange).toHaveBeenCalledWith("stories");
  });
});
