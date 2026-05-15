import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  TriageStrictnessSlider,
  type TriageStrictnessSliderLabels,
} from "@/components/triage/strictness-slider";
import { STRICTNESS_STOPS } from "@/lib/triage/strictness/stops";

const LABELS: TriageStrictnessSliderLabels = {
  legend: "Strictness",
  hint: "Hint",
  allStopHint: "All-stop tooltip",
  stops: {
    all: "All",
    top80: "Top 80%",
    top50: "Top 50%",
    top20: "Top 20%",
    top5: "Top 5%",
  },
};

describe("TriageStrictnessSlider", () => {
  it("renders one radio per stop with the selected one checked", () => {
    render(
      <TriageStrictnessSlider
        stop="top50"
        onChange={() => undefined}
        labels={LABELS}
      />,
    );
    for (const stop of STRICTNESS_STOPS) {
      const radio = screen.getByRole("radio", {
        name: LABELS.stops[stop.id],
      }) as HTMLInputElement;
      expect(radio.checked).toBe(stop.id === "top50");
    }
  });

  it("fires onChange with the picked stop id", () => {
    const onChange = vi.fn();
    render(
      <TriageStrictnessSlider
        stop="top50"
        onChange={onChange}
        labels={LABELS}
      />,
    );
    fireEvent.click(screen.getByRole("radio", { name: "Top 5%" }));
    expect(onChange).toHaveBeenCalledWith("top5");
  });

  it("does not fire onChange when the already-selected stop is clicked", () => {
    const onChange = vi.fn();
    render(
      <TriageStrictnessSlider
        stop="top50"
        onChange={onChange}
        labels={LABELS}
      />,
    );
    fireEvent.click(screen.getByRole("radio", { name: "Top 50%" }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("disables unselected stops while pending so a second click cannot stack a re-fetch", () => {
    render(
      <TriageStrictnessSlider
        stop="top50"
        onChange={() => undefined}
        pending
        labels={LABELS}
      />,
    );
    const selected = screen.getByRole("radio", {
      name: "Top 50%",
    }) as HTMLInputElement;
    const other = screen.getByRole("radio", {
      name: "Top 5%",
    }) as HTMLInputElement;
    expect(selected.disabled).toBe(false);
    expect(other.disabled).toBe(true);
  });

  it("attaches the All-stop tooltip to the All label only", () => {
    render(
      <TriageStrictnessSlider
        stop="top50"
        onChange={() => undefined}
        labels={LABELS}
      />,
    );
    const allLabel = screen.getByText("All").closest("label");
    const top5Label = screen.getByText("Top 5%").closest("label");
    expect(allLabel?.getAttribute("title")).toBe(LABELS.allStopHint);
    expect(top5Label?.getAttribute("title")).toBeNull();
  });
});
