import { describe, expect, it } from "vitest";

import {
  EMPTY_EVENT_FILTER,
  type EventFilter,
  filterToSearchEntries,
  isPortInRange,
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
    });
    expect(filter.sensor).toBe("s1");
    expect(filter.origPortStart).toBe(443);
    expect(filter.origPortEnd).toBeNull();
    expect(filter.respPortStart).toBeNull();
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
