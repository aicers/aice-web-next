import { fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";

import { EventPeriodPills } from "@/components/event/event-period-pills";
import enMessages from "@/i18n/messages/en.json";
import type { EventPeriodKey } from "@/lib/event";

function renderPills(props: {
  selected: EventPeriodKey | null;
  onSelect?: (key: EventPeriodKey) => void;
}) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <EventPeriodPills
        selected={props.selected}
        onSelect={props.onSelect ?? vi.fn()}
      />
    </NextIntlClientProvider>,
  );
}

describe("EventPeriodPills", () => {
  it("renders only the four one-week-capped options, not the longer ones", () => {
    renderPills({ selected: null });
    for (const label of ["1 hour", "12 hours", "1 day", "1 week"]) {
      expect(screen.getByRole("button", { name: label })).toBeTruthy();
    }
    for (const label of ["1 month", "3 months", "1 year", "3 years"]) {
      expect(screen.queryByRole("button", { name: label })).toBeNull();
    }
  });

  it("highlights the selected pill via aria-pressed and leaves the rest off", () => {
    renderPills({ selected: "1w" });
    expect(
      screen
        .getByRole("button", { name: "1 week" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      screen
        .getByRole("button", { name: "1 hour" })
        .getAttribute("aria-pressed"),
    ).toBe("false");
  });

  it("highlights no pill when none is selected", () => {
    renderPills({ selected: null });
    for (const label of ["1 hour", "12 hours", "1 day", "1 week"]) {
      expect(
        screen
          .getByRole("button", { name: label })
          .getAttribute("aria-pressed"),
      ).toBe("false");
    }
  });

  it("reports the clicked pill's key to onSelect", () => {
    const onSelect = vi.fn();
    renderPills({ selected: null, onSelect });
    fireEvent.click(screen.getByRole("button", { name: "12 hours" }));
    expect(onSelect).toHaveBeenCalledWith("12h");
  });
});
