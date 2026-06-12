import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// `TriagePivotBreadcrumb` resolves `sameKindWithin15Min` crumb times
// through `useTimestampFormatter`, which reads the active locale via
// next-intl; mock it so the breadcrumb renders without a real
// `NextIntlClientProvider`.
vi.mock("next-intl", () => ({
  useLocale: () => "en",
  useTranslations: () => (key: string) => key,
}));

import { TriagePivotBreadcrumb } from "@/components/triage/pivot/pivot-breadcrumb";
import type { PivotDimensionId, PivotStep } from "@/lib/triage/pivot";

const LABELS = {
  ariaLabel: "Pivot trail",
  rootCrumbPrefix: "Asset",
  dimensionCrumbTemplate: "{dimension}: {value}",
  storyOriginTemplate: "Story #{id}",
  dimensions: new Proxy({} as Record<PivotDimensionId, string>, {
    get: (_t, id) => String(id),
  }),
};

describe("TriagePivotBreadcrumb — Story origin (#553)", () => {
  it("renders the Story-origin segment with the composite id", () => {
    render(
      <TriagePivotBreadcrumb
        trail={[
          {
            kind: "dimension",
            dimension: "host",
            value: { key: "example.com", label: "example.com" },
          },
        ]}
        origin={{ kind: "story", customerId: 42, storyId: "7" }}
        onSelect={() => {}}
        onSelectStoryOrigin={() => {}}
        labels={LABELS}
      />,
    );
    const seg = screen.getByTestId("triage-pivot-breadcrumb-story-origin");
    expect(seg.textContent).toBe("Story #42/7");
    // The Story segment is interactive because there is a dimension
    // step beyond it (the analyst can backtrack to the Story root).
    expect(seg.tagName).toBe("BUTTON");
    // …and the dimension crumb is current.
    const dimCrumb = screen.getByText("host: example.com");
    expect(dimCrumb.getAttribute("aria-current")).toBe("page");
  });

  it("renders the Story-origin segment as the current page when no dimensions are appended", () => {
    render(
      <TriagePivotBreadcrumb
        trail={[]}
        origin={{ kind: "story", customerId: 42, storyId: "7" }}
        onSelect={() => {}}
        onSelectStoryOrigin={() => {}}
        labels={LABELS}
      />,
    );
    const seg = screen.getByTestId("triage-pivot-breadcrumb-story-origin");
    expect(seg.getAttribute("aria-current")).toBe("page");
    expect(seg.tagName).toBe("SPAN");
  });

  it("fires onSelectStoryOrigin when the Story segment is clicked", () => {
    const spy = vi.fn();
    render(
      <TriagePivotBreadcrumb
        trail={[
          {
            kind: "dimension",
            dimension: "host",
            value: { key: "example.com", label: "example.com" },
          },
        ]}
        origin={{ kind: "story", customerId: 42, storyId: "7" }}
        onSelect={() => {}}
        onSelectStoryOrigin={spy}
        labels={LABELS}
      />,
    );
    fireEvent.click(screen.getByTestId("triage-pivot-breadcrumb-story-origin"));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("does NOT render a Story segment when origin is asset-rooted", () => {
    const trail: PivotStep[] = [
      { kind: "asset", customerId: 1, address: "10.0.0.1" },
    ];
    render(
      <TriagePivotBreadcrumb
        trail={trail}
        origin={{ kind: "asset" }}
        onSelect={() => {}}
        labels={LABELS}
      />,
    );
    expect(
      screen.queryByTestId("triage-pivot-breadcrumb-story-origin"),
    ).toBeNull();
    expect(screen.getByText("Asset 10.0.0.1").textContent).toBe(
      "Asset 10.0.0.1",
    );
  });
});

describe("TriagePivotBreadcrumb — sameKindWithin15Min crumb (#764 Part 3)", () => {
  it("renders the same-kind crumb time through the central compact formatter, never the raw ISO label", () => {
    const ms = Date.UTC(2026, 5, 12, 9, 30);
    const iso = new Date(ms).toISOString();
    render(
      <TriagePivotBreadcrumb
        trail={[
          {
            kind: "dimension",
            dimension: "sameKindWithin15Min",
            value: {
              key: `Conn@${ms}`,
              // The stored label embeds the raw `toISOString()` instant —
              // exactly what must NOT reach the breadcrumb.
              label: `Conn near ${iso}`,
            },
          },
        ]}
        origin={{ kind: "asset" }}
        onSelect={() => {}}
        labels={LABELS}
      />,
    );
    // Post-mount the crumb shows the localized compact instant…
    const crumb = screen.getByText(/^sameKindWithin15Min: Conn near /);
    expect(crumb.getAttribute("aria-current")).toBe("page");
    // …and never the raw UTC ISO string from the stored label.
    expect(crumb.textContent).not.toContain(iso);
    expect(crumb.textContent).not.toContain("T09:30");
  });
});
