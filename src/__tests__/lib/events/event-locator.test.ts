import { describe, expect, it } from "vitest";

import { hasProtocolData } from "@/components/events/tabs/protocol-tab";
import type { Event } from "@/lib/detection/types";
import {
  decodeEventLocator,
  type EventLocator,
  encodeEventLocator,
  isEventAddressable,
  THREAT_LEVEL_TO_NUMBER,
} from "@/lib/events/event-locator";

const SAMPLE: EventLocator = {
  sensor: "sensor-1",
  time: "2026-04-22T10:00:00.000000000Z",
  origAddr: "10.0.0.5",
  origPort: 54321,
  respAddr: "203.0.113.45",
  respPort: 80,
  proto: 6,
  kind: "HttpThreat",
  level: "HIGH",
};

describe("event-locator", () => {
  it("round-trips a fully-populated payload", () => {
    const token = encodeEventLocator({
      __typename: SAMPLE.kind,
      time: SAMPLE.time,
      sensor: SAMPLE.sensor,
      level: SAMPLE.level,
      origAddr: SAMPLE.origAddr,
      origPort: SAMPLE.origPort,
      respAddr: SAMPLE.respAddr,
      respPort: SAMPLE.respPort,
      proto: SAMPLE.proto,
    });
    expect(token).not.toBeNull();
    if (!token) throw new Error("encoder returned null");
    const decoded = decodeEventLocator(token);
    expect(decoded).toEqual(SAMPLE);
  });

  it("returns null when addressing fields are missing", () => {
    const token = encodeEventLocator({
      __typename: "FooEvent",
      time: SAMPLE.time,
      sensor: SAMPLE.sensor,
      level: "LOW",
    });
    expect(token).toBeNull();
  });

  it("defaults missing ports/proto to 0 without losing the rest", () => {
    const token = encodeEventLocator({
      __typename: "FtpBruteForce",
      time: SAMPLE.time,
      sensor: "sensor-2",
      level: "MEDIUM",
      origAddr: "10.0.0.5",
      respAddr: "203.0.113.45",
      respPort: 21,
    });
    expect(token).not.toBeNull();
    if (!token) throw new Error("encoder returned null");
    const decoded = decodeEventLocator(token);
    expect(decoded).toEqual({
      sensor: "sensor-2",
      time: SAMPLE.time,
      origAddr: "10.0.0.5",
      origPort: 0,
      respAddr: "203.0.113.45",
      respPort: 21,
      proto: 0,
      kind: "FtpBruteForce",
      level: "MEDIUM",
    });
  });

  it("returns null for malformed tokens", () => {
    expect(decodeEventLocator("")).toBeNull();
    expect(decodeEventLocator("not-valid-base64!!")).toBeNull();
    // Valid base64 but the payload is not an object.
    expect(
      decodeEventLocator(Buffer.from('"string"').toString("base64url")),
    ).toBeNull();
  });

  it("returns null for a tampered token with the wrong shape", () => {
    const mutated = {
      sensor: 42, // wrong type
      time: SAMPLE.time,
      origAddr: SAMPLE.origAddr,
      origPort: SAMPLE.origPort,
      respAddr: SAMPLE.respAddr,
      respPort: SAMPLE.respPort,
      proto: SAMPLE.proto,
      kind: SAMPLE.kind,
      level: SAMPLE.level,
    };
    const token = Buffer.from(JSON.stringify(mutated)).toString("base64url");
    expect(decodeEventLocator(token)).toBeNull();
  });

  it("returns null when level is not a valid ThreatLevel", () => {
    const payload = { ...SAMPLE, level: "CRITICAL" as unknown };
    const token = Buffer.from(JSON.stringify(payload)).toString("base64url");
    expect(decodeEventLocator(token)).toBeNull();
  });

  it("returns null for well-shaped but semantically tampered tokens", () => {
    // Each case is a type-correct payload a hand-edited token could
    // carry. The decoder must reject all of them so the page renders
    // the "Invalid event link" state instead of hitting REview with
    // tampered values.
    const encode = (p: Record<string, unknown>) =>
      Buffer.from(JSON.stringify(p)).toString("base64url");

    // Empty sensor — fails non-empty check.
    expect(decodeEventLocator(encode({ ...SAMPLE, sensor: "" }))).toBeNull();

    // Empty / unparseable timestamp.
    expect(decodeEventLocator(encode({ ...SAMPLE, time: "" }))).toBeNull();
    expect(
      decodeEventLocator(encode({ ...SAMPLE, time: "not-a-date" })),
    ).toBeNull();
    expect(
      decodeEventLocator(encode({ ...SAMPLE, time: "2026-13-01T00:00:00Z" })),
    ).toBeNull();

    // Empty / non-IP-shaped addresses.
    expect(decodeEventLocator(encode({ ...SAMPLE, origAddr: "" }))).toBeNull();
    expect(decodeEventLocator(encode({ ...SAMPLE, respAddr: "" }))).toBeNull();
    expect(
      decodeEventLocator(
        encode({ ...SAMPLE, origAddr: "<script>alert(1)</script>" }),
      ),
    ).toBeNull();
    expect(
      decodeEventLocator(encode({ ...SAMPLE, respAddr: "example.com" })),
    ).toBeNull();

    // Kind outside the curated set.
    expect(
      decodeEventLocator(encode({ ...SAMPLE, kind: "not-a-real-kind" })),
    ).toBeNull();
    expect(decodeEventLocator(encode({ ...SAMPLE, kind: "" }))).toBeNull();

    // Out-of-range / non-integer numeric fields.
    expect(decodeEventLocator(encode({ ...SAMPLE, origPort: -1 }))).toBeNull();
    expect(
      decodeEventLocator(encode({ ...SAMPLE, respPort: 70000 })),
    ).toBeNull();
    expect(
      decodeEventLocator(encode({ ...SAMPLE, origPort: 3.14 })),
    ).toBeNull();
    expect(decodeEventLocator(encode({ ...SAMPLE, proto: 999 }))).toBeNull();
  });

  it("accepts an IPv6 responder address", () => {
    const payload = { ...SAMPLE, respAddr: "2001:db8::1" };
    const token = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const decoded = decodeEventLocator(token);
    expect(decoded?.respAddr).toBe("2001:db8::1");
  });

  it("accepts nanosecond-precision timestamps produced by REview", () => {
    const payload = {
      ...SAMPLE,
      time: "2026-04-22T10:00:00.123456789Z",
    };
    const token = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const decoded = decodeEventLocator(token);
    expect(decoded?.time).toBe("2026-04-22T10:00:00.123456789Z");
  });

  it("produces URL-safe base64 (no +, /, =)", () => {
    const token = encodeEventLocator({
      __typename: SAMPLE.kind,
      time: SAMPLE.time,
      sensor: SAMPLE.sensor,
      level: SAMPLE.level,
      origAddr: SAMPLE.origAddr,
      origPort: SAMPLE.origPort,
      respAddr: SAMPLE.respAddr,
      respPort: SAMPLE.respPort,
      proto: SAMPLE.proto,
    });
    expect(token).not.toBeNull();
    if (!token) throw new Error("encoder returned null");
    expect(token).not.toMatch(/[+/=]/);
  });

  it("exports the ThreatLevel->number mapping used by filter building", () => {
    expect(THREAT_LEVEL_TO_NUMBER).toEqual({ LOW: 1, MEDIUM: 2, HIGH: 3 });
  });

  it("isEventAddressable narrows events that carry origAddr/respAddr", () => {
    expect(
      isEventAddressable({
        __typename: "HttpThreat",
        time: SAMPLE.time,
        sensor: SAMPLE.sensor,
        confidence: 0.8,
        category: null,
        level: "HIGH",
        triageScores: null,
        origAddr: "10.0.0.5",
        respAddr: "203.0.113.45",
      } as never),
    ).toBe(true);
    expect(
      isEventAddressable({
        __typename: "HttpThreat",
        time: SAMPLE.time,
        sensor: SAMPLE.sensor,
        confidence: 0.8,
        category: null,
        level: "HIGH",
        triageScores: null,
      } as never),
    ).toBe(false);
  });

  it("encodes MultiHostPortScan via the first respAddrs entry", () => {
    const token = encodeEventLocator({
      __typename: "MultiHostPortScan",
      time: SAMPLE.time,
      sensor: SAMPLE.sensor,
      level: "HIGH",
      origAddr: "10.0.0.5",
      respAddrs: ["203.0.113.45", "203.0.113.46", "203.0.113.47"],
      respPort: 22,
      proto: 6,
    });
    expect(token).not.toBeNull();
    if (!token) throw new Error("encoder returned null");
    const decoded = decodeEventLocator(token);
    expect(decoded).toEqual({
      sensor: SAMPLE.sensor,
      time: SAMPLE.time,
      origAddr: "10.0.0.5",
      origPort: 0,
      respAddr: "203.0.113.45",
      respPort: 22,
      proto: 6,
      kind: "MultiHostPortScan",
      level: "HIGH",
    });
  });

  it("encodes ExternalDdos via the first origAddrs entry", () => {
    const token = encodeEventLocator({
      __typename: "ExternalDdos",
      time: SAMPLE.time,
      sensor: SAMPLE.sensor,
      level: "HIGH",
      origAddrs: ["10.0.0.5", "10.0.0.6", "10.0.0.7"],
      respAddr: "203.0.113.45",
      respPort: 80,
      proto: 6,
    });
    expect(token).not.toBeNull();
    if (!token) throw new Error("encoder returned null");
    const decoded = decodeEventLocator(token);
    expect(decoded).toEqual({
      sensor: SAMPLE.sensor,
      time: SAMPLE.time,
      origAddr: "10.0.0.5",
      origPort: 0,
      respAddr: "203.0.113.45",
      respPort: 80,
      proto: 6,
      kind: "ExternalDdos",
      level: "HIGH",
    });
  });

  it("isEventAddressable recognises array-originator subtypes", () => {
    expect(
      isEventAddressable({
        __typename: "ExternalDdos",
        time: SAMPLE.time,
        sensor: SAMPLE.sensor,
        confidence: 0.8,
        category: null,
        level: "HIGH",
        triageScores: null,
        origAddrs: ["10.0.0.5", "10.0.0.6"],
        respAddr: "203.0.113.45",
      } as never),
    ).toBe(true);
    expect(
      isEventAddressable({
        __typename: "ExternalDdos",
        time: SAMPLE.time,
        sensor: SAMPLE.sensor,
        confidence: 0.8,
        category: null,
        level: "HIGH",
        triageScores: null,
        origAddrs: [],
        respAddr: "203.0.113.45",
      } as never),
    ).toBe(false);
  });

  it("round-trips a BlocklistDns token", () => {
    const token = encodeEventLocator({
      __typename: "BlocklistDns",
      time: SAMPLE.time,
      sensor: SAMPLE.sensor,
      level: "MEDIUM",
      origAddr: "10.0.0.5",
      origPort: 53333,
      respAddr: "203.0.113.45",
      respPort: 53,
      proto: 17,
    });
    expect(token).not.toBeNull();
    if (!token) throw new Error("encoder returned null");
    const decoded = decodeEventLocator(token);
    expect(decoded).toEqual({
      sensor: SAMPLE.sensor,
      time: SAMPLE.time,
      origAddr: "10.0.0.5",
      origPort: 53333,
      respAddr: "203.0.113.45",
      respPort: 53,
      proto: 17,
      kind: "BlocklistDns",
      level: "MEDIUM",
    });
  });

  it("round-trips an FtpPlainText token", () => {
    const token = encodeEventLocator({
      __typename: "FtpPlainText",
      time: SAMPLE.time,
      sensor: SAMPLE.sensor,
      level: "LOW",
      origAddr: "10.0.0.5",
      origPort: 51000,
      respAddr: "203.0.113.45",
      respPort: 21,
      proto: 6,
    });
    expect(token).not.toBeNull();
    if (!token) throw new Error("encoder returned null");
    const decoded = decodeEventLocator(token);
    expect(decoded).toEqual({
      sensor: SAMPLE.sensor,
      time: SAMPLE.time,
      origAddr: "10.0.0.5",
      origPort: 51000,
      respAddr: "203.0.113.45",
      respPort: 21,
      proto: 6,
      kind: "FtpPlainText",
      level: "LOW",
    });
  });

  it.each([
    "HttpThreat",
    "DnsCovertChannel",
    "BlocklistDns",
    "PortScan",
    "MultiHostPortScan",
    "FtpBruteForce",
    "FtpPlainText",
    "NetworkThreat",
    "BlocklistConn",
  ])("decodes a token encoded for protocol-supported subtype %s", (typename) => {
    // Regression guard: every subtype ProtocolTab knows how to
    // render must also be in CURATED_EVENT_TYPENAMES, otherwise a
    // valid Quick-peek link for that subtype decodes to the
    // "Invalid event link" state.
    expect(
      hasProtocolData({
        __typename: typename,
        time: SAMPLE.time,
        sensor: SAMPLE.sensor,
        confidence: 0.8,
        category: null,
        level: "HIGH",
        triageScores: null,
      } as Event),
    ).toBe(true);
    const token = encodeEventLocator({
      __typename: typename,
      time: SAMPLE.time,
      sensor: SAMPLE.sensor,
      level: "HIGH",
      origAddr: "10.0.0.5",
      origPort: 40000,
      respAddr: "203.0.113.45",
      respPort: 443,
      proto: 6,
    });
    expect(token).not.toBeNull();
    if (!token) throw new Error("encoder returned null");
    const decoded = decodeEventLocator(token);
    expect(decoded).not.toBeNull();
    expect(decoded?.kind).toBe(typename);
  });

  it("isEventAddressable recognises array-responder subtypes", () => {
    expect(
      isEventAddressable({
        __typename: "MultiHostPortScan",
        time: SAMPLE.time,
        sensor: SAMPLE.sensor,
        confidence: 0.8,
        category: null,
        level: "HIGH",
        triageScores: null,
        origAddr: "10.0.0.5",
        respAddrs: ["203.0.113.45", "203.0.113.46"],
      } as never),
    ).toBe(true);
    expect(
      isEventAddressable({
        __typename: "MultiHostPortScan",
        time: SAMPLE.time,
        sensor: SAMPLE.sensor,
        confidence: 0.8,
        category: null,
        level: "HIGH",
        triageScores: null,
        origAddr: "10.0.0.5",
        respAddrs: [],
      } as never),
    ).toBe(false);
  });
});
