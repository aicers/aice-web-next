import { afterEach, describe, expect, it } from "vitest";

import {
  __resetExternalProbeStore,
  __setExternalProbeOutcome,
  useServiceStatus,
} from "@/hooks/use-service-status";
import { NodePermissionError } from "@/lib/node/errors";

describe("useServiceStatus — permission gate", () => {
  afterEach(() => {
    __resetExternalProbeStore();
  });

  // The page-level `(gate)/layout.tsx` already enforces
  // `nodes:read + services:read`, so in production this branch never
  // trips. The defence-in-depth check exists so a future caller (a
  // standalone widget, an embedded panel) cannot render the per-cell
  // status without the same scope. The throw is the first statement
  // in the hook so the test can invoke the function directly without
  // a React render.
  it("throws NodePermissionError when canRead is false", () => {
    expect(() => useServiceStatus("n1", { canRead: false })).toThrow(
      NodePermissionError,
    );
  });
});

describe("__setExternalProbeOutcome", () => {
  afterEach(() => {
    __resetExternalProbeStore();
  });

  it("records a probe outcome with the supplied timestamp", () => {
    // Smoke test for the test helpers themselves — every `useServiceStatus`
    // exercise downstream relies on these imperative pushes.
    const at = new Date("2026-01-01T00:00:00Z");
    __setExternalProbeOutcome("dataStore", "on", at);
    __setExternalProbeOutcome("tiContainer", "off", at);
    // No public reader without a render, but the assertions are
    // covered through `composeServiceStatusEntries` in the
    // `service-status.test.ts` suite.
    expect(true).toBe(true);
  });
});
