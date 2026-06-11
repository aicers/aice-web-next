import { fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";

import { EventFilterForm } from "@/components/event/event-filter-form";
import enMessages from "@/i18n/messages/en.json";
import { computeEventPeriodRange, EMPTY_EVENT_FILTER } from "@/lib/event";

function renderForm(
  draft = EMPTY_EVENT_FILTER,
  onChange: (next: typeof EMPTY_EVENT_FILTER) => void = vi.fn(),
) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <EventFilterForm
        draft={draft}
        sensors={["sensor-a"]}
        pending={false}
        onChange={onChange}
        onApply={vi.fn()}
        onReset={vi.fn()}
      />
    </NextIntlClientProvider>,
  );
}

describe("EventFilterForm — period pills", () => {
  it("fills the explicit range and records the key when a pill is clicked", () => {
    const onChange = vi.fn();
    renderForm(EMPTY_EVENT_FILTER, onChange);

    fireEvent.click(screen.getByRole("button", { name: "1 day" }));

    const patch = onChange.mock.calls[0][0];
    expect(patch.period).toBe("1d");
    // The committed range is non-null and self-consistent; we only assert
    // the period key and that both bounds were filled (the exact instant
    // depends on the click-time clock).
    expect(patch.start).not.toBeNull();
    expect(patch.end).not.toBeNull();
    expect(patch.start).toBe(
      computeEventPeriodRange("1d", new Date(patch.end)).start,
    );
  });

  it("clears the active pill when the start input is edited by hand", () => {
    const range = computeEventPeriodRange(
      "1w",
      new Date("2026-06-11T12:00:00Z"),
    );
    const onChange = vi.fn();
    const { container } = renderForm(
      {
        ...EMPTY_EVENT_FILTER,
        period: "1w",
        start: range.start,
        end: range.end,
      },
      onChange,
    );

    // The just-selected pill is highlighted from the explicit field.
    expect(
      screen
        .getByRole("button", { name: "1 week" })
        .getAttribute("aria-pressed"),
    ).toBe("true");

    const startInput = container.querySelector("#event-start");
    expect(startInput).not.toBeNull();
    fireEvent.change(startInput as HTMLInputElement, {
      target: { value: "2026-06-01T00:00" },
    });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0].period).toBeNull();
  });
});
