import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mutatingFetch, readCsrfToken } from "@/lib/csrf-client";

describe("readCsrfToken", () => {
  let fakeCookie = "";
  beforeEach(() => {
    fakeCookie = "";
    vi.stubGlobal("document", {
      get cookie() {
        return fakeCookie;
      },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns null when no CSRF cookie exists", () => {
    expect(readCsrfToken()).toBeNull();
  });

  it("returns null when only unrelated cookies exist", () => {
    fakeCookie = "token_exp=12345; other=value";
    expect(readCsrfToken()).toBeNull();
  });

  it("reads csrf cookie (development)", () => {
    fakeCookie = "csrf=dev-token-123";
    expect(readCsrfToken()).toBe("dev-token-123");
  });

  it("reads __Host-csrf cookie (production)", () => {
    fakeCookie = "__Host-csrf=prod-token-456";
    expect(readCsrfToken()).toBe("prod-token-456");
  });

  it("prefers __Host-csrf over csrf when both present", () => {
    fakeCookie = "__Host-csrf=prod; csrf=dev";
    expect(readCsrfToken()).toBe("prod");
  });

  it("reads csrf from among multiple cookies", () => {
    fakeCookie = "token_exp=999; csrf=my-token; other=abc";
    expect(readCsrfToken()).toBe("my-token");
  });
});

describe("mutatingFetch", () => {
  let fakeCookie = "";
  beforeEach(() => {
    fakeCookie = "";
    vi.stubGlobal("document", {
      get cookie() {
        return fakeCookie;
      },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("attaches the x-csrf-token header from the cookie", async () => {
    fakeCookie = "csrf=tok-xyz";
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await mutatingFetch("/api/foo", {
      method: "POST",
      body: JSON.stringify({ a: 1 }),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get("x-csrf-token")).toBe("tok-xyz");
    expect(init.method).toBe("POST");
  });

  it("forwards caller-supplied headers alongside the csrf header", async () => {
    fakeCookie = "csrf=tok-xyz";
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await mutatingFetch("/api/foo", {
      method: "POST",
      headers: { "content-type": "application/json" },
    });

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get("x-csrf-token")).toBe("tok-xyz");
    expect(headers.get("content-type")).toBe("application/json");
  });

  it("omits the csrf header when no cookie is present", async () => {
    fakeCookie = "";
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await mutatingFetch("/api/foo", { method: "POST" });

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.has("x-csrf-token")).toBe(false);
  });
});
