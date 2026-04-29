import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";

import { ResourceSparkline } from "@/components/node/resource-sparkline";
import type { NodeStatusSample } from "@/hooks/use-node-status-polling";
import enMessages from "@/i18n/messages/en.json";

function makeSample(
  capturedAt: Date,
  cpuUsage: number,
  segmentBoundary = false,
): NodeStatusSample {
  return {
    capturedAt,
    cpuUsage,
    totalMemory: "16000000000",
    usedMemory: "8000000000",
    totalDiskSpace: "1000000000000",
    usedDiskSpace: "400000000000",
    manager: true,
    ping: 0.05,
    segmentBoundary,
  };
}

function renderSparkline(props: Parameters<typeof ResourceSparkline>[0]) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ResourceSparkline {...props} />
    </NextIntlClientProvider>,
  );
}

describe("ResourceSparkline", () => {
  it("renders no-samples copy when buffer is empty", () => {
    renderSparkline({
      metric: "cpu",
      samples: [],
      isStale: false,
      pollIntervalMs: 10_000,
      lastSampleAt: null,
    });
    expect(
      screen.getByText(enMessages.nodes.detail.charts.noSamples),
    ).toBeTruthy();
  });

  it("renders one polyline segment when no segment boundaries are present", () => {
    const samples: NodeStatusSample[] = [
      makeSample(new Date("2026-04-29T10:00:00.000Z"), 10),
      makeSample(new Date("2026-04-29T10:00:10.000Z"), 20),
      makeSample(new Date("2026-04-29T10:00:20.000Z"), 30),
    ];
    const { container } = renderSparkline({
      metric: "cpu",
      samples,
      isStale: false,
      pollIntervalMs: 10_000,
      lastSampleAt: samples[samples.length - 1].capturedAt,
    });
    const paths = container.querySelectorAll(
      "[data-testid^='node-detail-sparkline-segment-cpu-']",
    );
    expect(paths.length).toBe(1);
  });

  it("renders multiple polyline segments when segment boundaries break the run", () => {
    const samples: NodeStatusSample[] = [
      makeSample(new Date("2026-04-29T10:00:00.000Z"), 10),
      makeSample(new Date("2026-04-29T10:00:10.000Z"), 20),
      // gap > 2 × pollIntervalMs → segmentBoundary true
      makeSample(new Date("2026-04-29T10:01:00.000Z"), 30, true),
      makeSample(new Date("2026-04-29T10:01:10.000Z"), 40),
    ];
    const { container } = renderSparkline({
      metric: "cpu",
      samples,
      isStale: false,
      pollIntervalMs: 10_000,
      lastSampleAt: samples[samples.length - 1].capturedAt,
    });
    const paths = container.querySelectorAll(
      "[data-testid^='node-detail-sparkline-segment-cpu-']",
    );
    expect(paths.length).toBe(2);
  });

  it("appends `· data stale` to the samples label when isStale=true", () => {
    const samples: NodeStatusSample[] = [
      makeSample(new Date("2026-04-29T10:00:00.000Z"), 10),
      makeSample(new Date("2026-04-29T10:00:10.000Z"), 20),
    ];
    renderSparkline({
      metric: "cpu",
      samples,
      isStale: true,
      pollIntervalMs: 10_000,
      lastSampleAt: samples[samples.length - 1].capturedAt,
    });
    const label = screen.getByTestId("node-detail-sparkline-label-cpu");
    expect(label.textContent).toContain(enMessages.nodes.detail.charts.stale);
    // The container carries the data-stale flag for the dashboard's
    // "stale visual driven solely by isStale" acceptance.
    const root = screen.getByTestId("node-detail-sparkline-cpu");
    expect(root.getAttribute("data-stale")).toBe("true");
  });

  it("does not append stale suffix when isStale=false", () => {
    const samples: NodeStatusSample[] = [
      makeSample(new Date("2026-04-29T10:00:00.000Z"), 10),
      makeSample(new Date("2026-04-29T10:00:10.000Z"), 20),
    ];
    renderSparkline({
      metric: "cpu",
      samples,
      isStale: false,
      pollIntervalMs: 10_000,
      lastSampleAt: samples[samples.length - 1].capturedAt,
    });
    const label = screen.getByTestId("node-detail-sparkline-label-cpu");
    expect(label.textContent).not.toContain(
      enMessages.nodes.detail.charts.stale,
    );
  });

  it("preserves the segment boundary when the boundary sample has no metric value", () => {
    // The first post-gap sample is the one carrying segmentBoundary=true,
    // but it has no CPU reading (cpuUsage=null). It is therefore filtered
    // from the plottable points — yet the polyline must still break at
    // the gap. The next usable sample must carry the boundary forward
    // so the resulting render produces TWO segments rather than a single
    // polyline that silently interpolates across the gap.
    const samples: NodeStatusSample[] = [
      makeSample(new Date("2026-04-29T10:00:00.000Z"), 10),
      makeSample(new Date("2026-04-29T10:00:10.000Z"), 20),
      {
        capturedAt: new Date("2026-04-29T10:01:00.000Z"),
        cpuUsage: null,
        totalMemory: "16000000000",
        usedMemory: "8000000000",
        totalDiskSpace: "1000000000000",
        usedDiskSpace: "400000000000",
        manager: true,
        ping: 0.05,
        segmentBoundary: true,
      },
      makeSample(new Date("2026-04-29T10:01:10.000Z"), 40),
      makeSample(new Date("2026-04-29T10:01:20.000Z"), 50),
    ];
    const { container } = renderSparkline({
      metric: "cpu",
      samples,
      isStale: false,
      pollIntervalMs: 10_000,
      lastSampleAt: samples[samples.length - 1].capturedAt,
    });
    const paths = container.querySelectorAll(
      "[data-testid^='node-detail-sparkline-segment-cpu-']",
    );
    expect(paths.length).toBe(2);
  });

  it("scopes stale styling to the trailing edge, leaving prior history un-muted", () => {
    // Round 5 reviewer: every rendered <path> previously inherited
    // `text-muted-foreground` while `isStale === true`, which muted
    // the entire sparkline history. The spec calls for stale styling
    // on the latest point and the trailing edge only — i.e. the line
    // segment between the last two samples — so prior strokes must
    // stay in the normal `text-primary` colour.
    const samples: NodeStatusSample[] = [
      makeSample(new Date("2026-04-29T10:00:00.000Z"), 10),
      makeSample(new Date("2026-04-29T10:00:10.000Z"), 20),
      makeSample(new Date("2026-04-29T10:00:20.000Z"), 30),
      makeSample(new Date("2026-04-29T10:00:30.000Z"), 40),
    ];
    const { container } = renderSparkline({
      metric: "cpu",
      samples,
      isStale: true,
      pollIntervalMs: 10_000,
      lastSampleAt: samples[samples.length - 1].capturedAt,
    });
    // The trailing edge — the final line segment — is rendered as a
    // dedicated `<path>` with the muted stale colour, while the
    // earlier history keeps `text-primary`.
    const tail = container.querySelector(
      "[data-testid$='-tail']",
    ) as SVGPathElement | null;
    const head = container.querySelector(
      "[data-testid$='-head']",
    ) as SVGPathElement | null;
    expect(tail).not.toBeNull();
    expect(head).not.toBeNull();
    expect(tail?.getAttribute("class") ?? "").toContain(
      "text-muted-foreground",
    );
    expect(head?.getAttribute("class") ?? "").toContain("text-primary");
    expect(head?.getAttribute("class") ?? "").not.toContain(
      "text-muted-foreground",
    );
  });

  it("does not dim the entire chart via root <svg> opacity when isStale", () => {
    // Round 6 reviewer: a root `opacity-60` on the <svg> mutes every
    // child (history paths, tail path, latest-point circle), which is
    // wider than #312 / #376 require. Stale styling must be confined
    // to the latest point and trailing edge.
    const samples: NodeStatusSample[] = [
      makeSample(new Date("2026-04-29T10:00:00.000Z"), 10),
      makeSample(new Date("2026-04-29T10:00:10.000Z"), 20),
      makeSample(new Date("2026-04-29T10:00:20.000Z"), 30),
      makeSample(new Date("2026-04-29T10:00:30.000Z"), 40),
    ];
    const { container } = renderSparkline({
      metric: "cpu",
      samples,
      isStale: true,
      pollIntervalMs: 10_000,
      lastSampleAt: samples[samples.length - 1].capturedAt,
    });
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("class") ?? "").not.toContain("opacity-60");
  });

  it("does not split into head/tail when isStale=false", () => {
    const samples: NodeStatusSample[] = [
      makeSample(new Date("2026-04-29T10:00:00.000Z"), 10),
      makeSample(new Date("2026-04-29T10:00:10.000Z"), 20),
      makeSample(new Date("2026-04-29T10:00:20.000Z"), 30),
    ];
    const { container } = renderSparkline({
      metric: "cpu",
      samples,
      isStale: false,
      pollIntervalMs: 10_000,
      lastSampleAt: samples[samples.length - 1].capturedAt,
    });
    expect(container.querySelector("[data-testid$='-tail']")).toBeNull();
    expect(container.querySelector("[data-testid$='-head']")).toBeNull();
  });

  it("derives the label from sample timestamps, not a fixed sample count", () => {
    // Three samples spanning ~30 minutes — label should reflect that
    // span, not "10 minutes" implied by a fixed buffer size.
    const samples: NodeStatusSample[] = [
      makeSample(new Date("2026-04-29T10:00:00.000Z"), 10),
      makeSample(new Date("2026-04-29T10:15:00.000Z"), 20),
      makeSample(new Date("2026-04-29T10:30:00.000Z"), 30),
    ];
    renderSparkline({
      metric: "cpu",
      samples,
      isStale: false,
      pollIntervalMs: 10_000,
      lastSampleAt: samples[samples.length - 1].capturedAt,
    });
    const label = screen.getByTestId("node-detail-sparkline-label-cpu");
    // Label must include the actual minute span (~30) — not "10".
    expect(label.textContent).toMatch(/30/);
  });
});
