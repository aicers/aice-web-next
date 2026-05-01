/**
 * Render-level coverage for {@link CustomerMultiSelect} (#384,
 * Reviewer Round 6 #3).
 *
 * The companion `customer-multi-select.test.ts` file mocks React + the
 * UI primitives so it can exercise the pure helpers without pulling
 * the JSX runtime in. That left the four state branches the issue
 * called out (`loading`, `error`, empty `ready`, populated `ready`)
 * un-rendered. Reviewer Round 6 #3 flagged that gap; this file mounts
 * the real component under jsdom + RTL so the loading-spinner /
 * disabled-trigger / Retry button / chip-bar paths run their actual
 * production code.
 *
 * The repo does not ship `@testing-library/jest-dom`, so DOM
 * assertions go through native attributes (`disabled`, `aria-busy`,
 * `aria-expanded`) instead of the jest-dom matcher sugar.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  CustomerMultiSelect,
  type CustomerMultiSelectLabels,
} from "@/components/detection/customer-multi-select";

const LABELS: CustomerMultiSelectLabels = {
  label: "Customer",
  placeholder: "Any customer",
  searchPlaceholder: "Search customers",
  selectAll: "Select all",
  clearAll: "Clear all",
  emptyScope: "No customer access",
  noMatches: "No matches",
  selectedSummary: "{count} selected",
  removeSelection: "Remove {name}",
  loadingLabel: "Loading customers…",
  loadingHint: "Fetching the customer list from the detection backend.",
  errorLabel: "Failed to load customers",
  errorHint: "The customer list could not be fetched. Try again.",
  retry: "Retry",
  refresh: "Refresh customer list",
};

const OPTIONS = [
  { id: 1, name: "Acme Inc." },
  { id: 2, name: "Beta Corp." },
] as const;

describe("CustomerMultiSelect render states", () => {
  it("loading: renders the spinner alongside the loading copy", () => {
    render(
      <CustomerMultiSelect
        options={[]}
        value={[]}
        onChange={() => {}}
        labels={LABELS}
        state="loading"
      />,
    );
    // Reviewer Round 6 #2: the loading branch must render an inline
    // spinner (not just the disabled chevron) so the operator has a
    // visible cue while the first drawer-open fetch is in flight.
    const trigger = screen.getByRole("button", { name: /loading customers/i });
    expect((trigger as HTMLButtonElement).disabled).toBe(true);
    expect(trigger.getAttribute("aria-busy")).toBe("true");
    expect(
      document.querySelector(
        "[data-testid='customer-multi-select-loading-spinner']",
      ),
    ).not.toBeNull();
  });

  it("error: renders the disabled trigger plus a Retry button that calls onRefresh", () => {
    const onRefresh = vi.fn();
    render(
      <CustomerMultiSelect
        options={[]}
        value={[]}
        onChange={() => {}}
        labels={LABELS}
        state="error"
        onRefresh={onRefresh}
      />,
    );
    const trigger = screen.getByRole("button", {
      name: /failed to load customers/i,
    });
    expect((trigger as HTMLButtonElement).disabled).toBe(true);
    const retry = screen.getByRole("button", { name: LABELS.retry });
    fireEvent.click(retry);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("ready + empty scope: disables the trigger and surfaces a sibling refresh", () => {
    const onRefresh = vi.fn();
    render(
      <CustomerMultiSelect
        options={[]}
        value={[]}
        onChange={() => {}}
        labels={LABELS}
        state="ready"
        onRefresh={onRefresh}
      />,
    );
    // The disabled empty-scope trigger plus the sibling `↻` button
    // (Reviewer Round 3 #2) — without the refresh affordance an
    // operator whose admin just assigned them a customer in another
    // tab would have no in-page recovery path.
    const trigger = screen.getByRole("button", { name: LABELS.emptyScope });
    expect((trigger as HTMLButtonElement).disabled).toBe(true);
    const refresh = screen.getByRole("button", { name: LABELS.refresh });
    fireEvent.click(refresh);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("ready + options: shows the placeholder, opens the panel, and renders options", () => {
    render(
      <CustomerMultiSelect
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
    // Each option's label is rendered once the panel is open.
    expect(screen.getByText("Acme Inc.")).toBeTruthy();
    expect(screen.getByText("Beta Corp.")).toBeTruthy();
  });

  it("ready + selection: renders chips and calls onChange when removing one", () => {
    const onChange = vi.fn();
    render(
      <CustomerMultiSelect
        options={OPTIONS}
        value={[1]}
        onChange={onChange}
        labels={LABELS}
        state="ready"
      />,
    );
    // Trigger summary substitutes `{count}` with the selection size.
    expect(screen.getByRole("button", { name: "1 selected" })).toBeTruthy();
    const removeBtn = screen.getByRole("button", { name: "Remove Acme Inc." });
    fireEvent.click(removeBtn);
    expect(onChange).toHaveBeenCalledWith([]);
  });
});
