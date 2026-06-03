/**
 * #684: the Related tab's "Last seen" snippet renders a raw Detection
 * event timestamp (REview `node.time`, UTC). It must be formatted in
 * the operator's configured timezone via `formatDateTime`, with the
 * raw ISO preserved in the `<time dateTime>` attribute for machine
 * semantics — mirroring the in-scope Detection event-time sites.
 */

import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/i18n/navigation", () => ({
  Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

const fetchRelatedPivotSummariesMock = vi.fn();
vi.mock("@/lib/events/related-pivots", () => ({
  fetchRelatedPivotSummaries: (...args: unknown[]) =>
    fetchRelatedPivotSummariesMock(...args),
}));

import {
  type RelatedLabels,
  RelatedTab,
} from "@/components/events/tabs/related-tab";
import type { Event } from "@/lib/detection/types";
import { formatDateTime } from "@/lib/format-date";

const LABELS: RelatedLabels = {
  sameSource: "Same source",
  sameDestination: "Same destination",
  sameKind: "Same kind",
  sameSession: "Same session",
  lastDay: "Last day",
  lastWeek: "Last week",
  openInSearch: "Open in search",
  loading: "Loading",
  count: "Count",
  lastSeen: "Last seen",
  none: "No matches",
  note: "Related pivots",
};

const EVENT: Event = {
  __typename: "HttpThreat",
  id: "evt-AAAA",
  time: "2026-04-22T10:00:00.000000000Z",
  sensor: "sensor-1",
  origAddr: "10.0.0.5",
  respAddr: "8.8.8.8",
} as unknown as Event;

const LAST_TIME = "2026-04-22T09:55:00.000Z";

describe("RelatedTab — Last seen timezone formatting (#684)", () => {
  it("renders Last seen in the configured timezone and keeps the raw ISO in dateTime", async () => {
    fetchRelatedPivotSummariesMock.mockResolvedValue([
      { id: "same-kind", count: "3", lastTime: LAST_TIME },
    ]);
    render(<RelatedTab event={EVENT} labels={LABELS} />);

    const timeEl = await waitFor(() => {
      const el = document.querySelector("time");
      if (!el) throw new Error("time element not yet rendered");
      return el;
    });

    // Raw ISO retained for machine semantics.
    expect(timeEl.getAttribute("dateTime")).toBe(LAST_TIME);
    // Visible text is formatted through the shared helper, not raw ISO.
    expect(timeEl.textContent).toBe(formatDateTime(LAST_TIME));
    expect(timeEl.textContent).not.toBe(LAST_TIME);
  });

  it("renders the no-match label without a time element when lastTime is null", async () => {
    fetchRelatedPivotSummariesMock.mockResolvedValue([
      { id: "same-kind", count: "0", lastTime: null },
    ]);
    render(<RelatedTab event={EVENT} labels={LABELS} />);

    await waitFor(() => {
      expect(screen.getAllByText("No matches").length).toBeGreaterThan(0);
    });
    expect(document.querySelector("time")).toBeNull();
  });
});
