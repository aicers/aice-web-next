/**
 * Sensor (Piglet) form interactive coverage. Mounted under jsdom + RTL
 * with a real RHF `FormProvider` so the conditional Dump-HTTP-Content
 * group, the protocol-checkbox `Controller` wiring, and the inline
 * `FieldError` slots all run their production code paths.
 */

import { fireEvent, screen } from "@testing-library/react";
import type { useForm } from "react-hook-form";
import { describe, expect, it } from "vitest";

import { SensorForm } from "@/components/node/forms/sensor-form";
import {
  DUMP_HTTP_CONTENT_TYPES,
  DUMP_ITEMS,
  PROTOCOLS_FOR_PIGLET,
} from "@/lib/node/services/sensor";

import { renderForm } from "./test-rig";

interface SensorValues {
  sensor: {
    dataStoreIp: string;
    dataStorePort: number;
    dataStoreHostname: string;
    pciBusAddresses: string[];
    protocols: string[];
    ftpPorts: number[];
    httpPorts: number[];
    httpsPorts: number[];
    sshPorts: number[];
    dumpItems: string[];
    dumpHttpContentTypes: string[];
    pcapMaxSize: number;
  };
}

const PRESET: SensorValues["sensor"] = {
  dataStoreIp: "10.0.0.2",
  dataStorePort: 38370,
  dataStoreHostname: "node-1",
  pciBusAddresses: ["0000:00:1f.6"],
  protocols: [...PROTOCOLS_FOR_PIGLET],
  ftpPorts: [21],
  httpPorts: [80, 8000, 8080],
  httpsPorts: [443],
  sshPorts: [22],
  dumpItems: [...DUMP_ITEMS],
  dumpHttpContentTypes: [...DUMP_HTTP_CONTENT_TYPES],
  pcapMaxSize: 1000,
};

describe("SensorForm", () => {
  it("renders a checkbox for every Piglet protocol variant", () => {
    renderForm<SensorValues>(<SensorForm />, {
      defaultValues: { sensor: PRESET },
    });
    for (const proto of PROTOCOLS_FOR_PIGLET) {
      expect(
        document.querySelector(`[data-protocol="${proto}"]`),
      ).not.toBeNull();
    }
  });

  it("hides the Dump HTTP Content Types section when http is not in dumpItems", () => {
    renderForm<SensorValues>(<SensorForm />, {
      defaultValues: { sensor: { ...PRESET, dumpItems: ["pcap"] } },
    });
    for (const variant of DUMP_HTTP_CONTENT_TYPES) {
      expect(
        document.querySelector(`[data-dump-http-content="${variant}"]`),
      ).toBeNull();
    }
  });

  it("shows the Dump HTTP Content Types section when http is in dumpItems", () => {
    renderForm<SensorValues>(<SensorForm />, {
      defaultValues: { sensor: { ...PRESET, dumpItems: ["http"] } },
    });
    for (const variant of DUMP_HTTP_CONTENT_TYPES) {
      expect(
        document.querySelector(`[data-dump-http-content="${variant}"]`),
      ).not.toBeNull();
    }
  });

  it("toggles the Dump HTTP Content Types group as `http` is added/removed via the real Controller path", () => {
    let methods: ReturnType<typeof useForm> | undefined;
    renderForm<SensorValues>(<SensorForm />, {
      defaultValues: { sensor: { ...PRESET, dumpItems: [] } },
      onReady: (m) => {
        methods = m as unknown as ReturnType<typeof useForm>;
      },
    });
    // Initially hidden.
    expect(document.querySelector(`[data-dump-http-content]`)).toBeNull();
    // Click the http checkbox.
    const httpDump = document.querySelector('[data-dump-item="http"]');
    expect(httpDump).not.toBeNull();
    fireEvent.click(httpDump as Element);
    // Now visible.
    expect(document.querySelector(`[data-dump-http-content]`)).not.toBeNull();
    // RHF state reflects the click.
    expect((methods?.getValues() as SensorValues).sensor.dumpItems).toContain(
      "http",
    );
  });

  it("surfaces inline errors for the data-store, hostname, and pcap-size fields", async () => {
    renderForm<SensorValues>(<SensorForm />, {
      defaultValues: { sensor: PRESET },
      errors: {
        "sensor.dataStoreIp": "ip error",
        "sensor.dataStoreHostname": "hostname error",
        "sensor.pcapMaxSize": "pcap error",
      },
    });
    expect(await screen.findByText("ip error")).toBeTruthy();
    expect(screen.getByText("hostname error")).toBeTruthy();
    expect(screen.getByText("pcap error")).toBeTruthy();
  });
});
