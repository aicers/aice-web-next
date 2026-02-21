import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/mtls", () => ({
  signContextJwt: vi.fn().mockResolvedValue("mock-jwt-token"),
  getAgent: vi.fn().mockResolvedValue({ dispatcher: true }),
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
    vi.mocked(mtls.signContextJwt).mockClear();
    vi.mocked(mtls.getAgent).mockClear();
  });

  afterEach(() => {
    delete process.env.REVIEW_GRAPHQL_ENDPOINT;
  });

  it("attaches Authorization header with Bearer token", async () => {
    vi.mocked(mtls.signContextJwt).mockResolvedValue("test-token-123");

    await client.graphqlRequest("query { hello }", undefined, {
      role: "admin",
    });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [, init] = fetchSpy.mock.calls[0];
    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBe("Bearer test-token-123");
  });

  it("passes role and customerIds to signContextJwt", async () => {
    await client.graphqlRequest("query { hello }", undefined, {
      role: "viewer",
      customerIds: [1, 2],
    });

    expect(mtls.signContextJwt).toHaveBeenCalledWith("viewer", [1, 2]);
  });

  it("passes different role per request", async () => {
    await client.graphqlRequest("query { a }", undefined, { role: "admin" });
    await client.graphqlRequest("query { b }", undefined, { role: "viewer" });

    expect(mtls.signContextJwt).toHaveBeenCalledTimes(2);
    expect(mtls.signContextJwt).toHaveBeenNthCalledWith(1, "admin", undefined);
    expect(mtls.signContextJwt).toHaveBeenNthCalledWith(2, "viewer", undefined);
  });

  it("throws when REVIEW_GRAPHQL_ENDPOINT is missing", async () => {
    delete process.env.REVIEW_GRAPHQL_ENDPOINT;
    client.resetClient();

    await expect(
      client.graphqlRequest("query { hello }", undefined, { role: "admin" }),
    ).rejects.toThrow("Missing environment variable: REVIEW_GRAPHQL_ENDPOINT");
  });

  it("resetClient forces re-creation on next request", async () => {
    await client.graphqlRequest("query { a }", undefined, { role: "admin" });

    client.resetClient();
    process.env.REVIEW_GRAPHQL_ENDPOINT = "https://other.example.com/graphql";

    await client.graphqlRequest("query { b }", undefined, { role: "admin" });

    const [url1] = fetchSpy.mock.calls[0];
    const [url2] = fetchSpy.mock.calls[1];

    expect(url1.toString()).toContain("review.example.com");
    expect(url2.toString()).toContain("other.example.com");
  });
});
