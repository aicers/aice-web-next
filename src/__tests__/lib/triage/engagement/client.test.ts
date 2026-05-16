/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  postEngagementAction,
  postImpressionBatch,
} from "@/lib/triage/engagement/client";

// Phase 1 acceptance: ingestion failures never propagate. The wrapper
// is a thin `fire(...)` that branches transport (keepalive vs not) per
// payload size. Phase 1 review-round-1 item 2 — the impression batch
// MUST be sent without `keepalive` because the spec caps keepalive
// bodies at 64 KiB and the worst-case menu (≈7,000 rows) blows past
// that cap, dropping the Phase 2 denominator silently.

const fetchSpy = vi.fn();

beforeEach(() => {
  fetchSpy.mockReset();
  fetchSpy.mockResolvedValue(new Response(null, { status: 204 }));
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("engagement client transport", () => {
  it("postImpressionBatch sends WITHOUT keepalive so a large batch is not subject to the 64 KiB keepalive cap", () => {
    postImpressionBatch({
      menuLoadId: "00000000-0000-4000-8000-000000000001",
      customerId: 1,
      surface: "baseline",
      strictnessStop: "top50",
      periodStartIso: "2026-05-01T00:00:00Z",
      periodEndIso: "2026-05-16T00:00:00Z",
      impressions: [
        {
          eventKey: "evt-1",
          kind: "HttpThreat",
          slotBucket: "HttpThreat:false",
          rank: 1,
          baselineVersion: "phase1b-four-selector",
          shownBy: "quota",
        },
      ],
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0];
    expect(init.method).toBe("POST");
    expect(init.keepalive).toBe(false);
  });

  it("postEngagementAction sends WITH keepalive so a click that immediately navigates away still reaches the server", () => {
    postEngagementAction({
      type: "asset_select",
      customerId: 1,
      surface: "baseline",
      assetAddress: "10.0.0.1",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0];
    expect(init.method).toBe("POST");
    expect(init.keepalive).toBe(true);
  });

  it("postImpressionBatch is a no-op on an empty batch (no network call)", () => {
    postImpressionBatch({
      menuLoadId: "00000000-0000-4000-8000-000000000001",
      customerId: 1,
      surface: "baseline",
      strictnessStop: "top50",
      periodStartIso: "2026-05-01T00:00:00Z",
      periodEndIso: "2026-05-16T00:00:00Z",
      impressions: [],
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a rejected fetch never propagates (fire-and-forget)", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("network down"));
    const consoleSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    expect(() =>
      postEngagementAction({
        type: "strictness_change",
        customerId: 1,
        surface: "baseline",
        strictnessFrom: "top50",
        strictnessTo: "top20",
      }),
    ).not.toThrow();
    // Flush microtasks so the .catch handler in `fire` runs.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(consoleSpy).toHaveBeenCalled();
  });
});
