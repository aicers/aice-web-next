import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  downloading: "Preparing download…",
  downloadError: "Could not download the packet capture.",
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
    // The parsed view loads independently of the download tests below.
    loadEventPcapMock.mockResolvedValue({ status: "ok", parsedPcap: "x" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
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

  it("fetch-drives the download and applies the Content-Disposition filename", async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])]);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(blob, {
        status: 200,
        headers: {
          "Content-Type": "application/vnd.tcpdump.pcap",
          "Content-Disposition":
            'attachment; filename="detection-pcap_sensor-1-1a2b3c4d_2026-04-22T10-00-00.pcap"',
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const createObjectURL = vi.fn().mockReturnValue("blob:fake");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL,
      revokeObjectURL,
    });

    const clickedNames: string[] = [];
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        clickedNames.push(this.download);
      });

    renderTab();
    const button = await screen.findByRole("button", {
      name: /Download \.pcap/,
    });
    await userEvent.click(button);

    const calledUrl = String(fetchMock.mock.calls[0][0]);
    expect(calledUrl).toContain("/api/detection/pcap?");
    expect(calledUrl).toContain(`sensor=${encodeURIComponent(SENSOR)}`);
    expect(calledUrl).toContain(
      `requestTime=${encodeURIComponent(REQUEST_TIME)}`,
    );

    await waitFor(() => expect(clickSpy).toHaveBeenCalled());
    // The saved name comes from the header, not the static downloadName.
    expect(clickedNames[0]).toBe(
      "detection-pcap_sensor-1-1a2b3c4d_2026-04-22T10-00-00.pcap",
    );
    expect(clickedNames[0]).not.toBe(LABELS.downloadName);
    expect(createObjectURL).toHaveBeenCalledWith(blob);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:fake");
  });

  it("shows the empty-state message and does not save on 404 no-packet-data", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ code: "no-packet-data" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const createObjectURL = vi.fn();
    vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL: vi.fn() });
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});

    renderTab();
    const button = await screen.findByRole("button", {
      name: /Download \.pcap/,
    });
    await userEvent.click(button);

    await screen.findByText(LABELS.empty);
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(clickSpy).not.toHaveBeenCalled();
  });

  it("shows the download-error message on any other failure", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("nope", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});

    renderTab();
    const button = await screen.findByRole("button", {
      name: /Download \.pcap/,
    });
    await userEvent.click(button);

    await screen.findByText(LABELS.downloadError);
    expect(clickSpy).not.toHaveBeenCalled();
  });
});
