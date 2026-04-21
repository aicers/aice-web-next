/**
 * Exercises the integration-tier `graphqlRequest` fixture layer from
 * `helpers/mock-graphql.ts`. Doubles as executable documentation for
 * feature issues — each scenario below mirrors the shape a feature's own
 * integration test will take:
 *
 *   1. Call `callGraphQL()` with a parsed `DocumentNode` to hit the mock
 *      server through the production `graphqlRequest` client (mTLS, JWT
 *      signing, the lot).
 *   2. Register a scenario-specific stub via `mockGraphqlSession()` in
 *      `beforeAll` and tear down with `session.clear()` in `afterAll`.
 *   3. Assert against the shared fixture JSON so the test stays locked
 *      to the canned payload the mock server is serving.
 */

import { parse } from "graphql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  callGraphQL,
  closeAdminAgent,
  loadFixtureJson,
  mockGraphqlSession,
} from "../helpers/mock-graphql";

const EVENT_LIST_QUERY = parse(`
  query EventListHelperSmoke($filter: EventListFilterInput!, $first: Int) {
    eventList(filter: $filter, first: $first) {
      pageInfo { hasNextPage hasPreviousPage }
      edges { cursor }
      totalCount
    }
  }
`);

interface EventListResponse {
  eventList: {
    pageInfo: { hasNextPage: boolean; hasPreviousPage: boolean };
    edges: { cursor: string }[];
    totalCount: string;
  };
}

interface EventListFixture {
  eventList: EventListResponse["eventList"];
}

describe("integration graphqlRequest helper", () => {
  afterAll(async () => {
    await closeAdminAgent();
  });

  it("calls graphqlRequest() against the manifest-preloaded eventList fixture", async () => {
    const fixture = loadFixtureJson(
      "detection/eventList.empty.json",
    ) as EventListFixture;

    const data = await callGraphQL<
      EventListResponse,
      { filter: Record<string, never>; first: number }
    >(EVENT_LIST_QUERY, { filter: {}, first: 10 });

    expect(data.eventList.totalCount).toBe(fixture.eventList.totalCount);
    expect(data.eventList.edges).toEqual(fixture.eventList.edges);
  });

  describe("with a session-scoped error stub", () => {
    const session = mockGraphqlSession();

    beforeAll(async () => {
      await session.registerStub({
        operation: "indicatorList",
        response: {
          kind: "errors",
          errors: [{ message: "graphql-helper-session-error" }],
        },
      });
    });

    afterAll(async () => {
      await session.clear();
    });

    it("surfaces session-scoped errors through graphqlRequest()", async () => {
      const document = parse("{ indicatorList { name } }");
      await expect(
        callGraphQL<{ indicatorList: { name: string }[] }>(document),
      ).rejects.toThrow(/graphql-helper-session-error/);
    });
  });
});
