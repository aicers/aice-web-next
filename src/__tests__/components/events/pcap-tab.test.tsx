import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const loadEventPcapMock = vi.fn();
vi.mock("@/lib/detection/pcap-view", () => ({
  loadEventPcap: (...args: unknown[]) => loadEventPcapMock(...args),
}));

import { type PcapLabels, PcapTab } from "@/components/events/tabs/pcap-tab";

const LABELS: PcapLabels = {
  title: "Packet capture",
  description: "Parsed packet capture.",
  loading: "Loading packet capture…",
  empty: "No packet data is stored for this event.",
  forbidden: "You do not have access to packet data.",
  unavailable: "The data store is unavailable.",
  error: "Could not load the packet capture.",
  download: "Download .pcap",
  downloadName: "detection.pcap",
};

const SENSOR = "sensor-1";
const REQUEST_TIME = "2026-04-22T10:00:00.000Z";

function renderTab() {
  return render(
    <PcapTab sensor={SENSOR} requestTime={REQUEST_TIME} labels={LABELS} />,
  );
}

describe("PcapTab", () => {
  beforeEach(() => {
    loadEventPcapMock.mockReset();
  });

  it("renders the parsed PCAP text once loaded", async () => {
    loadEventPcapMock.mockResolvedValue({
      status: "ok",
      parsedPcap: "1  0.000000  ETHER Type=IPv4",
    });
    renderTab();
    await screen.findByText(/ETHER Type=IPv4/);
    expect(loadEventPcapMock).toHaveBeenCalledWith(SENSOR, REQUEST_TIME);
  });

  it("shows the empty state when the capture is empty", async () => {
    loadEventPcapMock.mockResolvedValue({ status: "ok", parsedPcap: "" });
    renderTab();
    await screen.findByText(LABELS.empty);
  });

  it("shows the forbidden state distinct from the error state", async () => {
    loadEventPcapMock.mockResolvedValue({ status: "forbidden" });
    renderTab();
    await screen.findByText(LABELS.forbidden);
    expect(screen.queryByText(LABELS.error)).toBeNull();
  });

  it("shows the error state on a rejected load", async () => {
    loadEventPcapMock.mockRejectedValue(new Error("boom"));
    renderTab();
    await screen.findByText(LABELS.error);
  });

  it("links the download to the Route Handler with encoded params", async () => {
    loadEventPcapMock.mockResolvedValue({ status: "ok", parsedPcap: "x" });
    renderTab();
    const link = await screen.findByRole("link", { name: /Download \.pcap/ });
    const href = link.getAttribute("href") ?? "";
    expect(href).toContain("/api/detection/pcap?");
    expect(href).toContain(`sensor=${encodeURIComponent(SENSOR)}`);
    expect(href).toContain(`requestTime=${encodeURIComponent(REQUEST_TIME)}`);
    expect(link.getAttribute("download")).not.toBeNull();
  });
});
