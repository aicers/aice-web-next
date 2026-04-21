# Testing

This repo has three test tiers, all runnable in CI without any external
service except a local PostgreSQL (which the CI workflow brings up as a
service container).

| Tier        | Runner     | Real DB | Browser | Mock REview GraphQL                 |
|-------------|------------|---------|---------|-------------------------------------|
| Unit        | Vitest     | mocked  | no      | optional (in-process fixtures)      |
| Integration | Vitest     | yes     | no      | yes — `globalSetup` boots one       |
| E2E         | Playwright | yes     | yes     | yes — `globalSetup` boots one       |

```bash
pnpm test              # unit
pnpm test:integration  # integration (needs Postgres)
pnpm e2e               # E2E (needs Postgres + Playwright deps)
```

The integration and E2E tiers both **own the app process**. They refuse to
reuse a dev server that is already listening on the target port, because
a pre-existing process does not have the harness-controlled
`REVIEW_GRAPHQL_ENDPOINT` / `MTLS_*` env — reusing it would silently route
REview-backed requests to the wrong backend. If you have `pnpm dev`
running on port 3000 (or 3001 for integration), stop it before invoking
`pnpm e2e` / `pnpm test:integration`, or point the harness at another
port via `INTEGRATION_SERVER_URL`.

The rest of this document covers the test harness — the plumbing that lets
the integration and E2E tiers run without a live REview / Giganto instance.

## How the harness fits together

```text
                    ┌────────────────────────────────────┐
                    │  globalSetup (Vitest / Playwright) │
                    │                                    │
                    │  1. validate fixtures vs schema    │
                    │  2. generate test mTLS certs       │
                    │  3. start mock REview GraphQL      │
                    │     (HTTPS + mTLS)                 │
                    │  4. point app at mock via          │
                    │     REVIEW_GRAPHQL_ENDPOINT        │
                    │     and MTLS_* env vars            │
                    └─────────────┬──────────────────────┘
                                  │
            ┌─────────────────────┼─────────────────────┐
            ▼                     ▼                     ▼
     ┌─────────────┐       ┌─────────────┐       ┌─────────────┐
     │ Unit tests  │       │ Integration │       │ Playwright  │
     │ (in-proc)   │       │ tests       │       │ tests       │
     └─────────────┘       └──────┬──────┘       └──────┬──────┘
                                  │                     │
                                  ▼                     ▼
                           ┌─────────────────────────────────┐
                           │ Mock REview GraphQL (node:https)│
                           │  - vendored schema              │
                           │  - canned fixtures              │
                           │  - introspection                │
                           │  - /__admin/stubs               │
                           └─────────────────────────────────┘
```

Implementation lives under `src/test-harness/`:

- `schema.ts` — loads & caches the vendored `schemas/review.graphql`.
- `fixtures.ts` — loads JSON fixtures and validates them against the schema.
- `mock-server.ts` — a `node:http` / `node:https` GraphQL server that
  executes queries against the vendored schema using the registered fixture
  as the resolver root value. Exposes a `/__admin/stubs` endpoint for
  scenario-specific stubs and a `/health` probe.
- `test-certs.ts` — idempotently generates a short-lived CA + server + client
  cert (EC P-256, 1-day validity) to a directory. Used by globalSetup on both
  the integration and E2E tiers.

Why schema-backed execution: of the three approaches the issue lists for
fixture validation (codegen + structural assertions / runtime validator /
mock resolver execution), this repo uses **mock resolver execution**. Every
fixture is fed through `graphql.execute()` with the vendored schema, so the
schema's runtime type checks (non-null violations, scalar coercion, unknown
fields) are the validator. No extra dependencies, the same code path serves
both pre-test validation and live mock-server requests.

## Adding a fixture

1. Drop a `.graphql` file describing the operation under
   `src/__tests__/fixtures/<area>/`. It must parse against
   `schemas/review.graphql`.
2. Drop a `.json` file beside it with the canned response, shaped like
   `{ "<rootField>": <data> }`.
3. Append an entry to `src/__tests__/fixtures/manifest.json`:

   ```json
   {
     "operation": "<rootField>",
     "query": "<area>/<file>.graphql",
     "fixture": "<area>/<file>.json",
     "variables": { "...": "..." }
   }
   ```

4. Both vitest's integration `globalSetup` and Playwright's `globalSetup`
   call `runFixturePreflight()` before any test runs. The preflight does
   five things:
   - **Coverage.** Every `.json` fixture and `.graphql` document under
     `src/__tests__/fixtures/` must be declared in `manifest.json`. A
     fixture JSON sitting in the tree but missing from the manifest
     fails the preflight with an explicit error, so an author cannot
     register an un-validated fixture over `/__admin/stubs` by accident.
   - **Consistency.** For each manifest entry, `entry.operation` must
     match a top-level field selected by `entry.query` (fragment spreads
     on the operation's root selection set are followed, so a document
     like `query Q { ...RootFields } fragment RootFields on Query
     { eventList { … } }` is equivalent to one that selects `eventList`
     inline), and the fixture JSON must own a top-level key named
     `entry.operation` (explicit `null` counts — a missing key does
     not). This catches manifest typos that would otherwise produce a
     silent `null` response under `graphql.execute()` on nullable roots,
     or a `no stub registered` error at request time because
     `preloadManifestStubs()` keys the live registry off
     `entry.operation`.
   - **Catch-all safety.** A manifest entry with no `variables` (or
     `variables: {}`) paired with a query that declares a required
     non-null variable without a default is rejected — see the
     catch-all paragraph below.
   - **Matcher conflicts.** Manifest entries whose matchers would leave
     the live registry order-dependent are rejected. The live resolver
     is specificity-first — the matcher with the most constrained
     `matchVariables` keys wins among those that match — and falls
     through to last-registered only on ties within a tier. Preflight
     catches both flavours of ambiguity up front:
     - **Identical matchers.** Two catch-alls for one operation, or two
       narrow entries with the same `variables` shape, tie at the top
       of their tier — manifest order silently decides which fixture
       wins. Rejected.
     - **Overlapping non-subset matchers.** Two entries like
       `{a:1, b:2}` and `{a:1, c:3}` agree on their one shared key and
       have the same key count, so a request carrying `{a:1, b:2, c:3}`
       satisfies both at the same specificity. Neither is strictly more
       specific than the other, so specificity-first falls back to
       registration order. Rejected.
     A strict-subset overlap (one matcher's keys are a strict superset
     of the other's, values agree on shared keys — e.g. `{ first: 10 }`
     vs `{ filter: {}, first: 10 }`) is **allowed**: the larger matcher
     wins deterministically under specificity-first, so manifest order
     cannot change the outcome.
   - **Schema execution.** Every manifest entry is executed against
     `schemas/review.graphql` — a malformed fixture fails the run with
     the exact GraphQL error.
   - Files whose basename ends with `.malformed.json` (or
     `.malformed.graphql`) are treated as deliberate negative-path
     fixtures — they are allowed to exist outside the manifest and the
     validator-rejection unit test loads them directly.

The `variables` field has two roles: it is the input passed to
`graphql.execute()` for fixture validation, **and** it is the runtime
matcher for the preloaded stub. Multiple manifest entries can therefore
share the same `operation` as long as their `variables` either differ on
a shared key or one is a strict superset of the other — each entry's
stub fires only for requests whose variables match (subset JSON-equality
per key). An entry with no `variables` (or an empty object) registers a
catch-all default for that operation. Preflight rejects both identical
matchers (two catch-alls for one op, or two narrow entries with the same
`variables`) and overlapping non-subset matchers (see "Matcher
conflicts" above), because either pattern would leave the resolver
order-dependent within a tier.

A catch-all manifest entry (omitted or empty `variables`) is only valid
when the paired query declares no required variables. If the query has
any non-null variable without a default — `eventList`'s current
`$filter: EventListFilterInput!` is the concrete example — concrete
values are mandatory in `variables`, because `graphql.execute()` refuses
to run a document with a missing required variable and there is no
"skip validation" path. The preflight rejects this combination with a
clear error at startup (see `checkManifestCatchAllSafety()` in
`src/test-harness/fixtures.ts`), so an author cannot accidentally ship a
catch-all manifest entry that would fail the schema validator. For
scenario-level catch-all behaviour on operations that do take required
inputs, register a stub at request time via `/__admin/stubs` with an
omitted or empty `matchVariables`.

`StubRegistry.resolve()` is **specificity-first**, and specificity is
`Object.keys(matchVariables).length`. Among the specific matchers whose
`matchVariables` subset is satisfied by the request, the one with the
largest key count wins. A strict-subset pair (e.g. `{ first: 10 }` vs
`{ filter: {}, first: 10 }`) is safe because the 2-key matcher is
strictly more specific and wins deterministically. Catch-alls (no
`matchVariables`) are only consulted when no specific matcher fires.
So a manifest where a catch-all entry follows a narrower entry still
routes narrow requests to the narrow fixture — the order in which the
entries appear in `manifest.json` is immaterial. The same specificity
rule applies to admin-registered and in-process stubs. Ambiguous
overlaps (same key count, neither strictly more specific) would tie at
the top of the specific tier and fall through to registration order —
preflight rejects that pattern (see "Matcher conflicts" above).

Per-key equality uses the same deep-sorted canonical JSON serializer
that `checkManifestDuplicates()` hashes on, so object-shaped variable
values (REview's `$filter`, for example) compare equal regardless of
the property-construction order at the call site. Preflight treats
`{ filter: { a: 1, b: 2 } }` and `{ filter: { b: 2, a: 1 } }` as the
same matcher, and the runtime matcher agrees — a request built with a
different key order than the fixture's `variables` still hits the
preloaded stub.

A request that matches no manifest entry — and no scenario stub
registered via the admin endpoint — gets a structured `no stub
registered` error in the response, instead of silently picking up
another scenario's fixture.

There is a deliberate negative-path fixture
(`detection/eventList.malformed.json`) and a unit test
(`src/__tests__/lib/test-harness/fixtures.test.ts`) that proves the
validator rejects it. Keep the `.malformed.json` naming convention —
the preflight uses that suffix to allow the file to exist outside the
manifest without failing the coverage check.

## Stubbing a new GraphQL operation in the mock server

Every entry in `manifest.json` is registered with the mock server at
startup. When you need finer control (per-variables matching, error
responses, multiple scenarios for one operation), use one of two paths
depending on where your test runs.

### In-process (unit tests, or a mock you spin up yourself)

```ts
import { startMockServer, StubRegistry } from "@/test-harness/mock-server";

const registry = new StubRegistry();
registry.register(
  { operation: "eventList", matchVariables: { first: 100 } },
  { kind: "fixture", data: { eventList: { /* ... */ } } },
);
registry.register(
  { operation: "eventList" },
  { kind: "errors", errors: [{ message: "boom" }] },
);

const server = await startMockServer({ registry, loadManifest: false });
// ... use server.url, then await server.close()
```

Stubs are matched by specificity first (more `matchVariables` keys
wins), then last-registered wins within a tie at the same key count.
A specific matcher whose subset is satisfied always beats a catch-all
(no `matchVariables`) for the same operation, regardless of order. The
schema still executes the response on every request, so a stub whose
data violates the schema will surface as `errors` in the response.

### Across processes (Playwright specs, integration tests)

Playwright workers run in separate processes and cannot share a
`StubRegistry` instance with globalSetup. Register stubs over HTTP
against the server's `/__admin/stubs` endpoint instead. CI runs up to
four Playwright workers in parallel, so a global registry shared by all
of them needs **per-spec scoping** — otherwise one spec's `afterAll`
DELETE would wipe another spec's stubs mid-run, and two specs registering
the same `(operation, matchVariables)` would race.

Use `mockServerSession()` from `e2e/mock-server-admin.ts`. It generates a
unique scope token for the spec, tags every stub with it, and only clears
that scope on teardown:

```ts
import { mockServerSession } from "./mock-server-admin";

const session = mockServerSession();

test.beforeAll(async () => {
  await session.registerStub({
    operation: "eventList",
    matchVariables: { first: 100 },
    response: { kind: "fixture", fixture: "detection/eventList.busy.json" },
  });
});

test.afterAll(async () => {
  await session.clear(); // removes only this spec's stubs
});
```

### Integration tests (Vitest)

Integration tests consume the same admin endpoint through
`src/__integration__/helpers/mock-graphql.ts`, which is the `graphqlRequest`
fixture layer the harness ships for feature integration tests. It exposes
three things:

- `mockGraphqlSession()` — a per-file admin session that tags every stub
  it registers with a unique scope and only clears that scope on teardown.
  Integration tests run sequentially today (`fileParallelism: false`), but
  the scoped API means a future switch to parallel files, or a single file
  registering multiple disjoint scopes, does not risk cross-file stub
  wipes.
- `callGraphQL(document, variables?, opts?)` — a thin wrapper around the
  production `graphqlRequest()` client that resets the cached GraphQL
  client before each call (so changes to `REVIEW_GRAPHQL_ENDPOINT`
  between tests take effect) and supplies a default context JWT claim
  (`SYSTEM_ADMINISTRATOR`, empty `customer_ids`). Feature tests use this
  to exercise a query document against the mock fixtures without going
  through Next.js.
- `loadFixtureJson(path)` — re-export of the harness loader so feature
  tests can assert against the same canned payload the mock server is
  serving, without importing from `@/test-harness/`.

```ts
import { parse } from "graphql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  callGraphQL,
  loadFixtureJson,
  mockGraphqlSession,
} from "../helpers/mock-graphql";

const EVENT_LIST = parse(`
  query EventListBusy($filter: EventListFilterInput!, $first: Int) {
    eventList(filter: $filter, first: $first) {
      totalCount
    }
  }
`);

describe("detection event list (integration)", () => {
  const session = mockGraphqlSession();

  beforeAll(async () => {
    await session.registerStub({
      operation: "eventList",
      matchVariables: { first: 100 },
      response: { kind: "fixture", fixture: "detection/eventList.busy.json" },
    });
  });

  afterAll(async () => {
    await session.clear();
  });

  it("returns the busy-scenario fixture", async () => {
    const fixture = loadFixtureJson("detection/eventList.busy.json");
    const data = await callGraphQL(EVENT_LIST, { filter: {}, first: 100 });
    expect(data).toEqual(fixture);
  });
});
```

`src/__integration__/api/graphql-helper.test.ts` exercises both paths as
a smoke and doubles as a reference for feature integration tests.

When two specs need to stub the **same** `(operation, matchVariables)`
they will still race each other (last registration wins, since requests
have no scope-routing channel through the dev server). Disambiguate by
giving each spec a distinct `matchVariables` shape, or — if that is not
possible — put the colliding specs in their own Playwright project and
chain via `dependencies` to force serial execution, the same pattern the
`mfa-policy-*` projects already use in `playwright.config.ts`.

The admin endpoint accepts:

- `operation: string` — top-level field to match.
- `matchVariables?: Record<string, unknown>` — optional subset; each key
  must equal-by-JSON the incoming request variable. Omit to match any
  variables. An empty object (`matchVariables: {}`) is collapsed to the
  same catch-all tier as omitting the field — otherwise it would register
  a "specific" matcher whose predicate always returns true, and the
  specificity-first resolver would then route every request to that stub
  regardless of narrower matchers registered earlier. The manifest preload
  applies the same normalization, so both paths agree on the meaning of an
  empty subset.
- `scope?: string` — caller-supplied scope tag. `mockServerSession()`
  fills this in; call sites that use the bare `registerStub` may pass it
  manually.
- `response`: either
  `{ kind: "fixture", fixture: "<path-relative-to-fixtures>" }` (the path
  **must** be declared in `manifest.json` **for the same `operation` as
  the request**) or `{ kind: "errors", errors: [{ message }] }`.

The admin allow-list is keyed by the `(fixture, operation)` pair from
`manifest.json`, not just by raw path. A POST that references a declared
path but pairs it with a different `operation` than the manifest records
is rejected with HTTP 400, because preflight only executed that fixture
against its manifest-declared operation's query document — registering it
under a different operation would serve a payload the pre-test hook never
validated. If a fixture legitimately needs to be served for more than one
operation, add a manifest entry for each pair (the preflight will then
run the JSON through each query document) before registering it.

The admin wire format deliberately does **not** accept inline fixture
JSON. Every fixture payload served to a running test has to come from a
file under `src/__tests__/fixtures/` that is covered by the manifest, so
the pre-test preflight validates it against the vendored schema. A POST
that references an undeclared path, pairs a declared path with an
unrelated operation, or uses inline `data`, is rejected with HTTP 400.
In-process unit tests that spin up their own server can still use
`StubRegistry.register({ kind: "fixture", data })` directly — they do not
cross the admin boundary and are not subject to the allow-list.

`DELETE /__admin/stubs?scope=<token>` removes only stubs registered with
that scope. `DELETE /__admin/stubs` (no query string) wipes the entire
registry — only call it from a Playwright `globalTeardown` after every
worker has finished.

## Writing a new Playwright scenario

1. Add `<feature>.spec.ts` next to the existing `*.spec.ts` files in
   `e2e/`. It is automatically picked up by the `parallel` Playwright
   project unless you explicitly exclude it (see `playwright.config.ts`
   for serialization rules).
2. Use the helpers from `e2e/fixtures.ts` and `e2e/helpers/auth.ts` for
   per-worker accounts and sign-in.
3. If your feature triggers a REview GraphQL call, register the
   appropriate stub via `mockServerSession()` (see above). The server URL
   is at `mockServerUrl()` from `e2e/mock-server-state.ts`. For purely
   client-side features, no stub is necessary.
4. Keep new fixtures in `src/__tests__/fixtures/<area>/` and add them to
   `manifest.json` so the pre-test validator catches schema drift.

The harness ships exactly one Playwright spec — `harness.spec.ts` — that
proves Playwright can launch a browser context, that the Next.js dev
server is reachable, that the mock server answers introspection and the
canned `eventList` over mTLS, and that admin stub registration works from
a worker process. It does **not** visit any product route. Feature
scenarios are owned by their respective feature issues.

## mTLS handling in tests

Production reaches REview over mTLS. The harness mirrors that: the mock
server is served over **HTTPS + mTLS** using short-lived test certs
(EC P-256, 1-day validity) generated by `ensureTestCerts()` in
`src/test-harness/test-certs.ts`. The app's production mTLS code path in
`src/lib/mtls.ts` is exercised unchanged — no bypass is needed to make
`next dev` talk to the mock.

What globalSetup sets up:

- A CA, a server cert (CN=localhost, SAN localhost + 127.0.0.1), and a
  client cert (CN=aice-web-next), all signed by the CA.
- The mock server presents the server cert and requires the client to
  present a cert signed by the CA (`requestCert: true`,
  `rejectUnauthorized: true`).
- `MTLS_CA_PATH`, `MTLS_CERT_PATH`, `MTLS_KEY_PATH` are pointed at the
  generated files. The dev server's `mtls.ts` loads those paths at
  startup — same as production — and undici uses the client cert on every
  outbound request.

Certs are written under `<DATA_DIR>/certs/`; `ensureTestCerts()` is
idempotent, so reruns pick up the existing PEMs. It also checks validity
on every call — if the CA, server, or client cert has expired or will
expire within an hour, the whole set is wiped and a fresh chain is minted.
That way a developer data directory that sits idle for more than a day
never resurrects expired material on the next rerun.

### Bypass branch (unit tests only)

`src/lib/mtls.ts` still carries an env-gated bypass that returns a plain
undici `Agent` and an ephemeral ES256 signing key. It fires only when
**both** `NODE_ENV === "test"` **and** `TEST_ALLOW_PLAIN_GRAPHQL === "1"`
are set. This is kept for unit tests that call `graphqlRequest()` directly
without wanting to generate certs (see
`src/__tests__/lib/mtls-bypass.test.ts`). Neither the integration tier
nor the E2E tier sets `TEST_ALLOW_PLAIN_GRAPHQL` — they rely on real
test certs.

The full mTLS code path (cert reading, algorithm detection, JWT signing
with the cert's private key) is also exercised by
`src/__tests__/lib/mtls-e2e.test.ts`, which spins up a real HTTPS + mTLS
server using locally-generated CA + client + server certs.

## Schema versioning

`schemas/review.graphql` is a vendored copy of the upstream REview schema
pinned by `schemas/review.version`. When upstream changes, update both
files together — see the "Backend schema versions" section of `README.md`
for the procedure. The fixture validator and the mock server both load
the vendored copy, so out-of-date fixtures fail loudly the moment the
schema is bumped.
