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
