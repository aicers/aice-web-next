import { parse } from "graphql";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const Q_HELLO = parse("query { __typename }");
const Q_A = parse("query A { __typename }");
const Q_B = parse("query B { __typename }");
const Q_WITH_VAR = parse("query ($id: ID!) { __typename }");

const fetchSpy = vi.fn().mockImplementation(() =>
  Promise.resolve(
    new Response(JSON.stringify({ data: { hello: "world" } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  ),
);

vi.mock("@/lib/mtls", () => ({
  signContextJwt: vi.fn().mockResolvedValue("mock-jwt-token"),
  getAgent: vi.fn().mockResolvedValue({ mock: "dispatcher" }),
}));

vi.mock("undici", () => ({
  fetch: fetchSpy,
}));

describe("graphql client", () => {
  let client: typeof import("@/lib/graphql/client");
  let mtls: typeof import("@/lib/mtls");

  beforeEach(async () => {
    vi.resetModules();
    process.env.REVIEW_GRAPHQL_ENDPOINT = "https://review.example.com/graphql";

    client = await import("@/lib/graphql/client");
    mtls = await import("@/lib/mtls");

    fetchSpy.mockClear();
    vi.mocked(mtls.signContextJwt)
      .mockReset()
      .mockResolvedValue("mock-jwt-token");
    vi.mocked(mtls.getAgent)
      .mockReset()
      .mockResolvedValue({ mock: "dispatcher" } as never);
  });

  afterEach(() => {
    delete process.env.REVIEW_GRAPHQL_ENDPOINT;
  });

  // ── Authorization header ─────────────────────────────────────────

  describe("Authorization header", () => {
    it("attaches Bearer token from signContextJwt", async () => {
      vi.mocked(mtls.signContextJwt).mockResolvedValue("test-token-123");

      await client.graphqlRequest(Q_HELLO, undefined, {
        role: "admin",
      });

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [, init] = fetchSpy.mock.calls[0];
      const headers = new Headers(init.headers);
      expect(headers.get("Authorization")).toBe("Bearer test-token-123");
    });

    it("uses fresh JWT per request", async () => {
      vi.mocked(mtls.signContextJwt)
        .mockResolvedValueOnce("token-1")
        .mockResolvedValueOnce("token-2");

      await client.graphqlRequest(Q_A, undefined, { role: "admin" });
      await client.graphqlRequest(Q_B, undefined, { role: "admin" });

      const headers1 = new Headers(fetchSpy.mock.calls[0][1].headers);
      const headers2 = new Headers(fetchSpy.mock.calls[1][1].headers);
      expect(headers1.get("Authorization")).toBe("Bearer token-1");
      expect(headers2.get("Authorization")).toBe("Bearer token-2");
    });
  });

  // ── Context passing ──────────────────────────────────────────────

  describe("context passing", () => {
    it("passes role and customerIds to signContextJwt", async () => {
      await client.graphqlRequest(Q_HELLO, undefined, {
        role: "Security Administrator",
        customerIds: [42, 99],
      });

      expect(mtls.signContextJwt).toHaveBeenCalledWith(
        "Security Administrator",
        [42, 99],
      );
    });

    it("passes undefined customerIds when omitted", async () => {
      await client.graphqlRequest(Q_HELLO, undefined, {
        role: "System Administrator",
      });

      expect(mtls.signContextJwt).toHaveBeenCalledWith(
        "System Administrator",
        undefined,
      );
    });

    it("passes different context per request", async () => {
      await client.graphqlRequest(Q_A, undefined, {
        role: "System Administrator",
      });
      await client.graphqlRequest(Q_B, undefined, {
        role: "Security Administrator",
        customerIds: [1],
      });

      expect(mtls.signContextJwt).toHaveBeenCalledTimes(2);
      expect(mtls.signContextJwt).toHaveBeenNthCalledWith(
        1,
        "System Administrator",
        undefined,
      );
      expect(mtls.signContextJwt).toHaveBeenNthCalledWith(
        2,
        "Security Administrator",
        [1],
      );
    });
  });

  // ── Dispatcher injection ─────────────────────────────────────────

  describe("dispatcher injection", () => {
    it("injects mTLS dispatcher into fetch call", async () => {
      const mockAgent = { mock: "agent-dispatcher" };
      vi.mocked(mtls.getAgent).mockResolvedValue(mockAgent as never);

      await client.graphqlRequest(Q_HELLO, undefined, {
        role: "admin",
      });

      const [, init] = fetchSpy.mock.calls[0];
      expect(init.dispatcher).toBe(mockAgent);
    });

    it("calls getAgent on every request", async () => {
      await client.graphqlRequest(Q_A, undefined, { role: "admin" });
      await client.graphqlRequest(Q_B, undefined, { role: "admin" });

      expect(mtls.getAgent).toHaveBeenCalledTimes(2);
    });
  });

  // ── Variables forwarding ─────────────────────────────────────────

  describe("variables forwarding", () => {
    it("forwards variables in the request body", async () => {
      await client.graphqlRequest(Q_WITH_VAR, { id: "123" }, { role: "admin" });

      const [, init] = fetchSpy.mock.calls[0];
      const body = JSON.parse(init.body);
      expect(body.variables).toEqual({ id: "123" });
    });

    it("sends request body without variables when undefined", async () => {
      await client.graphqlRequest(Q_HELLO, undefined, {
        role: "admin",
      });

      const [, init] = fetchSpy.mock.calls[0];
      const body = JSON.parse(init.body);
      expect(body.query).toContain("__typename");
      expect(body.variables).toBeUndefined();
    });
  });

  // ── Endpoint configuration ───────────────────────────────────────

  describe("endpoint configuration", () => {
    it("sends request to REVIEW_GRAPHQL_ENDPOINT", async () => {
      await client.graphqlRequest(Q_HELLO, undefined, {
        role: "admin",
      });

      const [url] = fetchSpy.mock.calls[0];
      expect(url.toString()).toBe("https://review.example.com/graphql");
    });

    it("throws when REVIEW_GRAPHQL_ENDPOINT is missing", async () => {
      delete process.env.REVIEW_GRAPHQL_ENDPOINT;
      client.resetClient();

      await expect(
        client.graphqlRequest(Q_HELLO, undefined, { role: "admin" }),
      ).rejects.toThrow(
        "Missing environment variable: REVIEW_GRAPHQL_ENDPOINT",
      );
    });
  });

  // ── resetClient ──────────────────────────────────────────────────

  describe("resetClient", () => {
    it("forces client re-creation with new endpoint", async () => {
      await client.graphqlRequest(Q_A, undefined, { role: "admin" });

      client.resetClient();
      process.env.REVIEW_GRAPHQL_ENDPOINT = "https://other.example.com/graphql";

      await client.graphqlRequest(Q_B, undefined, { role: "admin" });

      const [url1] = fetchSpy.mock.calls[0];
      const [url2] = fetchSpy.mock.calls[1];
      expect(url1.toString()).toContain("review.example.com");
      expect(url2.toString()).toContain("other.example.com");
    });

    it("reuses client across requests without reset", async () => {
      await client.graphqlRequest(Q_A, undefined, { role: "admin" });
      await client.graphqlRequest(Q_B, undefined, { role: "admin" });

      // Both should go to the same endpoint
      const [url1] = fetchSpy.mock.calls[0];
      const [url2] = fetchSpy.mock.calls[1];
      expect(url1.toString()).toBe(url2.toString());
    });
  });

  // ── Error propagation ────────────────────────────────────────────

  describe("error propagation", () => {
    it("propagates signContextJwt errors", async () => {
      vi.mocked(mtls.signContextJwt).mockRejectedValue(
        new Error("Missing environment variable: MTLS_CERT_PATH"),
      );

      await expect(
        client.graphqlRequest(Q_HELLO, undefined, { role: "admin" }),
      ).rejects.toThrow("Missing environment variable: MTLS_CERT_PATH");
    });

    it("propagates getAgent errors", async () => {
      vi.mocked(mtls.getAgent).mockRejectedValue(
        new Error("Missing environment variable: MTLS_KEY_PATH"),
      );

      await expect(
        client.graphqlRequest(Q_HELLO, undefined, { role: "admin" }),
      ).rejects.toThrow("Missing environment variable: MTLS_KEY_PATH");
    });

    it("propagates fetch/network errors", async () => {
      fetchSpy.mockRejectedValueOnce(new TypeError("fetch failed"));

      await expect(
        client.graphqlRequest(Q_HELLO, undefined, { role: "admin" }),
      ).rejects.toThrow("fetch failed");
    });
  });

  // ── Raw-string guard ─────────────────────────────────────────────

  describe("raw-string guard", () => {
    it("rejects raw query strings smuggled past the type system", async () => {
      // Callers must pass a parsed DocumentNode (typically from a checked-in
      // .graphql file). Raw strings bypass the schema-validation test, so
      // graphqlRequest throws at runtime if one sneaks through via `as any`.
      const rawQuery = "query { hello }" as unknown as Parameters<
        typeof client.graphqlRequest
      >[0];

      await expect(
        client.graphqlRequest(rawQuery, undefined, { role: "admin" }),
      ).rejects.toThrow(/raw query strings are not allowed/);

      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  // ── AbortSignal forwarding ───────────────────────────────────────
  //
  // Long-running REview queries (CSV export pagination, future search-
  // language mode, large `eventList` pages) need to be cancellable
  // mid-flight so the user-initiated Cancel terminates the in-flight
  // page rather than waiting for it to complete. The signal threads
  // through `graphql-request` into the underlying fetch — and from
  // there into undici via the spread of `init` in the custom fetch.

  describe("abort signal forwarding", () => {
    it("forwards the supplied AbortSignal to the underlying fetch", async () => {
      const controller = new AbortController();

      await client.graphqlRequest(
        Q_HELLO,
        undefined,
        { role: "admin" },
        controller.signal,
      );

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [, init] = fetchSpy.mock.calls[0];
      expect(init.signal).toBe(controller.signal);
    });

    it("rejects promptly when the signal aborts before a slow response", async () => {
      // Mimic a slow REview response: the fetch resolves only when the
      // signal aborts. graphql-request should reject the request with
      // an AbortError as soon as the signal fires, instead of waiting
      // for the fake server to finish.
      fetchSpy.mockImplementationOnce((_input, init) => {
        return new Promise((resolve, reject) => {
          const signal = (init as { signal?: AbortSignal } | undefined)?.signal;
          if (!signal) {
            // Without forwarding, the request would just hang.
            return;
          }
          if (signal.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
          }
          signal.addEventListener(
            "abort",
            () => {
              reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
          );
          // Never resolve on its own — the test relies on the abort
          // path firing the reject.
          void resolve;
        });
      });

      const controller = new AbortController();
      const requestPromise = client.graphqlRequest(
        Q_HELLO,
        undefined,
        { role: "admin" },
        controller.signal,
      );

      // Schedule the abort on a microtask so the request is in-flight
      // when the signal fires.
      queueMicrotask(() => controller.abort());

      await expect(requestPromise).rejects.toThrow(/abort/i);
    });

    it("omits signal from the fetch init when the caller did not supply one", async () => {
      await client.graphqlRequest(Q_HELLO, undefined, { role: "admin" });

      const [, init] = fetchSpy.mock.calls[0];
      // graphql-request must not synthesize a signal of its own when
      // none was passed, so other server actions retain their existing
      // (uncancellable) semantics.
      expect(init.signal).toBeUndefined();
    });
  });
});
