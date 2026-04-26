import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  RecommendedFiltersRail,
  type RecommendedFiltersRailLabels,
} from "@/components/detection/recommended-filters-rail";
import type { RecommendedPreset } from "@/lib/detection/recommended-filters";

function labels(
  overrides: Partial<RecommendedFiltersRailLabels> = {},
): RecommendedFiltersRailLabels {
  return {
    title: "Recommended Filter",
    emptyHint: "No recommended filters configured.",
    presetName: (preset) => `name:${preset.id}`,
    ...overrides,
  };
}

const samplePresets: readonly RecommendedPreset[] = [
  { id: "p-1", nameKey: "first", period: "1y" },
  { id: "p-2", nameKey: "second", period: "3y" },
];

/**
 * Walk the React element tree returned by calling the function
 * component directly and collect every intrinsic `<button>` element.
 * The repo runs Vitest without a DOM environment, so we do not have
 * `@testing-library/react`-style rendering — invoking the component
 * function gives us back the JSX tree, which is a plain
 * `ReactElement` graph we can traverse synchronously.
 */
function collectButtons(node: ReactNode): ReactElement[] {
  const out: ReactElement[] = [];
  function walk(n: ReactNode): void {
    if (Array.isArray(n)) {
      n.forEach(walk);
      return;
    }
    if (!isValidElement(n)) return;
    if (n.type === "button") {
      out.push(n);
    }
    const children = (n.props as { children?: ReactNode }).children;
    Children.forEach(children, walk);
  }
  walk(node);
  return out;
}

describe("RecommendedFiltersRail rendering", () => {
  it("renders one button per preset using the localized name and section aria-label", () => {
    const html = renderToStaticMarkup(
      <RecommendedFiltersRail
        presets={samplePresets}
        labels={labels()}
        onActivate={() => {}}
      />,
    );
    expect(html).toContain('aria-label="Recommended Filter"');
    expect(html).toContain('data-preset-id="p-1"');
    expect(html).toContain('data-preset-id="p-2"');
    expect(html).toContain(">name:p-1<");
    expect(html).toContain(">name:p-2<");
  });

  it("renders the empty hint when no presets are configured", () => {
    const html = renderToStaticMarkup(
      <RecommendedFiltersRail
        presets={[]}
        labels={labels()}
        onActivate={() => {}}
      />,
    );
    expect(html).toContain("No recommended filters configured.");
    expect(html).not.toContain("data-preset-id");
  });
});

describe("RecommendedFiltersRail click wiring", () => {
  // Reviewer Round 1: the prior tests asserted on either static HTML
  // (which strips `onClick`) or invoked the component's `onActivate`
  // prop directly — both would still pass if the rendered button
  // stopped firing `onActivate(preset)` on click. Walk the rendered
  // tree, fish out the actual `<button>` elements, and invoke their
  // own `onClick` handlers so a regression in the per-button
  // closure binding fails this test.
  it("invokes onActivate with the matching preset when each rendered button's onClick fires", () => {
    const onActivate = vi.fn<(preset: RecommendedPreset) => void>();
    const tree = RecommendedFiltersRail({
      presets: samplePresets,
      labels: labels(),
      onActivate,
    });
    const buttons = collectButtons(tree);
    expect(buttons).toHaveLength(samplePresets.length);
    buttons.forEach((button) => {
      const props = button.props as {
        onClick?: () => void;
        "data-preset-id"?: string;
      };
      expect(typeof props.onClick).toBe("function");
      props.onClick?.();
    });
    expect(onActivate).toHaveBeenCalledTimes(samplePresets.length);
    samplePresets.forEach((preset, index) => {
      expect(onActivate).toHaveBeenNthCalledWith(index + 1, preset);
    });
  });

  it("binds each button's onClick to its own preset (not a shared closure)", () => {
    // Regression guard for the easy mistake of mapping every button
    // to a shared handler that captures the loop's last preset. We
    // click the buttons out of order to make a shared-closure bug
    // visible: a shared handler would dispatch the same preset for
    // every click, while the correct binding dispatches the preset
    // tied to whichever button fires.
    const calls: string[] = [];
    const tree = RecommendedFiltersRail({
      presets: samplePresets,
      labels: labels(),
      onActivate: (preset) => calls.push(preset.id),
    });
    const buttons = collectButtons(tree);
    [buttons[1], buttons[0], buttons[1]].forEach((button) => {
      if (!button) throw new Error("missing button");
      const onClick = (button.props as { onClick?: () => void }).onClick;
      onClick?.();
    });
    expect(calls).toEqual(["p-2", "p-1", "p-2"]);
  });
});
