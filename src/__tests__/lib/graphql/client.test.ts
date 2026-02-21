import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/mtls", () => ({
  signContextJwt: vi.fn().mockResolvedValue("mock-jwt-token"),
  getAgent: vi.fn().mockResolvedValue({ mock: "dispatcher" }),
}));

const fetchSpy = vi.fn().mockImplementation(() =>
  Promise.resolve(
    new Response(JSON.stringify({ data: { hello: "world" } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  ),
);
vi.stubGlobal("fetch", fetchSpy);

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

      await client.graphqlRequest("query { hello }", undefined, {
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

      await client.graphqlRequest("query { a }", undefined, { role: "admin" });
      await client.graphqlRequest("query { b }", undefined, { role: "admin" });

      const headers1 = new Headers(fetchSpy.mock.calls[0][1].headers);
      const headers2 = new Headers(fetchSpy.mock.calls[1][1].headers);
      expect(headers1.get("Authorization")).toBe("Bearer token-1");
      expect(headers2.get("Authorization")).toBe("Bearer token-2");
    });
  });

  // ── Context passing ──────────────────────────────────────────────

  describe("context passing", () => {
    it("passes role and customerIds to signContextJwt", async () => {
      await client.graphqlRequest("query { hello }", undefined, {
        role: "Security Administrator",
        customerIds: [42, 99],
      });

      expect(mtls.signContextJwt).toHaveBeenCalledWith(
        "Security Administrator",
        [42, 99],
      );
    });

    it("passes undefined customerIds when omitted", async () => {
      await client.graphqlRequest("query { hello }", undefined, {
        role: "System Administrator",
      });

      expect(mtls.signContextJwt).toHaveBeenCalledWith(
        "System Administrator",
        undefined,
      );
    });

    it("passes different context per request", async () => {
      await client.graphqlRequest("query { a }", undefined, {
        role: "System Administrator",
      });
      await client.graphqlRequest("query { b }", undefined, {
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

      await client.graphqlRequest("query { hello }", undefined, {
        role: "admin",
      });

      const [, init] = fetchSpy.mock.calls[0];
      expect(init.dispatcher).toBe(mockAgent);
    });

    it("calls getAgent on every request", async () => {
      await client.graphqlRequest("query { a }", undefined, { role: "admin" });
      await client.graphqlRequest("query { b }", undefined, { role: "admin" });

      expect(mtls.getAgent).toHaveBeenCalledTimes(2);
    });
  });

  // ── Variables forwarding ─────────────────────────────────────────

  describe("variables forwarding", () => {
    it("forwards variables in the request body", async () => {
      await client.graphqlRequest(
        "query ($id: ID!) { node(id: $id) { id } }",
        { id: "123" },
        { role: "admin" },
      );

      const [, init] = fetchSpy.mock.calls[0];
      const body = JSON.parse(init.body);
      expect(body.variables).toEqual({ id: "123" });
    });

    it("sends request body without variables when undefined", async () => {
      await client.graphqlRequest("query { hello }", undefined, {
        role: "admin",
      });

      const [, init] = fetchSpy.mock.calls[0];
      const body = JSON.parse(init.body);
      expect(body.query).toContain("hello");
    });
  });

  // ── Endpoint configuration ───────────────────────────────────────

  describe("endpoint configuration", () => {
    it("sends request to REVIEW_GRAPHQL_ENDPOINT", async () => {
      await client.graphqlRequest("query { hello }", undefined, {
        role: "admin",
      });

      const [url] = fetchSpy.mock.calls[0];
      expect(url.toString()).toBe("https://review.example.com/graphql");
    });

    it("throws when REVIEW_GRAPHQL_ENDPOINT is missing", async () => {
      delete process.env.REVIEW_GRAPHQL_ENDPOINT;
      client.resetClient();

      await expect(
        client.graphqlRequest("query { hello }", undefined, { role: "admin" }),
      ).rejects.toThrow(
        "Missing environment variable: REVIEW_GRAPHQL_ENDPOINT",
      );
    });
  });

  // ── resetClient ──────────────────────────────────────────────────

  describe("resetClient", () => {
    it("forces client re-creation with new endpoint", async () => {
      await client.graphqlRequest("query { a }", undefined, { role: "admin" });

      client.resetClient();
      process.env.REVIEW_GRAPHQL_ENDPOINT = "https://other.example.com/graphql";

      await client.graphqlRequest("query { b }", undefined, { role: "admin" });

      const [url1] = fetchSpy.mock.calls[0];
      const [url2] = fetchSpy.mock.calls[1];
      expect(url1.toString()).toContain("review.example.com");
      expect(url2.toString()).toContain("other.example.com");
    });

    it("reuses client across requests without reset", async () => {
      await client.graphqlRequest("query { a }", undefined, { role: "admin" });
      await client.graphqlRequest("query { b }", undefined, { role: "admin" });

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
        client.graphqlRequest("query { hello }", undefined, { role: "admin" }),
      ).rejects.toThrow("Missing environment variable: MTLS_CERT_PATH");
    });

    it("propagates getAgent errors", async () => {
      vi.mocked(mtls.getAgent).mockRejectedValue(
        new Error("Missing environment variable: MTLS_KEY_PATH"),
      );

      await expect(
        client.graphqlRequest("query { hello }", undefined, { role: "admin" }),
      ).rejects.toThrow("Missing environment variable: MTLS_KEY_PATH");
    });

    it("propagates fetch/network errors", async () => {
      fetchSpy.mockRejectedValueOnce(new TypeError("fetch failed"));

      await expect(
        client.graphqlRequest("query { hello }", undefined, { role: "admin" }),
      ).rejects.toThrow("fetch failed");
    });
  });
});
