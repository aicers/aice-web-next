/**
 * Render-level coverage for {@link SensorMultiSelect} (#278, Reviewer
 * Round 5).
 *
 * The companion `sensor-multi-select.test.ts` file mocks React + the
 * UI primitives so it can exercise the pure helpers without pulling
 * the JSX runtime in. That left the four state branches the issue
 * called out (`loading`, `error`, empty `ready`, populated `ready`)
 * un-rendered, which is exactly the gap Reviewer Round 5 flagged —
 * the now-live endpoint means the loading-spinner and disabled empty
 * trigger are user-visible rather than placeholder scaffolding.
 *
 * Mirrors `customer-multi-select-render.test.tsx` so the two drawer
 * fields share their regression coverage shape.
 *
 * The repo does not ship `@testing-library/jest-dom`, so DOM
 * assertions go through native attributes (`disabled`, `aria-busy`,
 * `aria-expanded`) instead of the jest-dom matcher sugar.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  SensorMultiSelect,
  type SensorMultiSelectLabels,
} from "@/components/detection/sensor-multi-select";

const LABELS: SensorMultiSelectLabels = {
  label: "Sensor",
  placeholder: "Select sensors",
  searchPlaceholder: "Search sensors…",
  selectAll: "Select all",
  clearAll: "Clear all",
  empty: "No sensors available for your customer scope.",
  noMatches: "No sensors match your search.",
  selectedSummary: "{count} selected",
  removeSelection: "Remove {name}",
  comingSoonLabel: "Coming soon",
  comingSoonHint:
    "Sensor options become available once Central Manager publishes the sensor-list endpoint.",
  loadingLabel: "Loading sensors…",
  loadingHint: "Fetching the sensor list from the detection backend.",
  errorLabel: "Could not load sensors",
  errorHint: "Retry fetching the sensor list.",
  retry: "Retry",
  refresh: "Refresh sensor list",
};

const OPTIONS = [
  { id: "s1", name: "alpha.example" },
  { id: "s2", name: "beta.example" },
] as const;

describe("SensorMultiSelect render states", () => {
  it("loading: renders the spinner alongside the loading copy", () => {
    render(
      <SensorMultiSelect
        options={[]}
        value={[]}
        onChange={() => {}}
        labels={LABELS}
        state="loading"
      />,
    );
    // Reviewer Round 5: the loading branch must render an inline
    // spinner (not just the disabled chevron) so the operator has a
    // visible cue while the first drawer-open fetch is in flight.
    const trigger = screen.getByRole("button", { name: /loading sensors/i });
    expect((trigger as HTMLButtonElement).disabled).toBe(true);
    expect(trigger.getAttribute("aria-busy")).toBe("true");
    expect(
      document.querySelector(
        "[data-testid='sensor-multi-select-loading-spinner']",
      ),
    ).not.toBeNull();
  });

  it("error: renders the disabled trigger plus a Retry button that calls onRetry", () => {
    const onRetry = vi.fn();
    render(
      <SensorMultiSelect
        options={[]}
        value={[]}
        onChange={() => {}}
        labels={LABELS}
        state="error"
        onRetry={onRetry}
      />,
    );
    const trigger = screen.getByRole("button", {
      name: /could not load sensors/i,
    });
    expect((trigger as HTMLButtonElement).disabled).toBe(true);
    const retry = screen.getByRole("button", { name: LABELS.retry });
    fireEvent.click(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("unavailable: renders the Coming soon disabled trigger with no spinner", () => {
    render(
      <SensorMultiSelect
        options={[]}
        value={[]}
        onChange={() => {}}
        labels={LABELS}
        state="unavailable"
      />,
    );
    const trigger = screen.getByRole("button", {
      name: LABELS.comingSoonLabel,
    });
    expect((trigger as HTMLButtonElement).disabled).toBe(true);
    expect(trigger.getAttribute("aria-busy")).toBe("false");
    expect(
      document.querySelector(
        "[data-testid='sensor-multi-select-loading-spinner']",
      ),
    ).toBeNull();
  });

  it("ready + zero options: disables the trigger and surfaces a sibling refresh", () => {
    const onRefresh = vi.fn();
    render(
      <SensorMultiSelect
        options={[]}
        value={[]}
        onChange={() => {}}
        labels={LABELS}
        state="ready"
        onRefresh={onRefresh}
      />,
    );
    // Reviewer Round 5: the ready-but-empty branch must show the
    // empty-scope copy on a disabled trigger (mirroring the Customer
    // pattern), with a sibling `↻` refresh affordance so an operator
    // whose admin just assigned a sensor in another tab has an
    // in-page recovery path. The previous behaviour kept the trigger
    // interactive and hid the message inside the open panel, which
    // does not match the #278 UI-states table.
    const trigger = screen.getByRole("button", { name: LABELS.empty });
    expect((trigger as HTMLButtonElement).disabled).toBe(true);
    const refresh = screen.getByRole("button", { name: LABELS.refresh });
    fireEvent.click(refresh);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("ready + options: shows the placeholder, opens the panel, and renders options", () => {
    render(
      <SensorMultiSelect
        options={OPTIONS}
        value={[]}
        onChange={() => {}}
        labels={LABELS}
        state="ready"
      />,
    );
    const trigger = screen.getByRole("button", { name: LABELS.placeholder });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("alpha.example")).toBeTruthy();
    expect(screen.getByText("beta.example")).toBeTruthy();
  });

  it("ready + selection: renders chips and calls onChange when removing one", () => {
    const onChange = vi.fn();
    render(
      <SensorMultiSelect
        options={OPTIONS}
        value={["s1"]}
        onChange={onChange}
        labels={LABELS}
        state="ready"
      />,
    );
    expect(screen.getByRole("button", { name: "1 selected" })).toBeTruthy();
    const removeBtn = screen.getByRole("button", {
      name: "Remove alpha.example",
    });
    fireEvent.click(removeBtn);
    expect(onChange).toHaveBeenCalledWith([]);
  });
});
