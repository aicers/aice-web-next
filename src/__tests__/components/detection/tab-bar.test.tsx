import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  TabBar,
  type TabBarLabels,
  type TabBarTab,
} from "@/components/detection/tab-bar";

function labels(): TabBarLabels {
  return {
    tablist: "Detection result tabs",
    newTab: "New tab",
    newTabAtCap: "Close a tab to open a new one (maximum 8 open).",
    closeTab: "Close tab",
    renameTab: "Rename tab",
    resetName: "Reset tab name",
  };
}

function tab(overrides: Partial<TabBarTab> = {}): TabBarTab {
  return {
    id: "tab-a",
    label: "Last 1h",
    isAuto: true,
    loading: false,
    ...overrides,
  };
}

const noop = () => {};

describe("TabBar rendering", () => {
  it("renders an active tab with aria-selected=true and an inactive sibling with aria-selected=false", () => {
    const html = renderToStaticMarkup(
      <TabBar
        tabs={[
          tab({ id: "a", label: "Last 1h" }),
          tab({ id: "b", label: "Source: 10.0.0.5" }),
        ]}
        activeTabId="a"
        canAddTab
        labels={labels()}
        onActivate={noop}
        onAddTab={noop}
        onCloseTab={noop}
        onRename={noop}
        onResetName={noop}
      />,
    );
    expect(html).toMatch(/aria-selected="true"[^>]*data-state="active"/);
    expect(html).toMatch(/aria-selected="false"[^>]*data-state="inactive"/);
    expect(html).toContain("Last 1h");
    expect(html).toContain("Source: 10.0.0.5");
  });

  it("renders the per-tab close affordance even when only one tab is present so the operator can trigger the auto-create-default flow", () => {
    const html = renderToStaticMarkup(
      <TabBar
        tabs={[tab()]}
        activeTabId="tab-a"
        canAddTab
        labels={labels()}
        onActivate={noop}
        onAddTab={noop}
        onCloseTab={noop}
        onRename={noop}
        onResetName={noop}
      />,
    );
    // Reviewer Round 1 (item 4): closing the last tab is part of the
    // accepted Detection-10 contract — the wrapper auto-seeds a
    // fresh default tab in its place. Hiding the × here made the
    // path unreachable from the UI.
    expect(html).toContain('aria-label="Close tab"');
  });

  it("disables the + affordance when canAddTab is false and surfaces the at-cap label", () => {
    const html = renderToStaticMarkup(
      <TabBar
        tabs={[tab(), tab({ id: "b" })]}
        activeTabId="tab-a"
        canAddTab={false}
        labels={labels()}
        onActivate={noop}
        onAddTab={noop}
        onCloseTab={noop}
        onRename={noop}
        onResetName={noop}
      />,
    );
    // The + button takes the at-cap label so the tooltip explains
    // why it's disabled.
    expect(html).toMatch(
      /aria-label="Close a tab to open a new one \(maximum 8 open\)\."[^>]*disabled/,
    );
  });

  it("renders the Reset name affordance only for manually-renamed tabs", () => {
    const html = renderToStaticMarkup(
      <TabBar
        tabs={[
          tab({ id: "auto", isAuto: true }),
          tab({ id: "manual", isAuto: false, label: "My tab" }),
        ]}
        activeTabId="auto"
        canAddTab
        labels={labels()}
        onActivate={noop}
        onAddTab={noop}
        onCloseTab={noop}
        onRename={noop}
        onResetName={noop}
      />,
    );
    const resetButtons = html.match(/aria-label="Reset tab name"/g);
    expect(resetButtons?.length ?? 0).toBe(1);
  });

  it("paints a loading dot on tabs whose committed query is in flight", () => {
    const html = renderToStaticMarkup(
      <TabBar
        tabs={[tab({ loading: true }), tab({ id: "b", loading: false })]}
        activeTabId="tab-a"
        canAddTab
        labels={labels()}
        onActivate={noop}
        onAddTab={noop}
        onCloseTab={noop}
        onRename={noop}
        onResetName={noop}
      />,
    );
    // The loading dot is the only `aria-hidden` span sibling on the
    // tab label; check by counting muted dots — exactly one tab is
    // loading in this fixture.
    const dots = html.match(/<span[^>]*rounded-full[^>]*>/g);
    expect(dots?.length ?? 0).toBe(1);
  });

  it("attaches the localized tablist label to the role=tablist container", () => {
    const html = renderToStaticMarkup(
      <TabBar
        tabs={[tab()]}
        activeTabId="tab-a"
        canAddTab
        labels={labels()}
        onActivate={noop}
        onAddTab={noop}
        onCloseTab={noop}
        onRename={noop}
        onResetName={noop}
      />,
    );
    expect(html).toMatch(
      /role="tablist"[^>]*aria-label="Detection result tabs"/,
    );
  });
});
