import { describe, expect, it } from "vitest";

import {
  decodeEventLocator,
  type EventLocator,
  encodeEventLocator,
} from "@/lib/events/event-locator";

const SAMPLE: EventLocator = {
  id: "evt-AAAA-BBBB-CCCC",
};

describe("event-locator", () => {
  it("round-trips an id-only payload", () => {
    const token = encodeEventLocator({ id: SAMPLE.id });
    expect(token).not.toBeNull();
    if (!token) throw new Error("encoder returned null");
    const decoded = decodeEventLocator(token);
    expect(decoded).toEqual(SAMPLE);
  });

  it("returns null when id is empty", () => {
    expect(encodeEventLocator({ id: "" })).toBeNull();
  });

  it("returns null for malformed tokens", () => {
    expect(decodeEventLocator("")).toBeNull();
    expect(decodeEventLocator("not-valid-base64!!")).toBeNull();
    expect(
      decodeEventLocator(Buffer.from('"string"').toString("base64url")),
    ).toBeNull();
  });

  it("returns null when the decoded payload has no id field", () => {
    const token = Buffer.from(JSON.stringify({})).toString("base64url");
    expect(decodeEventLocator(token)).toBeNull();
  });

  it("returns null when the decoded id has the wrong type", () => {
    const token = Buffer.from(JSON.stringify({ id: 42 })).toString("base64url");
    expect(decodeEventLocator(token)).toBeNull();
  });

  it("returns null when the decoded id is empty", () => {
    const token = Buffer.from(JSON.stringify({ id: "" })).toString("base64url");
    expect(decodeEventLocator(token)).toBeNull();
  });

  it("returns null when the decoded id is too long", () => {
    const longId = "x".repeat(2048);
    const token = Buffer.from(JSON.stringify({ id: longId })).toString(
      "base64url",
    );
    expect(decodeEventLocator(token)).toBeNull();
  });

  it("ignores extra payload fields and decodes id only", () => {
    const token = Buffer.from(
      JSON.stringify({ id: SAMPLE.id, extra: "ignored", n: 7 }),
    ).toString("base64url");
    expect(decodeEventLocator(token)).toEqual({ id: SAMPLE.id });
  });

  it("produces URL-safe base64 (no +, /, =)", () => {
    const token = encodeEventLocator({ id: SAMPLE.id });
    expect(token).not.toBeNull();
    if (!token) throw new Error("encoder returned null");
    expect(token).not.toMatch(/[+/=]/);
  });
});
