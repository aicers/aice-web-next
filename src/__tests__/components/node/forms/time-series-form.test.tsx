/**
 * Time Series (Crusher) form interactive coverage. Locks down field
 * presence (one IP, two ports, hostname) and inline-error wiring.
 */

import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { TimeSeriesForm } from "@/components/node/forms/time-series-form";

import { renderForm } from "./test-rig";

interface TimeSeriesValues {
  timeSeries: {
    dataStoreIp: string;
    receivePort: number;
    sendPort: number;
    dataStoreHostname: string;
  };
}

const PRESET: TimeSeriesValues["timeSeries"] = {
  dataStoreIp: "10.0.0.4",
  receivePort: 38370,
  sendPort: 38371,
  dataStoreHostname: "ts-1",
};

describe("TimeSeriesForm", () => {
  it("renders the IP, both port inputs, and the hostname", () => {
    renderForm<TimeSeriesValues>(<TimeSeriesForm />, {
      defaultValues: { timeSeries: PRESET },
    });
    expect(document.getElementById("timeSeries-receive-ip")).not.toBeNull();
    expect(document.getElementById("timeSeries-receive-port")).not.toBeNull();
    expect(document.getElementById("timeSeries-send-port")).not.toBeNull();
    expect(document.getElementById("timeSeries-hostname")).not.toBeNull();
  });

  it("surfaces inline errors for IP, both ports, and hostname", async () => {
    renderForm<TimeSeriesValues>(<TimeSeriesForm />, {
      defaultValues: { timeSeries: PRESET },
      errors: {
        "timeSeries.dataStoreIp": "ip error",
        "timeSeries.receivePort": "rx error",
        "timeSeries.sendPort": "tx error",
        "timeSeries.dataStoreHostname": "hostname error",
      },
    });
    expect(await screen.findByText("ip error")).toBeTruthy();
    expect(screen.getByText("rx error")).toBeTruthy();
    expect(screen.getByText("tx error")).toBeTruthy();
    expect(screen.getByText("hostname error")).toBeTruthy();
  });
});
