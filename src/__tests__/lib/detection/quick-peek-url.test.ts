import { describe, expect, it } from "vitest";

import {
  applyQuickPeekToken,
  QUICK_PEEK_EVENT_PARAM,
  readQuickPeekToken,
} from "@/lib/detection/quick-peek-url";
import { encodeEventLocator } from "@/lib/events/event-locator";

const sampleEvent = {
  id: "evt-AAAA-BBBB-CCCC",
};

describe("readQuickPeekToken", () => {
  it("returns null when the event param is missing", () => {
    const params = new URLSearchParams("source=10.0.0.5");
    expect(readQuickPeekToken(params)).toBeNull();
  });

  it("returns null for an invalid / tampered token", () => {
    const params = new URLSearchParams("event=not-a-valid-token");
    expect(readQuickPeekToken(params)).toBeNull();
  });

  it("decodes a valid token and returns the locator alongside the raw token", () => {
    const token = encodeEventLocator(sampleEvent);
    expect(token).not.toBeNull();
    const params = new URLSearchParams();
    params.set(QUICK_PEEK_EVENT_PARAM, token as string);
    const result = readQuickPeekToken(params);
    expect(result).not.toBeNull();
    expect(result?.token).toBe(token);
    expect(result?.locator.id).toBe(sampleEvent.id);
  });
});

describe("applyQuickPeekToken", () => {
  it("adds the event param to an empty search string", () => {
    const next = applyQuickPeekToken("", "abc123");
    expect(next).toBe("?event=abc123");
  });

  it("preserves existing params while setting the event token", () => {
    const next = applyQuickPeekToken("?source=10.0.0.5&window=1d", "abc123");
    expect(new URLSearchParams(next).get("source")).toBe("10.0.0.5");
    expect(new URLSearchParams(next).get("window")).toBe("1d");
    expect(new URLSearchParams(next).get("event")).toBe("abc123");
  });

  it("removes the event param when the token is null", () => {
    const next = applyQuickPeekToken(
      "?source=10.0.0.5&event=abc123&window=1d",
      null,
    );
    expect(new URLSearchParams(next).get("event")).toBeNull();
    // Other params are preserved.
    expect(new URLSearchParams(next).get("source")).toBe("10.0.0.5");
    expect(new URLSearchParams(next).get("window")).toBe("1d");
  });

  it("returns an empty string when removing the only param", () => {
    const next = applyQuickPeekToken("?event=abc123", null);
    expect(next).toBe("");
  });
});
