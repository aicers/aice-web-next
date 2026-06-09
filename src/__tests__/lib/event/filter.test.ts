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

  // Bidirectional family allow-list: the sent NetworkFilter only ever
  // carries fields that belong to the selected record family, so neither
  // direction can leak a stale field.
  it("drops stale IP/port for a sysmon type, keeping sensor/time/agentId", () => {
    const filter: EventFilter = {
      ...EMPTY_EVENT_FILTER,
      recordType: "processCreateEvents",
      sensor: "s1",
      start: "2026-06-09T00:00:00Z",
      agentId: "agent-1",
      // Stale network bounds that must NOT be sent for a sysmon type.
      origAddrStart: "10.0.0.1",
      respAddrEnd: "10.0.0.9",
      origPortStart: 80,
      respPortEnd: 443,
    };
    expect(toNetworkFilter(filter)).toEqual({
      sensor: "s1",
      time: { start: "2026-06-09T00:00:00Z", end: null },
      agentId: "agent-1",
    });
  });

  it("drops a stale agentId for a network (Conn) type", () => {
    const filter: EventFilter = {
      ...EMPTY_EVENT_FILTER,
      recordType: "conn",
      sensor: "s1",
      origPortStart: 443,
      // Stale agentId that must NOT be sent for the network family.
      agentId: "agent-1",
    };
    const networkFilter = toNetworkFilter(filter);
    expect(networkFilter).not.toHaveProperty("agentId");
    expect(networkFilter).toEqual({
      sensor: "s1",
      origPort: { start: 443, end: null },
    });
  });

  it("omits an empty agentId for a sysmon type", () => {
    const filter: EventFilter = {
      ...EMPTY_EVENT_FILTER,
      recordType: "dnsQueryEvents",
      sensor: "s1",
      agentId: null,
    };
    expect(toNetworkFilter(filter)).toEqual({ sensor: "s1" });
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
