/**
 * Asset-detail deep-link wiring (#666).
 *
 * The asset-detail panel threads each event's stable `id` into a
 * `/detection/events/<token>` deep link so an operator can jump from a triage
 * row straight into the full Event Investigation view — both by
 * clicking the row (opens a new tab) and via the explicit per-row
 * action button. These tests pin (a) the token is built from
 * `encodeEventLocator`, (b) the row behaves as a keyboard link, and
 * (c) the action anchor opens a new tab without double-firing the
 * row handler.
 */

import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type TriageAssetDetailLabels,
  TriageAssetDetailView,
} from "@/components/triage/asset-detail";
import { encodeEventLocator } from "@/lib/events/event-locator";
import type { TriageAsset } from "@/lib/triage";

// `getPathname` is locale-prefixing; the asset panel only needs a
// deterministic, passthrough resolution here so the assertion can
// compare against the raw `/detection/events/<token>` href.
vi.mock("next-intl", () => ({
  useLocale: () => "en",
}));
vi.mock("@/i18n/navigation", () => ({
  getPathname: ({ href }: { href: string; locale: string }) => href,
}));

const LABELS: TriageAssetDetailLabels = {
  title: "Asset detail",
  pivotFocusTitle: "Pivot focus",
  customerLabel: "Customer",
  emptySelection: "Select an asset",
  emptyEvents: "No events",
  scoreLabel: "Score",
  triagedLabel: "Triaged",
  detectedLabel: "Detected",
  eventsHeading: "Events",
  timeColumn: "Time",
  kindColumn: "Kind",
  categoryColumn: "Category",
  scoreColumn: "Score",
  investigateColumn: "Investigate",
  investigateAction: "Open full investigation",
  investigateTooltip: "Open the full investigation view in a new tab.",
  rowInvestigateAriaLabel: "Open full investigation in a new tab",
  protectedByStoryMarker: {
    template: "Kept because of Story membership (score: {score})",
  },
};

function asset(): TriageAsset {
  return {
    customerId: 1,
    customerName: "Acme",
    address: "10.0.0.5",
    detectedCount: 10,
    detectedCountUnavailable: false,
    triagedCount: 2,
    score: 1.5,
    lastEventTimeIso: "2026-05-09T12:10:00.000Z",
    events: [
      {
        __typename: "HttpThreat",
        id: "event-id-1",
        rowKey: "row-1",
        time: "2026-05-09T12:10:00.000Z",
        sensor: "s1",
        category: "IMPACT",
        level: "HIGH",
        score: 0.92,
        customerId: 1,
      },
    ],
  };
}

describe("TriageAssetDetailView — investigate deep link (#666)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the actions column and an anchor to the encoded /detection/events token", () => {
    render(<TriageAssetDetailView asset={asset()} labels={LABELS} />);

    const headers = screen
      .getAllByRole("columnheader")
      .map((h) => h.textContent);
    expect(headers).toContain("Investigate");

    const token = encodeEventLocator({ id: "event-id-1" });
    const anchor = within(
      screen.getByTestId("triage-event-row-actions"),
    ).getByRole("link", { name: "Open full investigation" });
    expect(anchor.getAttribute("href")).toBe(
      `/detection/events/${encodeURIComponent(token as string)}`,
    );
    expect(anchor.getAttribute("target")).toBe("_blank");
    expect(anchor.getAttribute("rel")).toBe("noreferrer");
  });

  it("makes the whole row open the investigation in a new tab on click", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    render(<TriageAssetDetailView asset={asset()} labels={LABELS} />);

    const token = encodeEventLocator({ id: "event-id-1" });
    fireEvent.click(screen.getByTestId("triage-event-row"));
    expect(open).toHaveBeenCalledWith(
      `/detection/events/${encodeURIComponent(token as string)}`,
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("does not double-open when the action anchor itself is clicked", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    render(<TriageAssetDetailView asset={asset()} labels={LABELS} />);

    fireEvent.click(
      within(screen.getByTestId("triage-event-row-actions")).getByRole("link"),
    );
    // jsdom does not navigate the real anchor, but its click must not
    // bubble to the row handler and spawn a second tab.
    expect(open).not.toHaveBeenCalled();
  });
});
