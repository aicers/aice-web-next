import { describe, expect, it } from "vitest";

import {
  type BooleanLabels,
  formatCount,
  formatDurationNs,
  formatEndpoint,
  formatFieldValue,
  protoLabel,
} from "@/lib/event/format";

const LABELS: BooleanLabels = { true: "Yes", false: "No" };

describe("formatFieldValue", () => {
  it("shows datetime and text scalars verbatim", () => {
    expect(formatFieldValue("2026-06-09T00:00:00Z", "datetime", LABELS)).toBe(
      "2026-06-09T00:00:00Z",
    );
    expect(formatFieldValue("C:/Windows", "text", LABELS)).toBe("C:/Windows");
  });

  it("keeps a StringNumber value as its string, never a coerced number", () => {
    // A u32 near its max must survive as-is (no Number rounding).
    expect(formatFieldValue("4294967295", "text", LABELS)).toBe("4294967295");
  });

  it("joins list fields and dashes an empty list", () => {
    expect(formatFieldValue(["a", "b"], "list", LABELS)).toBe("a, b");
    expect(formatFieldValue([], "list", LABELS)).toBe("—");
  });

  it("renders booleans as locale-aware labels", () => {
    expect(formatFieldValue(true, "boolean", LABELS)).toBe("Yes");
    expect(formatFieldValue(false, "boolean", LABELS)).toBe("No");
  });

  it("dashes empty/nullish text and datetime", () => {
    expect(formatFieldValue("", "text", LABELS)).toBe("—");
    expect(formatFieldValue(null, "datetime", LABELS)).toBe("—");
  });
});

describe("protoLabel", () => {
  it("labels the common protocols", () => {
    expect(protoLabel(6)).toBe("TCP");
    expect(protoLabel(17)).toBe("UDP");
    expect(protoLabel(1)).toBe("ICMP");
  });

  it("falls back to the number for unknown protocols", () => {
    expect(protoLabel(132)).toBe("132");
  });
});

describe("formatCount", () => {
  it("formats a u64 count with grouping without precision loss", () => {
    // 2^64 - 1 exceeds Number.MAX_SAFE_INTEGER; BigInt keeps it exact.
    expect(formatCount("18446744073709551615", "en-US")).toBe(
      "18,446,744,073,709,551,615",
    );
  });

  it("returns the raw string for non-numeric input", () => {
    expect(formatCount("n/a", "en-US")).toBe("n/a");
  });
});

describe("formatEndpoint", () => {
  it("joins an IPv4 address and port", () => {
    expect(formatEndpoint("10.0.0.1", 443)).toBe("10.0.0.1:443");
  });

  it("brackets an IPv6 address", () => {
    expect(formatEndpoint("::1", 443)).toBe("[::1]:443");
  });
});

describe("formatDurationNs", () => {
  it("renders sub-microsecond durations in nanoseconds", () => {
    expect(formatDurationNs("250")).toBe("250 ns");
  });

  it("renders microseconds", () => {
    expect(formatDurationNs("250000")).toBe("250.00 µs");
  });

  it("renders milliseconds", () => {
    expect(formatDurationNs("1500000")).toBe("1.50 ms");
  });

  it("renders seconds", () => {
    expect(formatDurationNs("1500000000")).toBe("1.50 s");
  });

  it("carries a rounding boundary into the whole part", () => {
    // 999.995 µs rounds to 1000.00, not the impossible 999.100.
    expect(formatDurationNs("999995")).toBe("1000.00 µs");
    // 999.9999 ms rounds the same way at the ms boundary.
    expect(formatDurationNs("999999999")).toBe("1000.00 ms");
  });

  it("returns the raw string for non-numeric input", () => {
    expect(formatDurationNs("")).toBe("");
  });
});
