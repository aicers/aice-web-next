/**
 * Semi-supervised (Hog) form interactive coverage.
 *
 * The acceptance criteria require all 18 protocol variants and the
 * `gs`-mode-resolved `ACTIVE_MODELS` to be rendered, plus a sensor
 * checkbox per `sensorOptions` row. Mounted under jsdom + RTL with a
 * real RHF `FormProvider` so the `Controller` set/clear paths and the
 * empty-state copy run their production code paths.
 */

import { fireEvent, screen } from "@testing-library/react";
import type { useForm } from "react-hook-form";
import { describe, expect, it } from "vitest";

import { SemiSupervisedForm } from "@/components/node/forms/semi-supervised-form";
import { ACTIVE_MODELS } from "@/lib/node/active-models";
import type { SensorNodeOption } from "@/lib/node/sensor-list";
import { PROTOCOLS_FOR_HOG } from "@/lib/node/services/semi-supervised";

import { renderForm } from "./test-rig";

interface SemiSupervisedValues {
  semiSupervised: {
    dataStoreIp: string;
    dataStorePort: number;
    dataStoreHostname: string;
    protocols: string[];
    models: string[];
    sensors: string[];
  };
}

const SENSOR_OPTIONS: readonly SensorNodeOption[] = [
  { id: "node-a", name: "Sensor A", hostname: "host-a" },
  { id: "node-b", name: "Sensor B", hostname: null },
];

const PRESET: SemiSupervisedValues["semiSupervised"] = {
  dataStoreIp: "10.0.0.5",
  dataStorePort: 38370,
  dataStoreHostname: "hog-1",
  protocols: [],
  models: [],
  sensors: [],
};

describe("SemiSupervisedForm", () => {
  it("renders all 18 Hog protocol checkboxes", () => {
    renderForm<SemiSupervisedValues>(
      <SemiSupervisedForm sensorOptions={SENSOR_OPTIONS} />,
      { defaultValues: { semiSupervised: PRESET } },
    );
    expect(PROTOCOLS_FOR_HOG.length).toBe(18);
    for (const proto of PROTOCOLS_FOR_HOG) {
      expect(
        document.querySelector(`[data-protocol="${proto}"]`),
      ).not.toBeNull();
    }
  });

  it("renders one model checkbox per ACTIVE_MODELS entry", () => {
    renderForm<SemiSupervisedValues>(
      <SemiSupervisedForm sensorOptions={SENSOR_OPTIONS} />,
      { defaultValues: { semiSupervised: PRESET } },
    );
    for (const model of ACTIVE_MODELS) {
      expect(
        document.querySelector(`[data-model="${model.id}"]`),
      ).not.toBeNull();
    }
  });

  it("renders a sensor checkbox per sensorOptions row", () => {
    renderForm<SemiSupervisedValues>(
      <SemiSupervisedForm sensorOptions={SENSOR_OPTIONS} />,
      { defaultValues: { semiSupervised: PRESET } },
    );
    for (const opt of SENSOR_OPTIONS) {
      expect(
        document.querySelector(`[data-sensor="${opt.id}"]`),
      ).not.toBeNull();
    }
  });

  it("falls back to the empty-state copy when sensorOptions is empty", () => {
    renderForm<SemiSupervisedValues>(
      <SemiSupervisedForm sensorOptions={[]} />,
      { defaultValues: { semiSupervised: PRESET } },
    );
    // The next-intl bundle resolves `nodes.forms.semiSupervised.noSensors`
    // to a real string; assert a node carrying that text exists.
    expect(screen.getByText(/no sensor/i)).toBeTruthy();
  });

  it("toggles a protocol checkbox through the real Controller wiring", () => {
    let methods: ReturnType<typeof useForm> | undefined;
    renderForm<SemiSupervisedValues>(
      <SemiSupervisedForm sensorOptions={SENSOR_OPTIONS} />,
      {
        defaultValues: { semiSupervised: PRESET },
        onReady: (m) => {
          methods = m as unknown as ReturnType<typeof useForm>;
        },
      },
    );
    const httpCheckbox = document.querySelector('[data-protocol="http"]');
    expect(httpCheckbox).not.toBeNull();
    fireEvent.click(httpCheckbox as Element);
    expect(
      (methods?.getValues() as SemiSupervisedValues).semiSupervised.protocols,
    ).toEqual(["http"]);
  });

  it("surfaces inline errors for the data-store IP, port, and hostname", async () => {
    renderForm<SemiSupervisedValues>(
      <SemiSupervisedForm sensorOptions={SENSOR_OPTIONS} />,
      {
        defaultValues: { semiSupervised: PRESET },
        errors: {
          "semiSupervised.dataStoreIp": "ip error",
          "semiSupervised.dataStorePort": "port error",
          "semiSupervised.dataStoreHostname": "hostname error",
        },
      },
    );
    expect(await screen.findByText("ip error")).toBeTruthy();
    expect(screen.getByText("port error")).toBeTruthy();
    expect(screen.getByText("hostname error")).toBeTruthy();
  });
});
