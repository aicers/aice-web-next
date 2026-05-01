import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Agent, fetch as undiciFetch } from "undici";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type RunningMockServer,
  StubRegistry,
  startMockServer,
} from "@/test-harness/mock-server";
import { ensureTestCerts } from "@/test-harness/test-certs";

interface GraphqlResult<T> {
  data?: T;
  errors?: { message: string }[];
}

async function gql<T>(
  url: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<GraphqlResult<T>> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  return (await res.json()) as GraphqlResult<T>;
}

describe("StubRegistry.resolve specificity", () => {
  it("prefers a specific matcher over a catch-all regardless of registration order", () => {
    // A later-registered catch-all must not shadow an earlier specific
    // matcher. `preloadManifestStubs()` can produce exactly that ordering
    // when a manifest lists `{ first: 10 }` first and then a no-variables
    // entry second — the catch-all would win every request under naive
    // last-registered-wins resolution and silently route narrow traffic to
    // the wrong fixture.
    const registry = new StubRegistry();
    registry.register(
      { operation: "eventList", matchVariables: { first: 10 } },
      { kind: "errors", errors: [{ message: "narrow" }] },
    );
    registry.register(
      { operation: "eventList" },
      { kind: "errors", errors: [{ message: "catchall" }] },
    );

    const narrow = registry.resolve("eventList", { first: 10 });
    expect(narrow).toEqual({
      kind: "errors",
      errors: [{ message: "narrow" }],
    });

    const fallback = registry.resolve("eventList", { first: 99 });
    expect(fallback).toEqual({
      kind: "errors",
      errors: [{ message: "catchall" }],
    });
  });

  it("falls back to a catch-all when no specific matcher matches", () => {
    const registry = new StubRegistry();
    registry.register(
      { operation: "eventList" },
      { kind: "errors", errors: [{ message: "catchall" }] },
    );
    registry.register(
      { operation: "eventList", matchVariables: { first: 10 } },
      { kind: "errors", errors: [{ message: "narrow" }] },
    );

    const narrow = registry.resolve("eventList", { first: 10 });
    expect(narrow).toEqual({
      kind: "errors",
      errors: [{ message: "narrow" }],
    });

    const miss = registry.resolve("eventList", { first: 50 });
    expect(miss).toEqual({
      kind: "errors",
      errors: [{ message: "catchall" }],
    });
  });

  it("normalizes an empty matchVariables object to a catch-all", () => {
    // `matchVariables: {}` is a zero-key specific matcher under subset
    // semantics — satisfied by every request — so under specificity-first
    // it would still fall below any non-empty specific matcher, but the
    // normalizer routes it to the catch-all tier anyway so the admin wire
    // format and the manifest preload agree on what `{}` means.
    const registry = new StubRegistry();
    registry.register(
      { operation: "eventList", matchVariables: { first: 10 } },
      { kind: "errors", errors: [{ message: "narrow-wins" }] },
    );
    registry.register(
      { operation: "eventList", matchVariables: {} },
      { kind: "errors", errors: [{ message: "catch-all" }] },
    );

    expect(registry.resolve("eventList", { first: 10 })).toEqual({
      kind: "errors",
      errors: [{ message: "narrow-wins" }],
    });
    expect(registry.resolve("eventList", { first: 99 })).toEqual({
      kind: "errors",
      errors: [{ message: "catch-all" }],
    });
  });

  it("matches object-shaped variables regardless of key order", () => {
    // Round 13: the preflight canonicalizes nested objects with sorted keys,
    // so `{ filter: { a: 1, b: 2 } }` and `{ filter: { b: 2, a: 1 } }` hash
    // to the same matcher. The runtime matcher must agree — otherwise a
    // request built with a different property-construction order than the
    // fixture's `variables` would miss a logically-identical stub. This
    // matters for REview's object-shaped `$filter` variable.
    const registry = new StubRegistry();
    registry.register(
      {
        operation: "eventList",
        matchVariables: { filter: { a: 1, b: 2 } },
      },
      { kind: "errors", errors: [{ message: "filter-match" }] },
    );
    expect(registry.resolve("eventList", { filter: { b: 2, a: 1 } })).toEqual({
      kind: "errors",
      errors: [{ message: "filter-match" }],
    });
    // Deeply nested permutation also resolves.
    registry.register(
      {
        operation: "eventList",
        matchVariables: {
          filter: { outer: { inner: { x: 1, y: 2 } } },
        },
      },
      { kind: "errors", errors: [{ message: "deep-filter-match" }] },
    );
    expect(
      registry.resolve("eventList", {
        filter: { outer: { inner: { y: 2, x: 1 } } },
      }),
    ).toEqual({
      kind: "errors",
      errors: [{ message: "deep-filter-match" }],
    });
    // A real value disagreement on a shared key still misses.
    expect(
      registry.resolve("eventList", { filter: { a: 1, b: 3 } }),
    ).toBeNull();
  });

  it("prefers the more-constrained specific matcher regardless of registration order", () => {
    // The reviewer's Round 12 concern: under last-registered-wins, a later
    // broad matcher like `{ first: 10 }` would shadow an earlier narrower
    // `{ filter: {}, first: 10 }` for any request that matches both. The
    // resolver now ranks by `matchVariables` key count, so the 2-key
    // matcher wins over the 1-key one whichever order they were registered.
    const registry = new StubRegistry();
    registry.register(
      { operation: "eventList", matchVariables: { filter: {}, first: 10 } },
      { kind: "errors", errors: [{ message: "narrow-two-keys" }] },
    );
    registry.register(
      { operation: "eventList", matchVariables: { first: 10 } },
      { kind: "errors", errors: [{ message: "broad-one-key" }] },
    );
    expect(registry.resolve("eventList", { filter: {}, first: 10 })).toEqual({
      kind: "errors",
      errors: [{ message: "narrow-two-keys" }],
    });

    // Swapping the registration order must not change the outcome.
    const reversed = new StubRegistry();
    reversed.register(
      { operation: "eventList", matchVariables: { first: 10 } },
      { kind: "errors", errors: [{ message: "broad-one-key" }] },
    );
    reversed.register(
      { operation: "eventList", matchVariables: { filter: {}, first: 10 } },
      { kind: "errors", errors: [{ message: "narrow-two-keys" }] },
    );
    expect(reversed.resolve("eventList", { filter: {}, first: 10 })).toEqual({
      kind: "errors",
      errors: [{ message: "narrow-two-keys" }],
    });

    // A request that only matches the broad matcher still falls through
    // to it, because the narrower matcher's extra key (`filter`) is
    // absent — so the broad matcher is the only specific match.
    expect(registry.resolve("eventList", { first: 10 })).toEqual({
      kind: "errors",
      errors: [{ message: "broad-one-key" }],
    });
  });
});

describe("mock GraphQL server (unit)", () => {
  let server: RunningMockServer;

  beforeAll(async () => {
    server = await startMockServer({ port: 0 });
  });

  afterAll(async () => {
    await server.close();
  });

  it("responds to introspection", async () => {
    const result = await gql<{
      __schema: { queryType: { name: string } };
    }>(server.url, "{ __schema { queryType { name } } }");
    expect(result.errors).toBeUndefined();
    expect(result.data?.__schema.queryType.name).toBe("Query");
  });

  it("serves the manifest-loaded eventList fixture for matching variables", async () => {
    // The manifest entry declares `variables: { filter: {}, first: 10 }`,
    // and preloading uses those as the runtime stub matcher — so the
    // request must send the same shape to hit the stub.
    const result = await gql<{ eventList: { totalCount: string } }>(
      server.url,
      `query Q($filter: EventListFilterInput!, $first: Int) {
         eventList(filter: $filter, first: $first) { totalCount edges { cursor } }
       }`,
      { filter: {}, first: 10 },
    );
    expect(result.errors).toBeUndefined();
    expect(result.data?.eventList.totalCount).toBe("0");
  });

  it("manifest-preloaded stubs do not match other variable shapes", async () => {
    // Sending a different variables shape must miss the manifest stub.
    // Otherwise two manifest entries that share an operation would step
    // on each other (the previous behaviour, before variable-keyed
    // preloading).
    const result = await gql<{ eventList: { totalCount: string } }>(
      server.url,
      `query Q($filter: EventListFilterInput!, $first: Int) {
         eventList(filter: $filter, first: $first) { totalCount }
       }`,
      { filter: { kinds: ["dnsCovertChannel"] }, first: 99 },
    );
    expect(result.errors?.[0]?.message).toMatch(/no stub registered/);
  });

  it("preloads the schema-specific Giganto manifest when fixtureSchema='giganto'", async () => {
    const isolated = await startMockServer({
      port: 0,
      fixtureSchema: "giganto",
    });
    try {
      const result = await gql<{
        config: { ingestSrvAddr: string; graphqlSrvAddr: string };
      }>(
        isolated.url,
        `query FetchGigantoConfig {
           config {
             ingestSrvAddr
             graphqlSrvAddr
           }
         }`,
      );
      expect(result.errors).toBeUndefined();
      expect(result.data?.config).toEqual({
        ingestSrvAddr: "127.0.0.1:38370",
        graphqlSrvAddr: "127.0.0.1:8444",
      });
    } finally {
      await isolated.close();
    }
  });

  it("routes to the stub via a fragment spread on the root selection", async () => {
    // Schema-valid documents can hide their root field behind a fragment
    // spread (`query Q { ...RootFields } fragment RootFields on Query { ...
    // }`). The router must follow the spread to discover the real root
    // field, otherwise it falls back to the operation name `Q` and returns
    // `no stub registered` even though the manifest pre-loaded the right
    // fixture.
    const result = await gql<{ eventList: { totalCount: string } }>(
      server.url,
      `query Q($filter: EventListFilterInput!, $first: Int) { ...RootFields }
       fragment RootFields on Query {
         eventList(filter: $filter, first: $first) { totalCount }
       }`,
      { filter: {}, first: 10 },
    );
    expect(result.errors).toBeUndefined();
    expect(result.data?.eventList.totalCount).toBe("0");
  });

  it("rejects schema-violating queries with HTTP 400", async () => {
    const res = await fetch(server.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "{ thisFieldDoesNotExist }" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns a structured error when no stub is registered", async () => {
    const registry = new StubRegistry();
    const isolated = await startMockServer({ port: 0, registry });
    try {
      const result = await gql<unknown>(
        isolated.url,
        "{ indicatorList { name } }",
      );
      expect(result.errors?.[0]?.message).toMatch(/no stub registered/);
    } finally {
      await isolated.close();
    }
  });

  it("supports a `kind: errors` stub", async () => {
    const registry = new StubRegistry();
    registry.register(
      { operation: "indicatorList" },
      { kind: "errors", errors: [{ message: "synthetic-error" }] },
    );
    const isolated = await startMockServer({
      port: 0,
      registry,
      loadManifest: false,
    });
    try {
      const result = await gql<unknown>(
        isolated.url,
        "{ indicatorList { name } }",
      );
      expect(result.errors?.[0]?.message).toBe("synthetic-error");
    } finally {
      await isolated.close();
    }
  });

  it("/health returns ok", async () => {
    const res = await fetch(`${server.url.replace("/graphql", "")}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("ok");
  });

  describe("admin stub endpoint", () => {
    it("registers a manifest-declared fixture via POST /__admin/stubs", async () => {
      // Use an isolated server so the global `server`'s preloaded manifest
      // stays untouched by the DELETE at the end. `loadManifest: false`
      // skips preload but the admin endpoint's allow-list is still built
      // from `manifest.json` — so the path below is accepted.
      const isolated = await startMockServer({ port: 0, loadManifest: false });
      const adminUrl = `${isolated.url.replace("/graphql", "")}/__admin/stubs`;
      try {
        const register = await fetch(adminUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            operation: "eventList",
            response: {
              kind: "fixture",
              fixture: "detection/eventList.empty.json",
            },
          }),
        });
        expect(register.status).toBe(201);

        const result = await gql<{ eventList: { totalCount: string } }>(
          isolated.url,
          `query Q($filter: EventListFilterInput!, $first: Int) {
             eventList(filter: $filter, first: $first) { totalCount }
           }`,
          { filter: {}, first: 10 },
        );
        expect(result.errors).toBeUndefined();
        expect(result.data?.eventList.totalCount).toBe("0");

        const clear = await fetch(adminUrl, { method: "DELETE" });
        expect(clear.status).toBe(200);

        const afterClear = await gql<{ eventList: unknown }>(
          isolated.url,
          `query Q($filter: EventListFilterInput!, $first: Int) {
             eventList(filter: $filter, first: $first) { totalCount }
           }`,
          { filter: {}, first: 10 },
        );
        expect(afterClear.errors?.[0]?.message).toMatch(/no stub registered/);
      } finally {
        await isolated.close();
      }
    });

    it("rejects fixture paths registered under a mismatched operation", async () => {
      // The admin allow-list is keyed by `(fixture path, operation)` — not
      // raw path. `detection/eventList.empty.json` is declared in the
      // manifest for `eventList`, and preflight only ran it through the
      // eventList query document. Registering the same path under
      // `indicatorList` would serve a response preflight never validated
      // for that operation, so the admin endpoint refuses it.
      const isolated = await startMockServer({ port: 0, loadManifest: false });
      const adminUrl = `${isolated.url.replace("/graphql", "")}/__admin/stubs`;
      try {
        const res = await fetch(adminUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            operation: "indicatorList",
            response: {
              kind: "fixture",
              fixture: "detection/eventList.empty.json",
            },
          }),
        });
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error?: string };
        expect(body.error).toMatch(/declared in manifest\.json for operation/);
        expect(body.error).toContain("'eventList'");
        expect(body.error).toContain("'indicatorList'");
      } finally {
        await isolated.close();
      }
    });

    it("rejects fixture paths that are not in manifest.json", async () => {
      // Closes the escape hatch the admin endpoint used to leave open —
      // any path under the fixtures root would load without being covered
      // by the pre-test preflight. Only manifest-declared paths are now
      // accepted, so a future feature PR cannot sneak an un-validated
      // fixture past the schema check.
      const isolated = await startMockServer({ port: 0, loadManifest: false });
      const adminUrl = `${isolated.url.replace("/graphql", "")}/__admin/stubs`;
      try {
        const res = await fetch(adminUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            operation: "eventList",
            response: {
              kind: "fixture",
              fixture: "detection/eventList.does-not-exist.json",
            },
          }),
        });
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error?: string };
        expect(body.error).toMatch(/not declared in .*manifest\.json/);
      } finally {
        await isolated.close();
      }
    });

    it("rejects a cross-schema fixture on a schema-specific server", async () => {
      const isolated = await startMockServer({
        port: 0,
        loadManifest: false,
        fixtureSchema: "giganto",
      });
      const adminUrl = `${isolated.url.replace("/graphql", "")}/__admin/stubs`;
      try {
        const res = await fetch(adminUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            operation: "config",
            response: {
              kind: "fixture",
              fixture: "external/tivan/config.base.json",
            },
          }),
        });
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error?: string };
        expect(body.error).toMatch(/not declared in .*manifest\.giganto\.json/);
      } finally {
        await isolated.close();
      }
    });

    it("rejects inline fixture JSON (`data`) on the admin endpoint", async () => {
      // Inline fixture data would bypass the pre-test preflight entirely,
      // so the admin wire format does not accept it. In-process tests can
      // still use `StubRegistry.register({ kind: "fixture", data })`
      // directly — they do not cross the admin boundary.
      const isolated = await startMockServer({ port: 0, loadManifest: false });
      const adminUrl = `${isolated.url.replace("/graphql", "")}/__admin/stubs`;
      try {
        const res = await fetch(adminUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            operation: "eventList",
            response: {
              kind: "fixture",
              data: { eventList: { totalCount: "0", edges: [] } },
            },
          }),
        });
        expect(res.status).toBe(400);
      } finally {
        await isolated.close();
      }
    });

    it("matchVariables narrows to a specific variables subset", async () => {
      // Combine an errors catch-all with a narrow-match manifest fixture to
      // prove variable-keyed routing — the fixture is only served when
      // `first: 10`; every other shape falls through to the errors stub.
      const registry = new StubRegistry();
      const isolated = await startMockServer({
        port: 0,
        registry,
        loadManifest: false,
      });
      try {
        const adminUrl = `${isolated.url.replace("/graphql", "")}/__admin/stubs`;
        const fallback = await fetch(adminUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            operation: "eventList",
            response: {
              kind: "errors",
              errors: [{ message: "catchall-error" }],
            },
          }),
        });
        expect(fallback.status).toBe(201);
        const narrow = await fetch(adminUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            operation: "eventList",
            matchVariables: { first: 10 },
            response: {
              kind: "fixture",
              fixture: "detection/eventList.empty.json",
            },
          }),
        });
        expect(narrow.status).toBe(201);

        const query = `
          query Q($filter: EventListFilterInput!, $first: Int) {
            eventList(filter: $filter, first: $first) {
              totalCount
              edges { cursor }
            }
          }
        `;
        const matched = await gql<{ eventList: { totalCount: string } }>(
          isolated.url,
          query,
          { filter: {}, first: 10 },
        );
        expect(matched.errors).toBeUndefined();
        expect(matched.data?.eventList.totalCount).toBe("0");

        const missed = await gql<{ eventList: unknown }>(isolated.url, query, {
          filter: {},
          first: 50,
        });
        expect(missed.errors?.[0]?.message).toBe("catchall-error");
      } finally {
        await isolated.close();
      }
    });

    it("treats an empty matchVariables on the admin endpoint as a catch-all", async () => {
      // Without normalization, `matchVariables: {}` registers a specific
      // matcher whose predicate always returns true — it would shadow a
      // narrower stub registered earlier, because the specificity tier is
      // walked last-registered-first. The admin path must collapse `{}` to
      // the catch-all tier so manifest and admin wire formats agree on the
      // meaning of an empty subset.
      const isolated = await startMockServer({ port: 0, loadManifest: false });
      const adminUrl = `${isolated.url.replace("/graphql", "")}/__admin/stubs`;
      try {
        const narrow = await fetch(adminUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            operation: "eventList",
            matchVariables: { first: 10 },
            response: {
              kind: "errors",
              errors: [{ message: "narrow-admin-stub" }],
            },
          }),
        });
        expect(narrow.status).toBe(201);
        // Empty matchVariables — would shadow `narrow` without normalization
        // because it's registered after and its predicate matches everything.
        const emptyMatch = await fetch(adminUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            operation: "eventList",
            matchVariables: {},
            response: {
              kind: "errors",
              errors: [{ message: "empty-match-stub" }],
            },
          }),
        });
        expect(emptyMatch.status).toBe(201);

        const query = `
          query Q($filter: EventListFilterInput!, $first: Int) {
            eventList(filter: $filter, first: $first) { totalCount }
          }
        `;
        const matched = await gql<{ eventList: unknown }>(isolated.url, query, {
          filter: {},
          first: 10,
        });
        expect(matched.errors?.[0]?.message).toBe("narrow-admin-stub");

        const fallback = await gql<{ eventList: unknown }>(
          isolated.url,
          query,
          { filter: {}, first: 99 },
        );
        expect(fallback.errors?.[0]?.message).toBe("empty-match-stub");
      } finally {
        await isolated.close();
      }
    });

    it("scoped DELETE clears only stubs registered with that scope", async () => {
      // Two specs share the mock server in CI. If spec A's afterAll calls
      // DELETE without a scope, it wipes spec B's stubs mid-run. Scoped
      // delete fixes that — each spec only clears what it registered.
      const isolated = await startMockServer({ port: 0, loadManifest: false });
      const adminUrl = `${isolated.url.replace("/graphql", "")}/__admin/stubs`;
      try {
        const register = async (
          scope: string,
          operation: string,
          message: string,
        ) => {
          const r = await fetch(adminUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              operation,
              scope,
              response: { kind: "errors", errors: [{ message }] },
            }),
          });
          expect(r.status).toBe(201);
        };
        await register("alpha", "indicatorList", "alpha-stub-error");
        await register("beta", "eventTagList", "beta-stub-error");

        const indicatorBefore = await gql<{ indicatorList: unknown }>(
          isolated.url,
          "{ indicatorList { name } }",
        );
        expect(indicatorBefore.errors?.[0]?.message).toBe("alpha-stub-error");
        const modelBefore = await gql<{ eventTagList: unknown }>(
          isolated.url,
          "{ eventTagList { name } }",
        );
        expect(modelBefore.errors?.[0]?.message).toBe("beta-stub-error");

        // Clear only `alpha`. `beta`'s stub must survive.
        const cleared = await fetch(`${adminUrl}?scope=alpha`, {
          method: "DELETE",
        });
        expect(cleared.status).toBe(200);

        const indicatorAfter = await gql<{ indicatorList: unknown }>(
          isolated.url,
          "{ indicatorList { name } }",
        );
        expect(indicatorAfter.errors?.[0]?.message).toMatch(
          /no stub registered/,
        );
        const modelAfter = await gql<{ eventTagList: unknown }>(
          isolated.url,
          "{ eventTagList { name } }",
        );
        expect(modelAfter.errors?.[0]?.message).toBe("beta-stub-error");
      } finally {
        await isolated.close();
      }
    });

    it("rejects a malformed admin request with HTTP 400", async () => {
      const adminUrl = `${server.url.replace("/graphql", "")}/__admin/stubs`;
      const res = await fetch(adminUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notAnOperation: true }),
      });
      expect(res.status).toBe(400);
    });

    it("admin=false disables the registration endpoint", async () => {
      const isolated = await startMockServer({
        port: 0,
        admin: false,
        loadManifest: false,
      });
      try {
        const res = await fetch(
          `${isolated.url.replace("/graphql", "")}/__admin/stubs`,
          { method: "DELETE" },
        );
        expect(res.status).toBe(404);
      } finally {
        await isolated.close();
      }
    });
  });

  describe("HTTPS + mTLS", () => {
    // openssl is a CI prerequisite — skip if it's missing.
    const opensslAvailable = (() => {
      try {
        execFileSync("openssl", ["version"], { stdio: "pipe" });
        return true;
      } catch {
        return false;
      }
    })();

    it.skipIf(!opensslAvailable)(
      "serves over HTTPS and requires mTLS from the client",
      async () => {
        const dir = mkdtempSync(join(tmpdir(), "mock-tls-"));
        const certs = ensureTestCerts(dir);
        const server = await startMockServer({
          port: 0,
          tls: {
            cert: certs.serverCert,
            key: certs.serverKey,
            ca: certs.caCert,
          },
        });
        try {
          expect(server.url.startsWith("https://")).toBe(true);
          const agent = new Agent({
            connect: {
              ca: readFileSync(certs.paths.caPath, "utf8"),
              cert: readFileSync(certs.paths.clientCertPath, "utf8"),
              key: readFileSync(certs.paths.clientKeyPath, "utf8"),
            },
          });
          try {
            const res = await undiciFetch(server.url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                query: "{ __schema { queryType { name } } }",
              }),
              dispatcher: agent,
            });
            expect(res.status).toBe(200);
            const body = (await res.json()) as {
              data?: { __schema: { queryType: { name: string } } };
            };
            expect(body.data?.__schema.queryType.name).toBe("Query");
          } finally {
            await agent.close();
          }

          const noClientCertAgent = new Agent({
            connect: { ca: readFileSync(certs.paths.caPath, "utf8") },
          });
          try {
            await expect(
              undiciFetch(server.url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  query: "{ __schema { queryType { name } } }",
                }),
                dispatcher: noClientCertAgent,
              }),
            ).rejects.toBeDefined();
          } finally {
            await noClientCertAgent.close();
          }
        } finally {
          await server.close();
        }
      },
    );
  });
});
