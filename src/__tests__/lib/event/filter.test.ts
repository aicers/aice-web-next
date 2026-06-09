import { describe, expect, it } from "vitest";

import {
  EMPTY_EVENT_FILTER,
  type EventFilter,
  filterToSearchEntries,
  isPortInRange,
  isPortString,
  MAX_PORT,
  MIN_PORT,
  parseFilterFromSearchParams,
  toNetworkFilter,
} from "@/lib/event/filter";

describe("isPortInRange", () => {
  it("accepts whole numbers within the 16-bit range", () => {
    expect(isPortInRange(MIN_PORT)).toBe(true);
    expect(isPortInRange(443)).toBe(true);
    expect(isPortInRange(MAX_PORT)).toBe(true);
  });

  it("rejects out-of-range or non-integer values", () => {
    expect(isPortInRange(-1)).toBe(false);
    expect(isPortInRange(MAX_PORT + 1)).toBe(false);
    expect(isPortInRange(70000)).toBe(false);
    expect(isPortInRange(443.5)).toBe(false);
    expect(isPortInRange(Number.NaN)).toBe(false);
  });
});

describe("isPortString", () => {
  it("accepts base-10 integer literals within range", () => {
    expect(isPortString("0")).toBe(true);
    expect(isPortString("443")).toBe(true);
    expect(isPortString(String(MAX_PORT))).toBe(true);
    // Leading zeros are still all-digit and parse in range.
    expect(isPortString("08")).toBe(true);
  });

  it("rejects out-of-range integers", () => {
    expect(isPortString("65536")).toBe(false);
    expect(isPortString("70000")).toBe(false);
  });

  // Regression for the form parser: `Number.parseInt` would truncate
  // these to a different, valid-looking port (`443.5` -> 443, `1e3`
  // -> 1). The integer-literal contract rejects them outright so the
  // form blocks Apply instead of querying a port the operator never
  // typed.
  it("rejects decimal, exponent, hex, signed, and blank input", () => {
    expect(isPortString("443.5")).toBe(false);
    expect(isPortString("1e3")).toBe(false);
    expect(isPortString("0x10")).toBe(false);
    expect(isPortString("-1")).toBe(false);
    expect(isPortString("+443")).toBe(false);
    expect(isPortString("")).toBe(false);
    expect(isPortString("443 ")).toBe(false);
    expect(isPortString("abc")).toBe(false);
  });
});

describe("toNetworkFilter", () => {
  it("returns null when no sensor is selected", () => {
    expect(toNetworkFilter(EMPTY_EVENT_FILTER)).toBeNull();
  });

  it("emits only the sensor when no other field is set", () => {
    expect(toNetworkFilter({ ...EMPTY_EVENT_FILTER, sensor: "s1" })).toEqual({
      sensor: "s1",
    });
  });

  it("includes time, ip, and port ranges when set", () => {
    const filter: EventFilter = {
      ...EMPTY_EVENT_FILTER,
      sensor: "s1",
      start: "2026-06-09T00:00:00Z",
      end: "2026-06-09T01:00:00Z",
      origAddrStart: "10.0.0.1",
      respPortStart: 0,
      respPortEnd: 1024,
    };
    expect(toNetworkFilter(filter)).toEqual({
      sensor: "s1",
      time: { start: "2026-06-09T00:00:00Z", end: "2026-06-09T01:00:00Z" },
      origAddr: { start: "10.0.0.1", end: null },
      respPort: { start: 0, end: 1024 },
    });
  });

  it("treats port 0 as a present bound", () => {
    const filter: EventFilter = {
      ...EMPTY_EVENT_FILTER,
      sensor: "s1",
      origPortStart: 0,
    };
    expect(toNetworkFilter(filter)?.origPort).toEqual({ start: 0, end: null });
  });

  it("strips port bounds for the Icmp record type", () => {
    const filter: EventFilter = {
      ...EMPTY_EVENT_FILTER,
      recordType: "icmp",
      sensor: "s1",
      origAddrStart: "10.0.0.1",
      origPortStart: 100,
      respPortEnd: 200,
    };
    const result = toNetworkFilter(filter);
    expect(result?.origPort).toBeUndefined();
    expect(result?.respPort).toBeUndefined();
    // Non-port bounds still apply for Icmp.
    expect(result?.origAddr).toEqual({ start: "10.0.0.1", end: null });
  });

  it("emits sensor/time/agentId and drops IP/port for a sysmon type", () => {
    const filter: EventFilter = {
      ...EMPTY_EVENT_FILTER,
      recordType: "processCreate",
      sensor: "s1",
      start: "2026-06-09T00:00:00Z",
      end: "2026-06-09T01:00:00Z",
      agentId: "agent-1",
      // Stale network values from a prior network record type must not
      // leak into the sysmon filter.
      origAddrStart: "10.0.0.1",
      origPortStart: 100,
      respPortEnd: 200,
    };
    const result = toNetworkFilter(filter);
    expect(result).toEqual({
      sensor: "s1",
      time: { start: "2026-06-09T00:00:00Z", end: "2026-06-09T01:00:00Z" },
      agentId: "agent-1",
    });
    expect(result?.origAddr).toBeUndefined();
    expect(result?.respAddr).toBeUndefined();
    expect(result?.origPort).toBeUndefined();
    expect(result?.respPort).toBeUndefined();
  });

  it("omits agentId when unset for a sysmon type", () => {
    const filter: EventFilter = {
      ...EMPTY_EVENT_FILTER,
      recordType: "dnsQuery",
      sensor: "s1",
    };
    expect(toNetworkFilter(filter)).toEqual({ sensor: "s1" });
  });

  it("drops a stale agentId for a network/Conn record type", () => {
    const filter: EventFilter = {
      ...EMPTY_EVENT_FILTER,
      recordType: "conn",
      sensor: "s1",
      agentId: "agent-1",
      origAddrStart: "10.0.0.1",
    };
    const result = toNetworkFilter(filter);
    expect(result?.agentId).toBeUndefined();
    expect(result?.origAddr).toEqual({ start: "10.0.0.1", end: null });
  });
});

describe("parseFilterFromSearchParams", () => {
  it("defaults the record type and leaves fields null", () => {
    const filter = parseFilterFromSearchParams({});
    expect(filter.recordType).toBe("conn");
    expect(filter.sensor).toBeNull();
    expect(filter.origPortStart).toBeNull();
  });

  it("reads valid values and drops invalid ports", () => {
    const filter = parseFilterFromSearchParams({
      sensor: "s1",
      origPortStart: "443",
      origPortEnd: "70000",
      respPortStart: "abc",
      // Decimal/exponent must not be coerced to a different port.
      respPortEnd: "443.5",
    });
    expect(filter.sensor).toBe("s1");
    expect(filter.origPortStart).toBe(443);
    expect(filter.origPortEnd).toBeNull();
    expect(filter.respPortStart).toBeNull();
    expect(filter.respPortEnd).toBeNull();
  });

  it("round-trips through filterToSearchEntries", () => {
    const filter: EventFilter = {
      ...EMPTY_EVENT_FILTER,
      sensor: "s1",
      start: "2026-06-09T00:00:00Z",
      origAddrStart: "10.0.0.1",
      origPortStart: 443,
    };
    const params = Object.fromEntries(filterToSearchEntries(filter));
    expect(parseFilterFromSearchParams(params)).toEqual(filter);
  });

  it("omits the default record type from the entries", () => {
    const entries = filterToSearchEntries({
      ...EMPTY_EVENT_FILTER,
      sensor: "s1",
    });
    expect(entries.find(([key]) => key === "type")).toBeUndefined();
  });
});

describe("filterToSearchEntries family allow-list", () => {
  // The URL serialization must be family-aware too: `toNetworkFilter`
  // already drops cross-family fields from the query, but if they
  // persisted in the URL they would silently reactivate on reload or
  // when switching record type back.
  it("drops stale IP/port for a sysmon record type", () => {
    const params = Object.fromEntries(
      filterToSearchEntries({
        ...EMPTY_EVENT_FILTER,
        recordType: "processCreate",
        sensor: "s1",
        agentId: "agent-1",
        // Stale network values typed before switching families.
        origAddrStart: "10.0.0.1",
        origPortStart: 443,
        respPortEnd: 1024,
      }),
    );
    expect(params).toEqual({
      type: "processCreate",
      sensor: "s1",
      agentId: "agent-1",
    });
  });

  it("drops a stale agentId for a network record type", () => {
    const params = Object.fromEntries(
      filterToSearchEntries({
        ...EMPTY_EVENT_FILTER,
        recordType: "conn",
        sensor: "s1",
        origPortStart: 443,
        // Stale sysmon value typed before switching back to a network type.
        agentId: "agent-1",
      }),
    );
    expect(params.agentId).toBeUndefined();
    expect(params.origPortStart).toBe("443");
  });

  it("drops stale port bounds for the Icmp record type", () => {
    const params = Object.fromEntries(
      filterToSearchEntries({
        ...EMPTY_EVENT_FILTER,
        recordType: "icmp",
        sensor: "s1",
        origAddrStart: "10.0.0.1",
        origPortStart: 100,
        respPortEnd: 200,
      }),
    );
    expect(params.origPortStart).toBeUndefined();
    expect(params.respPortEnd).toBeUndefined();
    // Non-port bounds still serialize for Icmp.
    expect(params.origAddrStart).toBe("10.0.0.1");
  });
});
