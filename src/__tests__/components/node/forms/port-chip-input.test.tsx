/**
 * `PortChipInput` interactive coverage.
 *
 * Per the issue's acceptance ("React Testing Library + Vitest"), this
 * suite mounts the real component under jsdom + RTL and drives the
 * Enter / blur commit flow with `userEvent`, rather than asserting
 * over `renderToStaticMarkup` output. The pure `validatePortInput`
 * helper keeps a tight unit-test block alongside.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  PortChipInput,
  validatePortInput,
} from "@/components/node/forms/shared/port-chip-input";
import enMessages from "@/i18n/messages/en.json";
import koMessages from "@/i18n/messages/ko.json";

interface HarnessProps {
  initialValue?: number[];
  standardPorts?: readonly number[];
  error?: string;
  onChange?: (next: number[]) => void;
}

function Harness({
  initialValue = [21],
  standardPorts = [21],
  error,
  onChange,
}: HarnessProps) {
  const [value, setValue] = useState<number[]>(initialValue);
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <PortChipInput
        idPrefix="ftp"
        label="FTP"
        standardPorts={standardPorts}
        value={value}
        onChange={(next) => {
          setValue(next);
          onChange?.(next);
        }}
        error={error}
      />
    </NextIntlClientProvider>
  );
}

describe("PortChipInput", () => {
  it("does not call onChange on mount, even when value omits a standard port", () => {
    const onChange = vi.fn();
    render(
      <Harness
        initialValue={[2121]}
        standardPorts={[21]}
        onChange={onChange}
      />,
    );
    expect(onChange).not.toHaveBeenCalled();
  });

  it("renders pinned standard chips and removable custom chips", () => {
    render(
      <Harness initialValue={[80, 8080, 9000]} standardPorts={[80, 8080]} />,
    );
    const standardChips = screen.getAllByText(/^(80|8080)$/);
    expect(standardChips.length).toBeGreaterThanOrEqual(2);
    // Custom 9000 has a remove button; standard chips do not.
    expect(
      screen.getByRole("button", { name: /remove port 9000/i }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /remove port 80\b/i }),
    ).toBeNull();
  });

  it("commits a valid custom port on Enter and clears the draft", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Harness initialValue={[21]} standardPorts={[21]} onChange={onChange} />,
    );
    const input = screen.getByRole("textbox");
    await user.type(input, "2121{Enter}");
    expect(onChange).toHaveBeenCalledWith([21, 2121]);
    expect((input as HTMLInputElement).value).toBe("");
  });

  it("commits a valid custom port on blur", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Harness initialValue={[21]} standardPorts={[21]} onChange={onChange} />,
    );
    const input = screen.getByRole("textbox");
    await user.type(input, "2121");
    input.blur();
    expect(onChange).toHaveBeenCalledWith([21, 2121]);
  });

  it("removes a custom port when its remove button is clicked", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Harness
        initialValue={[21, 2121]}
        standardPorts={[21]}
        onChange={onChange}
      />,
    );
    const remove = screen.getByRole("button", { name: /remove port 2121/i });
    await user.click(remove);
    expect(onChange).toHaveBeenLastCalledWith([21]);
  });

  it("rejects an out-of-range port and surfaces the localized message", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Harness initialValue={[21]} standardPorts={[21]} onChange={onChange} />,
    );
    const input = screen.getByRole("textbox");
    await user.type(input, "70000{Enter}");
    expect(onChange).not.toHaveBeenCalled();
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(
      screen.getByText(enMessages.nodes.forms.portChip.errors.invalid),
    ).toBeTruthy();
    // Bad draft preserved on blur — operator can correct it instead of
    // it silently disappearing.
    expect((input as HTMLInputElement).value).toBe("70000");
  });

  it("rejects a duplicate against an existing port", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Harness
        initialValue={[21, 2121]}
        standardPorts={[21]}
        onChange={onChange}
      />,
    );
    const input = screen.getByRole("textbox");
    await user.type(input, "2121{Enter}");
    expect(onChange).not.toHaveBeenCalled();
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(
      screen.getByText(enMessages.nodes.forms.portChip.errors.duplicate),
    ).toBeTruthy();
  });

  it("forwards a parent-supplied error to aria + the inline FieldError", () => {
    render(
      <Harness initialValue={[21]} standardPorts={[21]} error="parent error" />,
    );
    const input = screen.getByRole("textbox");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toBe("ftp-input-error");
    expect(screen.getByText("parent error")).toBeTruthy();
  });

  it("does not mark the input invalid when neither error source is set", () => {
    render(<Harness initialValue={[21]} standardPorts={[21]} />);
    const input = screen.getByRole("textbox");
    expect(input.getAttribute("aria-invalid")).toBeNull();
    expect(input.getAttribute("aria-describedby")).toBeNull();
  });
});

describe("validatePortInput", () => {
  it("treats an empty / whitespace draft as a no-op", () => {
    expect(validatePortInput("", [])).toEqual({ kind: "empty" });
    expect(validatePortInput("   ", [])).toEqual({ kind: "empty" });
  });

  it("accepts an integer in [0, 65535] not already in the list", () => {
    expect(validatePortInput("9443", [443])).toEqual({
      kind: "ok",
      port: 9443,
    });
    expect(validatePortInput("0", [])).toEqual({ kind: "ok", port: 0 });
    expect(validatePortInput("65535", [])).toEqual({
      kind: "ok",
      port: 65535,
    });
  });

  it("rejects out-of-range, non-integer, and non-numeric inputs", () => {
    expect(validatePortInput("70000", [])).toEqual({ kind: "invalid" });
    expect(validatePortInput("-1", [])).toEqual({ kind: "invalid" });
    expect(validatePortInput("abc", [])).toEqual({ kind: "invalid" });
    expect(validatePortInput("80.5", [])).toEqual({ kind: "invalid" });
    expect(validatePortInput("80abc", [])).toEqual({ kind: "invalid" });
  });

  it("rejects a duplicate against the existing value list", () => {
    expect(validatePortInput("21", [21])).toEqual({ kind: "duplicate" });
    expect(validatePortInput("9443", [443, 9443])).toEqual({
      kind: "duplicate",
    });
  });
});

describe("port-chip i18n keys", () => {
  type PortChipMessages = {
    nodes: {
      forms: {
        portChip: { errors: { invalid: string; duplicate: string } };
      };
    };
  };

  it("ships invalid / duplicate strings under nodes.forms.portChip.errors in en + ko", () => {
    for (const messages of [
      enMessages as PortChipMessages,
      koMessages as PortChipMessages,
    ]) {
      const errors = messages.nodes.forms.portChip.errors;
      expect(errors.invalid).toBeTruthy();
      expect(errors.duplicate).toBeTruthy();
    }
  });
});
