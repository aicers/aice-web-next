import { describe, expect, it } from "vitest";

import { diffServiceConfig } from "@/lib/node/diff";
import {
  defaultDataStoreValues,
  serialiseDataStore,
} from "@/lib/node/services/data-store";
import {
  defaultSensorValues,
  serialiseSensor,
} from "@/lib/node/services/sensor";
import {
  defaultTiContainerValues,
  serialiseTiContainer,
} from "@/lib/node/services/ti-container";

describe("diffServiceConfig", () => {
  it("returns an empty array when applied and draft match byte-for-byte", () => {
    const v = {
      ...defaultDataStoreValues(),
      receiveIp: "10.0.0.1",
      sendIp: "10.0.0.1",
      webIp: "10.0.0.1",
    };
    const wire = serialiseDataStore(v);
    expect(diffServiceConfig(wire, wire)).toEqual([]);
  });

  it("returns an empty array when both inputs are null / empty", () => {
    expect(diffServiceConfig(null, null)).toEqual([]);
    expect(diffServiceConfig("", "")).toEqual([]);
    expect(diffServiceConfig(null, "")).toEqual([]);
  });

  it("reports changed scalar fields with rendered wire values", () => {
    const applied = serialiseDataStore({
      ...defaultDataStoreValues(),
      receiveIp: "10.0.0.1",
      sendIp: "10.0.0.1",
      webIp: "10.0.0.1",
    });
    const draft = serialiseDataStore({
      ...defaultDataStoreValues(),
      receiveIp: "10.0.0.1",
      sendIp: "10.0.0.1",
      webIp: "10.0.0.1",
      maxOpenFiles: 9001,
      retention: { value: 30, unit: "d" },
    });
    const diff = diffServiceConfig(applied, draft);
    const fields = diff.map((d) => d.fieldPath).sort();
    expect(fields).toEqual(["max_open_files", "retention"]);
    const retention = diff.find((d) => d.fieldPath === "retention");
    expect(retention?.applied).toBe("100d");
    expect(retention?.draft).toBe("30d");
    const maxOpen = diff.find((d) => d.fieldPath === "max_open_files");
    expect(maxOpen?.applied).toBe("8000");
    expect(maxOpen?.draft).toBe("9001");
  });

  it("reports added fields (applied null, draft has value)", () => {
    const draft = serialiseDataStore({
      ...defaultDataStoreValues(),
      receiveIp: "10.0.0.1",
      sendIp: "10.0.0.1",
      webIp: "10.0.0.1",
    });
    const diff = diffServiceConfig(null, draft);
    expect(diff.length).toBeGreaterThan(0);
    for (const entry of diff) {
      expect(entry.applied).toBeNull();
      expect(entry.draft).not.toBeNull();
    }
  });

  it("reports removed fields (applied has value, draft is null)", () => {
    const applied = serialiseTiContainer(defaultTiContainerValues());
    const diff = diffServiceConfig(applied, null);
    expect(diff.length).toBeGreaterThan(0);
    for (const entry of diff) {
      expect(entry.applied).not.toBeNull();
      expect(entry.draft).toBeNull();
    }
  });

  it("renders array values as comma-separated wire literals", () => {
    const applied = serialiseSensor({
      ...defaultSensorValues(),
      dataStoreIp: "10.0.0.1",
      dataStoreHostname: "data-store",
      pciBusAddresses: ["0000:01:00.0"],
    });
    const draft = serialiseSensor({
      ...defaultSensorValues(),
      dataStoreIp: "10.0.0.1",
      dataStoreHostname: "data-store",
      pciBusAddresses: ["0000:01:00.0", "0000:02:00.0"],
    });
    const diff = diffServiceConfig(applied, draft);
    const dpdkIn = diff.find((d) => d.fieldPath === "dpdk_inputs");
    expect(dpdkIn?.applied).toBe("0000:01:00.0");
    expect(dpdkIn?.draft).toBe("0000:01:00.0, 0000:02:00.0");
  });

  it("treats array reordering as a change (wire order is significant)", () => {
    const applied = serialiseSensor({
      ...defaultSensorValues(),
      dataStoreIp: "10.0.0.1",
      dataStoreHostname: "host",
      pciBusAddresses: ["0000:01:00.0", "0000:02:00.0"],
    });
    const draft = serialiseSensor({
      ...defaultSensorValues(),
      dataStoreIp: "10.0.0.1",
      dataStoreHostname: "host",
      pciBusAddresses: ["0000:02:00.0", "0000:01:00.0"],
    });
    const diff = diffServiceConfig(applied, draft);
    expect(diff.some((d) => d.fieldPath === "dpdk_inputs")).toBe(true);
  });

  it("preserves ordering: applied keys first, then draft-only keys", () => {
    const applied = "alpha = 1\nbeta = 2\n";
    const draft = "alpha = 1\nbeta = 3\ngamma = 4\n";
    const diff = diffServiceConfig(applied, draft);
    expect(diff.map((d) => d.fieldPath)).toEqual(["beta", "gamma"]);
  });

  it("handles boolean and integer rendering symmetrically", () => {
    const diff = diffServiceConfig(
      "flag = false\ncount = 1\n",
      "flag = true\ncount = 2\n",
    );
    expect(diff).toEqual([
      { fieldPath: "flag", applied: "false", draft: "true" },
      { fieldPath: "count", applied: "1", draft: "2" },
    ]);
  });
});
