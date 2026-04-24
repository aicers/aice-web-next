/**
 * Regression coverage for the shared `+N more` popover used by the
 * Detection result list and the Quick peek inspector.
 *
 * These assertions force the popover panel open via `defaultOpen` so
 * `renderToStaticMarkup` exercises the contents (the inner `<li>`
 * items are skipped in the closed state).
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MorePopover } from "@/components/detection/more-popover";

describe("MorePopover", () => {
  it("renders each value as a list item inside the dialog when open", () => {
    const html = renderToStaticMarkup(
      <MorePopover
        count={3}
        values={["10.0.0.1", "10.0.0.2", "10.0.0.3"]}
        moreCountSuffix={(n) => `+${n} more`}
        defaultOpen
      />,
    );

    expect(html).toMatch(/role="dialog"/);
    expect(html).toContain("10.0.0.1");
    expect(html).toContain("10.0.0.2");
    expect(html).toContain("10.0.0.3");
  });

  it("attaches a Copy button to each item when copyLabels is provided (issue #290)", () => {
    // Overflowed user IDs must remain copy-able even after they fold
    // behind the popover — the reviewer flagged that the 4th+
    // userList entry silently lost its Copy affordance.
    const html = renderToStaticMarkup(
      <MorePopover
        count={2}
        values={["alice", "bob"]}
        moreCountSuffix={(n) => `+${n} more`}
        copyLabels={{ copy: "Copy", copied: "Copied" }}
        defaultOpen
      />,
    );

    const copyButtons = html.match(/aria-label="Copy"/g);
    expect(copyButtons?.length ?? 0).toBe(2);
    expect(html).toContain("alice");
    expect(html).toContain("bob");
  });

  it("omits Copy buttons when copyLabels is not provided", () => {
    const html = renderToStaticMarkup(
      <MorePopover
        count={2}
        values={["one", "two"]}
        moreCountSuffix={(n) => `+${n} more`}
        defaultOpen
      />,
    );

    expect(html).not.toContain('aria-label="Copy"');
  });

  it("uses copyValues as the clipboard payload when supplied (issue #290)", () => {
    // Endpoint-style overflow displays `IP[:port] (country)` but the
    // operator expects Copy to yield the raw IP. `copyValues` decouples
    // the visible label from the clipboard payload; the displayed text
    // is `203.0.113.10 (DE)` but the Copy button's `data-copy-value`
    // renders the bare address. The reviewer flagged that endpoint
    // overflows were inspectable but not copyable.
    const html = renderToStaticMarkup(
      <MorePopover
        count={2}
        values={["203.0.113.10 (DE)", "203.0.113.11 (FR)"]}
        copyValues={["203.0.113.10", "203.0.113.11"]}
        moreCountSuffix={(n) => `+${n} more`}
        copyLabels={{ copy: "Copy", copied: "Copied" }}
        defaultOpen
      />,
    );

    // Both list items render a Copy button.
    const copyButtons = html.match(/aria-label="Copy"/g);
    expect(copyButtons?.length ?? 0).toBe(2);
    // Displayed text keeps the country suffix.
    expect(html).toContain("203.0.113.10 (DE)");
    expect(html).toContain("203.0.113.11 (FR)");
  });
});
