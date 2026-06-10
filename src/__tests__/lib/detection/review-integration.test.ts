/**
 * End-to-end wiring test for the Detection ↔ REview path.
 *
 * The test drives the real `searchEvents` server action through the
 * real `graphqlRequest` helper and only mocks out:
 *
 *   - `@/lib/mtls` (avoids real certificate I/O)
 *   - `undici.fetch`  (avoids a real network hop)
 *   - `@/lib/auth/permissions` and `@/lib/auth/customer-scope`
 *     (avoids real DB access while letting the authorization branch
 *      still run)
 *
 * It asserts that a minimal `start`/`end` filter:
 *   1. produces a POSTed GraphQL request against REview,
 *   2. passes the caller's filter through unchanged — customer
 *      scope is NOT injected into `filter.customers`; it travels
 *      on the Context JWT (see `signContextJwt` mock below),
 *   3. carries the Context JWT in the Authorization header,
 *   4. returns the server's payload unchanged (non-error), including
 *      `totalCount` as a string to preserve 64-bit precision.
 *
 * The response fixture is validated against `schemas/review.graphql`
 * so a schema-pin bump cannot silently invalidate the test.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  buildSchema,
  execute as gqlExecute,
  parse as gqlParse,
  validate as gqlValidate,
} from "graphql";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthSession } from "@/lib/auth/jwt";

const fetchSpy = vi.fn();

const signContextJwtSpy = vi.fn().mockResolvedValue("mock-jwt-token");

vi.mock("@/lib/mtls", () => ({
  signContextJwt: signContextJwtSpy,
  getAgent: vi.fn().mockResolvedValue({ mock: "dispatcher" }),
  createMtlsRequestAuth: vi
    .fn()
    .mockImplementation(async (role: string, customerIds?: number[]) => ({
      agent: { mock: "dispatcher" },
      token: await signContextJwtSpy(role, customerIds),
      release: () => {},
    })),
}));

vi.mock("undici", () => ({ fetch: fetchSpy }));

const mockHasPermission = vi.hoisted(() => vi.fn());
const mockResolveEffectiveCustomerIds = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/permissions", () => ({
  hasPermission: mockHasPermission,
}));
vi.mock("@/lib/auth/customer-scope", () => ({
  resolveEffectiveCustomerIds: mockResolveEffectiveCustomerIds,
}));

const SCHEMA_PATH = path.resolve(
  __dirname,
  "../../../../schemas/review.graphql",
);

function makeSession(roles: string[]): AuthSession {
  return {
    accountId: "account-1",
    sessionId: "session-1",
    roles,
    tokenVersion: 1,
    mustChangePassword: false,
    mustEnrollMfa: false,
    iat: 0,
    exp: 0,
    sessionIp: "127.0.0.1",
    sessionUserAgent: "test",
    sessionBrowserFingerprint: "test",
    needsReauth: false,
    sessionCreatedAt: new Date(0),
    sessionLastActiveAt: new Date(0),
  } as AuthSession;
}

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// Fixture shaped like an `EventConnection` from REview's schema.
// `totalCount` is a `StringNumber` — a string that must flow through
// untouched to preserve 64-bit precision.
const EVENT_LIST_FIXTURE_DATA = {
  eventList: {
    pageInfo: {
      hasPreviousPage: false,
      hasNextPage: false,
      startCursor: null,
      endCursor: null,
    },
    edges: [] as Array<{ cursor: string; node: unknown }>,
    nodes: [] as unknown[],
    totalCount: "18446744073709551615",
  },
};

// Probe mirrors the response-shape subset the fixture covers. Used in
// two places: as a sanity check that the query still validates against
// the pinned schema, and executed against the fixture so the fixture
// is coerced through the real schema types.
const EVENT_LIST_PROBE = `
  query Probe($filter: EventListFilterInput!) {
    eventList(filter: $filter, first: 1) {
      pageInfo {
        hasPreviousPage
        hasNextPage
        startCursor
        endCursor
      }
      edges { cursor }
      nodes { __typename time sensor confidence level }
      totalCount
    }
  }
`;

describe("detection ↔ REview wiring (network mocked)", () => {
  beforeEach(async () => {
    vi.resetModules();
    fetchSpy.mockReset();
    signContextJwtSpy.mockClear();
    signContextJwtSpy.mockResolvedValue("mock-jwt-token");
    mockHasPermission.mockReset();
    mockResolveEffectiveCustomerIds.mockReset();
    process.env.REVIEW_GRAPHQL_ENDPOINT = "https://review.example.com/graphql";
  });

  afterEach(() => {
    delete process.env.REVIEW_GRAPHQL_ENDPOINT;
  });

  it("dispatches a minimal start/end filter and carries scope on the JWT, not the filter", async () => {
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([42, 99]);

    fetchSpy.mockResolvedValue(okJson({ data: EVENT_LIST_FIXTURE_DATA }));

    const { searchEvents } = await import("@/lib/detection");
    const result = await searchEvents(
      makeSession(["Security Monitor"]),
      {
        mode: "structured",
        input: {
          start: "2026-04-01T00:00:00Z",
          end: "2026-04-02T00:00:00Z",
        },
      },
      { first: 25 },
    );

    // HTTP dispatch happened exactly once.
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url.toString()).toBe("https://review.example.com/graphql");

    // Context JWT is attached to the request headers and was signed
    // with the caller's resolved customer scope — this is where
    // authorization/scoping lives, not in `filter.customers`.
    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBe("Bearer mock-jwt-token");
    expect(signContextJwtSpy).toHaveBeenCalledWith(
      "Security Monitor",
      [42, 99],
    );

    // Body carries the caller's filter *as-is* and the expected
    // operation. Crucially, the BFF did not inject customers.
    const body = JSON.parse(init.body);
    expect(body.query).toContain("query EventList");
    expect(body.variables.filter).toEqual({
      start: "2026-04-01T00:00:00Z",
      end: "2026-04-02T00:00:00Z",
    });
    expect(body.variables.filter.customers).toBeUndefined();
    expect(body.variables.first).toBe(25);

    // Non-error response flows back end-to-end, with totalCount as a
    // string (never cast to `number`).
    expect(result.totalCount).toBe("18446744073709551615");
    expect(typeof result.totalCount).toBe("string");
  });

  it("dispatches listSensors() through the Context JWT and projects { customerId, nodeId, hostFqdn } into { id, name, customerId }", async () => {
    // Phase Detection-24 wiring: drive the real `listSensors` server
    // action through the real `graphqlRequest` helper. Verifies:
    //   1. A POST happens against REview with the SensorList operation.
    //   2. No explicit `customerIds` argument on the query — scope
    //      travels on the Context JWT (`signContextJwt(role, customerIds)`).
    //   3. The wire payload `customerSensorList.nodes[]` (SDL fields
    //      `customerId: Int!`, `nodeId: ID!`, `hostFqdn: String!`) is
    //      projected into the consumer-facing
    //      `{ id, name, customerId: number }` shape.
    //   4. SystemAdministrator callers ship `customer_ids = undefined`
    //      on the JWT (review's "all customers" wire semantics) — same
    //      contract as the event-list path.
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([42, 99]);

    fetchSpy.mockResolvedValue(
      okJson({
        data: {
          customerSensorList: {
            nodes: [
              {
                customerId: 42,
                nodeId: "1",
                hostFqdn: "sensor-a.example.com",
              },
              {
                customerId: 99,
                nodeId: "2",
                hostFqdn: "sensor-b.example.com",
              },
            ],
          },
        },
      }),
    );

    const { listSensors } = await import("@/lib/detection");
    const result = await listSensors(makeSession(["Security Monitor"]));

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [, init] = fetchSpy.mock.calls[0];
    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBe("Bearer mock-jwt-token");
    expect(signContextJwtSpy).toHaveBeenCalledWith(
      "Security Monitor",
      [42, 99],
    );

    const body = JSON.parse(init.body);
    expect(body.query).toContain("query SensorList");
    expect(body.query).toContain("customerSensorList");
    // No `customerIds` argument shipped to the query — the JWT carries
    // the scope. The query is parameter-less; review applies the JWT
    // claims to scope.
    expect(body.query).not.toContain("$customerIds");
    expect(body.query).not.toContain("customerIds:");

    expect(result).toEqual({
      endpointAvailable: true,
      sensors: [
        { id: "1", name: "sensor-a.example.com", customerId: 42 },
        { id: "2", name: "sensor-b.example.com", customerId: 99 },
      ],
    });
    // `customerId` is numeric (post-migration), matching SDL `Int!`.
    if (result.endpointAvailable) {
      for (const s of result.sensors) {
        expect(typeof s.customerId).toBe("number");
      }
    }
  });

  it("listSensors() for SystemAdministrator ships customer_ids = undefined on the JWT", async () => {
    // Symmetric to the event-list path's JWT claim contract: SysAdmin
    // omits `customer_ids` from the JWT so review's "all customers"
    // semantics apply. A fresh install with no `customers` rows still
    // reaches the endpoint.
    mockHasPermission.mockResolvedValue(true);
    mockResolveEffectiveCustomerIds.mockResolvedValue([]);

    fetchSpy.mockResolvedValue(
      okJson({ data: { customerSensorList: { nodes: [] } } }),
    );

    const { listSensors } = await import("@/lib/detection");
    await listSensors(makeSession(["System Administrator"]));

    expect(signContextJwtSpy).toHaveBeenCalledWith(
      "System Administrator",
      undefined,
    );
  });

  it("fixture validates against schemas/review.graphql", async () => {
    // Two-stage regression guard against silent drift:
    //
    //   1. The probe query must still validate against the pinned
    //      schema — catches renamed/removed fields on the query side.
    //   2. The fixture must survive `execute()` against that schema
    //      with its shape preserved — catches fixture-side drift (a
    //      field rename, a changed scalar, a now-non-null field the
    //      fixture still sets to `null`, etc.). The default field
    //      resolver walks property names on the root value, so
    //      GraphQL type coercion is what does the real checking.
    const schema = buildSchema(readFileSync(SCHEMA_PATH, "utf8"));
    const probe = gqlParse(EVENT_LIST_PROBE);

    const validationErrors = gqlValidate(schema, probe);
    expect(validationErrors).toEqual([]);

    const executed = await gqlExecute({
      schema,
      document: probe,
      rootValue: EVENT_LIST_FIXTURE_DATA,
      variableValues: {
        filter: {
          start: "2026-04-01T00:00:00Z",
          end: "2026-04-02T00:00:00Z",
        },
      },
    });
    expect(executed.errors).toBeUndefined();
    expect(executed.data).toEqual(EVENT_LIST_FIXTURE_DATA);

    // Sanity check that execute() actually catches shape drift — set
    // the required `hasPreviousPage` to `null` and confirm the
    // pipeline reports a non-null violation. Keeps the positive
    // assertion above from silently degrading into a no-op if
    // graphql-js ever relaxes coercion.
    const broken = {
      eventList: {
        ...EVENT_LIST_FIXTURE_DATA.eventList,
        pageInfo: {
          ...EVENT_LIST_FIXTURE_DATA.eventList.pageInfo,
          hasPreviousPage: null as unknown as boolean,
        },
      },
    };
    const brokenResult = await gqlExecute({
      schema,
      document: probe,
      rootValue: broken,
      variableValues: {
        filter: {
          start: "2026-04-01T00:00:00Z",
          end: "2026-04-02T00:00:00Z",
        },
      },
    });
    expect(brokenResult.errors).toBeDefined();
    expect(brokenResult.errors?.[0].message).toMatch(/hasPreviousPage/);
  });
});
