/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetProbeAuthForTests,
  probeAuth,
  probeAuthOrRedirect,
} from "@/lib/auth/probe-auth";

const originalLocation = window.location;

beforeEach(() => {
  __resetProbeAuthForTests();
  vi.useFakeTimers();
  // Replace `window.location` so the redirect path is observable in
  // the assertions below without actually navigating.
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { assign: vi.fn() },
  });
});

afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: originalLocation,
  });
  vi.unstubAllGlobals();
});

describe("probeAuth", () => {
  it("returns 'ok' on a 200 response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
    );
    expect(await probeAuth()).toBe("ok");
  });

  it("returns 'unauthorized' on a 401 response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 401 })),
    );
    expect(await probeAuth()).toBe("unauthorized");
  });

  it("returns 'error' on a 5xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 503 })),
    );
    expect(await probeAuth()).toBe("error");
  });

  it("returns 'error' on a network failure (does not redirect)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("network failure")),
    );
    expect(await probeAuth()).toBe("error");
  });

  it("de-duplicates concurrent in-flight calls into one fetch", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const [a, b] = await Promise.all([probeAuth(), probeAuth()]);
    expect(a).toBe("ok");
    expect(b).toBe("ok");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("issues a fresh probe on each non-concurrent cache hit so a token_version bump after a successful probe is not masked", async () => {
    // Simulate: successful probe → admin bumps token_version → next
    // cache hit must catch the 401 instead of being suppressed by a
    // post-success debounce window. The in-flight de-dup only collapses
    // *concurrent* callers; serially-spaced calls each issue a fetch.
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }));
    vi.stubGlobal("fetch", fetchSpy);
    expect(await probeAuth()).toBe("ok");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // Advance time past what used to be a 5s debounce window — proves
    // the regression isn't just "wait longer than the old debounce".
    vi.advanceTimersByTime(50);
    expect(await probeAuth()).toBe("unauthorized");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe("probeAuthOrRedirect", () => {
  it("returns true and does NOT redirect when the probe is ok", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
    );
    const onUnauthorized = vi.fn();
    expect(await probeAuthOrRedirect(onUnauthorized)).toBe(true);
    expect(onUnauthorized).not.toHaveBeenCalled();
    expect(window.location.assign).not.toHaveBeenCalled();
  });

  it("returns false, fires onUnauthorized, and redirects on 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 401 })),
    );
    const onUnauthorized = vi.fn();
    expect(await probeAuthOrRedirect(onUnauthorized)).toBe(false);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(window.location.assign).toHaveBeenCalledWith(
      "/sign-in?reason=session-ended",
    );
  });

  it("returns true on transient error so the polling loop can retry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 503 })),
    );
    const onUnauthorized = vi.fn();
    expect(await probeAuthOrRedirect(onUnauthorized)).toBe(true);
    expect(onUnauthorized).not.toHaveBeenCalled();
    expect(window.location.assign).not.toHaveBeenCalled();
  });

  it("only redirects once even across multiple 401 callers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 401 })),
    );
    const a = vi.fn();
    const b = vi.fn();
    await Promise.all([probeAuthOrRedirect(a), probeAuthOrRedirect(b)]);
    expect(window.location.assign).toHaveBeenCalledTimes(1);
  });
});
