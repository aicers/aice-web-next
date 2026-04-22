import { describe, expect, it } from "vitest";

import { hasPayloadData } from "@/components/events/tabs/payload-tab";
import type { Event } from "@/lib/detection/types";

function makeEvent(overrides: Partial<Event> = {}): Event {
  return {
    __typename: "HttpThreat",
    time: "2026-04-22T10:00:00.000000000Z",
    sensor: "sensor-1",
    confidence: 0.8,
    category: null,
    level: "HIGH",
    triageScores: null,
    ...overrides,
  } as Event;
}

describe("hasPayloadData", () => {
  it("returns true for events carrying a non-empty body byte stream", () => {
    const event = makeEvent({ body: [0x48, 0x49] } as Partial<Event>);
    expect(hasPayloadData(event)).toBe(true);
  });

  it("returns false when the body byte stream is empty", () => {
    const event = makeEvent({ body: [] } as Partial<Event>);
    expect(hasPayloadData(event)).toBe(false);
  });

  it("returns false when the body field is absent", () => {
    const event = makeEvent();
    expect(hasPayloadData(event)).toBe(false);
  });

  it("returns false for event subtypes that do not expose body bytes", () => {
    const event = makeEvent({ __typename: "PortScan" });
    expect(hasPayloadData(event)).toBe(false);
  });
});
