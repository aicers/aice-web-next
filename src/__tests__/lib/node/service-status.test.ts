import { describe, expect, it } from "vitest";

import {
  AGENT_KIND_TO_SERVICE,
  ALL_SERVICE_KINDS,
  applyDeadNodeOverride,
  composeServiceStatusEntries,
  EXTERNAL_KIND_TO_SERVICE,
  entriesToStatusMap,
  mapAgentStatus,
  mapExternalStatus,
  mapExternalStoredStatus,
  type ServiceStatus,
} from "@/lib/node/service-status";
import type { AgentStatus, ExternalServiceStatus } from "@/lib/node/types";

describe("mapAgentStatus", () => {
  // Phase Node-7 (#313) acceptance: every row of the mapping table is
  // covered explicitly so a future enum drift surfaces here rather
  // than as an "Off" badge in production.
  const cases: Array<[AgentStatus, ServiceStatus]> = [
    ["DISABLED", "off"],
    ["UNKNOWN", "off"],
    ["ENABLED", "on"],
    ["RELOAD_FAILED", "idle"],
  ];

  for (const [stored, expected] of cases) {
    it(`maps ${stored} → ${expected}`, () => {
      expect(mapAgentStatus(stored)).toBe(expected);
    });
  }
});

describe("mapExternalStatus", () => {
  it("maps a successful probe to on", () => {
    expect(mapExternalStatus("on")).toBe("on");
  });
  it("maps a failed probe to off", () => {
    expect(mapExternalStatus("off")).toBe("off");
  });
  it("treats unknown (pre-first-probe) as off", () => {
    expect(mapExternalStatus("unknown")).toBe("off");
  });
});

describe("mapExternalStoredStatus", () => {
  // External `storedStatus` is not the v1 driver — `mapExternalStatus`
  // (live probe) wins — but the helper exists for graceful fallback,
  // so the mapping is locked down to prevent drift.
  const cases: Array<[ExternalServiceStatus, ServiceStatus]> = [
    ["ENABLED", "on"],
    ["DISABLED", "off"],
    ["UNKNOWN", "off"],
    ["RELOAD_FAILED", "off"],
  ];
  for (const [stored, expected] of cases) {
    it(`maps ${stored} → ${expected}`, () => {
      expect(mapExternalStoredStatus(stored)).toBe(expected);
    });
  }
});

describe("applyDeadNodeOverride", () => {
  it("forces every status to off when ping is null (dead node)", () => {
    expect(applyDeadNodeOverride(null, "on")).toBe("off");
    expect(applyDeadNodeOverride(null, "idle")).toBe("off");
    expect(applyDeadNodeOverride(null, "off")).toBe("off");
  });
  it("passes the status through when ping is a number (alive node)", () => {
    expect(applyDeadNodeOverride(0, "on")).toBe("on");
    expect(applyDeadNodeOverride(3.14, "idle")).toBe("idle");
    expect(applyDeadNodeOverride(42, "off")).toBe("off");
  });
});

describe("composeServiceStatusEntries", () => {
  function call(
    input: Parameters<typeof composeServiceStatusEntries>[0],
  ): ReturnType<typeof composeServiceStatusEntries> {
    return composeServiceStatusEntries(input);
  }

  it("returns all-absent when live is null (pre-first-poll)", () => {
    const result = call({
      live: null,
      externalProbes: { dataStore: "on", tiContainer: "on" },
    });
    for (const kind of ALL_SERVICE_KINDS) {
      expect(result[kind].status).toBe("off");
      expect(result[kind].reason.kind).toBe("absent");
    }
  });

  it("maps each agent kind to its column with the correct status", () => {
    const result = call({
      live: {
        ping: 1,
        agents: [
          { kind: "SENSOR", storedStatus: "ENABLED" },
          { kind: "UNSUPERVISED", storedStatus: "DISABLED" },
          { kind: "SEMI_SUPERVISED", storedStatus: "RELOAD_FAILED" },
          { kind: "TIME_SERIES_GENERATOR", storedStatus: "UNKNOWN" },
        ],
        externalServices: [],
      },
      externalProbes: { dataStore: "unknown", tiContainer: "unknown" },
    });
    expect(result.sensor).toEqual({
      status: "on",
      reason: { kind: "agent", storedStatus: "ENABLED" },
    });
    expect(result.unsupervised).toEqual({
      status: "off",
      reason: { kind: "agent", storedStatus: "DISABLED" },
    });
    expect(result.semiSupervised).toEqual({
      status: "idle",
      reason: { kind: "agent", storedStatus: "RELOAD_FAILED" },
    });
    expect(result.timeSeries).toEqual({
      status: "off",
      reason: { kind: "agent", storedStatus: "UNKNOWN" },
    });
  });

  it("maps external services from the live probe outcome", () => {
    const result = call({
      live: {
        ping: 1,
        agents: [],
        externalServices: [{ kind: "DATA_STORE" }, { kind: "TI_CONTAINER" }],
      },
      externalProbes: { dataStore: "on", tiContainer: "off" },
    });
    expect(result.dataStore).toEqual({
      status: "on",
      reason: { kind: "external", outcome: "on" },
    });
    expect(result.tiContainer).toEqual({
      status: "off",
      reason: { kind: "external", outcome: "off" },
    });
  });

  it("treats unknown probe outcome as off (defensive default)", () => {
    const result = call({
      live: {
        ping: 1,
        agents: [],
        externalServices: [{ kind: "DATA_STORE" }],
      },
      externalProbes: { dataStore: "unknown", tiContainer: "unknown" },
    });
    expect(result.dataStore.status).toBe("off");
  });

  it("forces every agent / external cell to off when ping is null (dead node)", () => {
    const result = call({
      live: {
        ping: null,
        agents: [
          { kind: "SENSOR", storedStatus: "ENABLED" },
          { kind: "SEMI_SUPERVISED", storedStatus: "RELOAD_FAILED" },
        ],
        externalServices: [{ kind: "DATA_STORE" }],
      },
      externalProbes: { dataStore: "on", tiContainer: "on" },
    });
    expect(result.sensor.status).toBe("off");
    expect(result.sensor.reason.kind).toBe("deadNode");
    expect(result.semiSupervised.status).toBe("off");
    expect(result.semiSupervised.reason.kind).toBe("deadNode");
    expect(result.dataStore.status).toBe("off");
    expect(result.dataStore.reason.kind).toBe("deadNode");
  });

  it("leaves columns absent when the node does not configure that service", () => {
    const result = call({
      live: {
        ping: 1,
        agents: [{ kind: "SENSOR", storedStatus: "ENABLED" }],
        externalServices: [],
      },
      externalProbes: { dataStore: "on", tiContainer: "on" },
    });
    expect(result.sensor.reason.kind).toBe("agent");
    expect(result.unsupervised.reason.kind).toBe("absent");
    expect(result.dataStore.reason.kind).toBe("absent");
  });
});

describe("entriesToStatusMap", () => {
  it("projects entries to a flat status map", () => {
    const entries = composeServiceStatusEntries({
      live: {
        ping: 1,
        agents: [{ kind: "SENSOR", storedStatus: "ENABLED" }],
        externalServices: [{ kind: "DATA_STORE" }],
      },
      externalProbes: { dataStore: "off", tiContainer: "unknown" },
    });
    const map = entriesToStatusMap(entries);
    expect(map.sensor).toBe("on");
    expect(map.dataStore).toBe("off");
    expect(map.tiContainer).toBe("off");
    expect(map.unsupervised).toBe("off"); // absent → off
  });
});

describe("kind mappings", () => {
  it("maps every AgentKind to a unique ServiceKind column", () => {
    const values = Object.values(AGENT_KIND_TO_SERVICE);
    expect(new Set(values).size).toBe(values.length);
    expect(values).toEqual(
      expect.arrayContaining([
        "sensor",
        "unsupervised",
        "semiSupervised",
        "timeSeries",
      ]),
    );
  });
  it("maps every ExternalServiceKind to a unique ServiceKind column", () => {
    const values = Object.values(EXTERNAL_KIND_TO_SERVICE);
    expect(new Set(values).size).toBe(values.length);
    expect(values).toEqual(
      expect.arrayContaining(["dataStore", "tiContainer"]),
    );
  });
  it("ALL_SERVICE_KINDS holds the six agent + external columns in order", () => {
    expect(ALL_SERVICE_KINDS).toEqual([
      "sensor",
      "unsupervised",
      "semiSupervised",
      "timeSeries",
      "dataStore",
      "tiContainer",
    ]);
  });
});
