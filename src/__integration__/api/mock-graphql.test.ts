import { readFileSync } from "node:fs";

import { Agent, fetch as undiciFetch } from "undici";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MOCK_REVIEW_GRAPHQL_URL } from "../setup";

const MOCK_URL = MOCK_REVIEW_GRAPHQL_URL;

interface GraphqlResult<T> {
  data?: T;
  errors?: { message: string }[];
}

let agent: Agent;

async function gql<T>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<GraphqlResult<T>> {
  const res = await undiciFetch(MOCK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
    dispatcher: agent,
  });
  return (await res.json()) as GraphqlResult<T>;
}

describe("mock REview GraphQL server (harness smoke)", () => {
  beforeAll(() => {
    const caPath = process.env.MTLS_CA_PATH;
    const certPath = process.env.MTLS_CERT_PATH;
    const keyPath = process.env.MTLS_KEY_PATH;
    if (!caPath || !certPath || !keyPath) {
      throw new Error(
        "Integration mock server requires MTLS_* env vars (set by global-setup).",
      );
    }
    agent = new Agent({
      connect: {
        ca: readFileSync(caPath, "utf8"),
        cert: readFileSync(certPath, "utf8"),
        key: readFileSync(keyPath, "utf8"),
      },
    });
  });

  afterAll(async () => {
    await agent.close();
  });

  it("responds to schema introspection", async () => {
    const result = await gql<{
      __schema: { queryType: { name: string } };
    }>("{ __schema { queryType { name } } }");
    expect(result.errors).toBeUndefined();
    expect(result.data?.__schema.queryType.name).toBe("Query");
  });

  it("returns canned eventList response from a fixture", async () => {
    const query = `
      query EventListSmoke($filter: EventListFilterInput!, $first: Int) {
        eventList(filter: $filter, first: $first) {
          pageInfo { hasNextPage hasPreviousPage }
          edges { cursor }
          totalCount
        }
      }
    `;
    const result = await gql<{
      eventList: {
        pageInfo: { hasNextPage: boolean; hasPreviousPage: boolean };
        edges: { cursor: string }[];
        totalCount: string;
      };
    }>(query, { filter: {}, first: 10 });

    expect(result.errors).toBeUndefined();
    expect(result.data?.eventList.totalCount).toBe("0");
    expect(result.data?.eventList.edges).toEqual([]);
    expect(result.data?.eventList.pageInfo.hasNextPage).toBe(false);
  });

  it("returns a 400 for queries that violate the schema", async () => {
    const res = await undiciFetch(MOCK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: "{ thisFieldDoesNotExist }",
      }),
      dispatcher: agent,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as GraphqlResult<unknown>;
    expect(body.errors?.length ?? 0).toBeGreaterThan(0);
  });

  it("registers and clears stubs via the admin endpoint", async () => {
    // The admin wire format no longer accepts inline fixture data — only
    // manifest-declared paths or `kind: "errors"`, so the pre-test preflight
    // covers every payload a running test can be served. Use an errors
    // stub here to prove the round-trip without depending on a particular
    // manifest fixture.
    const adminUrl = MOCK_URL.replace(/\/graphql$/, "/__admin/stubs");
    const scope = "integration-harness-admin-smoke";
    const register = await undiciFetch(adminUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        operation: "indicatorList",
        scope,
        response: {
          kind: "errors",
          errors: [{ message: "integration-stub-error" }],
        },
      }),
      dispatcher: agent,
    });
    expect(register.status).toBe(201);

    const result = await gql<{ indicatorList: { name: string }[] }>(
      "{ indicatorList { name } }",
    );
    expect(result.errors?.[0]?.message).toBe("integration-stub-error");

    const clear = await undiciFetch(
      `${adminUrl}?scope=${encodeURIComponent(scope)}`,
      { method: "DELETE", dispatcher: agent },
    );
    expect(clear.status).toBe(200);
  });

  it("rejects fixture paths not declared in manifest.json", async () => {
    const adminUrl = MOCK_URL.replace(/\/graphql$/, "/__admin/stubs");
    const res = await undiciFetch(adminUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        operation: "eventList",
        response: {
          kind: "fixture",
          fixture: "detection/eventList.does-not-exist.json",
        },
      }),
      dispatcher: agent,
    });
    expect(res.status).toBe(400);
  });
});
