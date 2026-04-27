/**
 * Data-Store (Giganto) form interactive coverage.
 *
 * Mounts the real component under jsdom + RTL with a real RHF
 * `FormProvider` so the inline-error surfaces, the `<details>`
 * open-state path, and the actual `Controller` wiring all run their
 * production code paths.
 */

import { act, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { DataStoreForm } from "@/components/node/forms/data-store-form";
import {
  ACK_TRANSMISSION,
  GIGANTO_INGEST_PORT,
  GIGANTO_PUBLISH_PORT,
  GRAPHQL_PORT,
  MAX_LEVEL_BASE,
  MAX_OPEN_FILES,
  MAX_SUBCOMPACTION,
  RETENTION_PERIOD,
  THREAD_COUNT,
} from "@/lib/node/services/types";

import { renderForm } from "./test-rig";

interface DataStoreValues {
  dataStore: {
    receiveIp: string;
    receivePort: number;
    ackTransmission: number;
    sendIp: string;
    sendPort: number;
    webIp: string;
    webPort: number;
    retention: { value: number; unit: "d" | "w" | "M" };
    maxMbOfLevelBase: number;
    maxSubcompactions: number;
    numOfThread: number;
    maxOpenFiles: number;
  };
}

const PRESET_VALUES: DataStoreValues["dataStore"] = {
  receiveIp: "10.0.0.1",
  receivePort: GIGANTO_INGEST_PORT,
  ackTransmission: ACK_TRANSMISSION,
  sendIp: "10.0.0.1",
  sendPort: GIGANTO_PUBLISH_PORT,
  webIp: "10.0.0.1",
  webPort: GRAPHQL_PORT,
  retention: { value: RETENTION_PERIOD, unit: "d" },
  maxMbOfLevelBase: MAX_LEVEL_BASE,
  maxSubcompactions: MAX_SUBCOMPACTION,
  numOfThread: THREAD_COUNT,
  maxOpenFiles: MAX_OPEN_FILES,
};

function getAdvanced(): HTMLDetailsElement {
  const node = document.querySelector('[data-slot="data-store-advanced"]');
  if (!node) throw new Error("Advanced Options section missing from DOM");
  return node as HTMLDetailsElement;
}

describe("DataStoreForm", () => {
  beforeEach(() => {
    // Real RHF, no shared state — each test gets a fresh form.
  });

  it("renders inline error text for each retention sub-path and every RocksDB field", async () => {
    renderForm<DataStoreValues>(<DataStoreForm />, {
      defaultValues: { dataStore: PRESET_VALUES },
      errors: {
        "dataStore.retention.value": "must be at least 1",
        "dataStore.retention.unit": "must be d, w, or M",
        "dataStore.maxMbOfLevelBase": "max-mb error",
        "dataStore.maxSubcompactions": "max-subc error",
        "dataStore.numOfThread": "thread error",
        "dataStore.maxOpenFiles": "max-files error",
      },
    });
    expect(await screen.findByText("must be at least 1")).toBeTruthy();
    expect(screen.getByText("must be d, w, or M")).toBeTruthy();
    expect(screen.getByText("max-mb error")).toBeTruthy();
    expect(screen.getByText("max-subc error")).toBeTruthy();
    expect(screen.getByText("thread error")).toBeTruthy();
    expect(screen.getByText("max-files error")).toBeTruthy();
  });

  it("keeps Advanced Options closed when every value matches the preset", () => {
    renderForm<DataStoreValues>(<DataStoreForm />, {
      defaultValues: { dataStore: PRESET_VALUES },
    });
    expect(getAdvanced().open).toBe(false);
  });

  it("opens Advanced Options when retention value differs from preset", () => {
    renderForm<DataStoreValues>(<DataStoreForm />, {
      defaultValues: {
        dataStore: { ...PRESET_VALUES, retention: { value: 200, unit: "d" } },
      },
    });
    expect(getAdvanced().open).toBe(true);
  });

  it("opens Advanced Options when retention unit differs from preset", () => {
    renderForm<DataStoreValues>(<DataStoreForm />, {
      defaultValues: {
        dataStore: {
          ...PRESET_VALUES,
          retention: { value: RETENTION_PERIOD, unit: "w" },
        },
      },
    });
    expect(getAdvanced().open).toBe(true);
  });

  it("keeps Advanced Options closed when only ackTransmission differs from preset", () => {
    renderForm<DataStoreValues>(<DataStoreForm />, {
      defaultValues: {
        dataStore: { ...PRESET_VALUES, ackTransmission: ACK_TRANSMISSION + 1 },
      },
    });
    expect(getAdvanced().open).toBe(false);
  });

  it("re-syncs Advanced Options open state after form.reset() to a non-default draft", async () => {
    let methodsRef!: Parameters<
      NonNullable<Parameters<typeof renderForm<DataStoreValues>>[1]["onReady"]>
    >[0];
    renderForm<DataStoreValues>(<DataStoreForm />, {
      defaultValues: { dataStore: PRESET_VALUES },
      onReady: (m) => {
        methodsRef = m;
      },
    });
    // Closed initially because every value matches the preset.
    expect(getAdvanced().open).toBe(false);
    // Phase Node-9b's stale-conflict replay path drops a hydrated
    // draft into the shared form context via `reset(...)`. The
    // Advanced Options disclosure must follow that draft, not the
    // first-render snapshot.
    await act(async () => {
      methodsRef.reset({
        dataStore: { ...PRESET_VALUES, retention: { value: 200, unit: "d" } },
      });
    });
    expect(getAdvanced().open).toBe(true);
    // Re-syncs in the other direction too: resetting back to preset
    // values closes the section.
    await act(async () => {
      methodsRef.reset({ dataStore: PRESET_VALUES });
    });
    expect(getAdvanced().open).toBe(false);
  });

  it("opens Advanced Options when any RocksDB field differs from preset", () => {
    for (const override of [
      { maxMbOfLevelBase: MAX_LEVEL_BASE + 1 },
      { maxSubcompactions: MAX_SUBCOMPACTION + 1 },
      { numOfThread: THREAD_COUNT + 1 },
      { maxOpenFiles: MAX_OPEN_FILES + 1 },
    ]) {
      const { unmount } = renderForm<DataStoreValues>(<DataStoreForm />, {
        defaultValues: { dataStore: { ...PRESET_VALUES, ...override } },
      });
      expect(getAdvanced().open).toBe(true);
      unmount();
    }
  });
});
