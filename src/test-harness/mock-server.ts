import {
  createServer as createHttpServer,
  type Server as HttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";

import {
  type ExecutionResult,
  execute,
  type GraphQLError,
  type GraphQLSchema,
  parse,
  validate,
} from "graphql";

import {
  canonicalJson,
  extractRootFieldNames,
  type FixtureManifestEntry,
  loadFixtureJson,
  readManifest,
} from "./fixtures";
import { loadReviewSchema } from "./schema";

interface PostBody {
  query?: unknown;
  variables?: unknown;
  operationName?: unknown;
}

export interface StubMatcher {
  /** Operation name (matches the top-level field on Query/Mutation). */
  operation: string;
  /**
   * Optional variable subset. Each key must equal the incoming request
   * variable for the stub to match — comparison uses canonical JSON (keys
   * sorted at every object level), so object-shaped values compare the
   * same regardless of property-construction order. Omit (or pass an empty
   * object) to register a catch-all for the operation. Specific matchers
   * are ranked by `Object.keys(matchVariables).length` — the matcher with
   * more constrained keys wins when several match the same request, so
   * a strictly-narrower stub beats a broader one regardless of
   * registration order. See `StubRegistry.resolve()`.
   */
  matchVariables?: Record<string, unknown>;
}

export type StubResolver =
  | { kind: "fixture"; data: unknown }
  | { kind: "errors"; errors: { message: string }[] }
  // Destroy the underlying socket without writing a response. Undici then
  // surfaces this to the client as `ECONNRESET` / `socket hang up`, which
  // `withManagerErrorMapping` translates into `ManagerUnavailableError`.
  // Use this kind to exercise the offline-panel branch in tests; a 200
  // with `errors[]` would only produce a `ClientError`, which the page
  // is expected to let propagate as an unexpected failure.
  | { kind: "connectionFailure" };

interface RegisteredStub {
  matcher: StubMatcher;
  resolver: StubResolver;
  /**
   * Optional caller-supplied tag. `clearStubs({ scope })` removes only the
   * stubs registered with this scope, so two specs sharing the mock server
   * cannot wipe each other's state during teardown.
   */
  scope?: string;
}

/**
 * Per-key subset comparison using `canonicalJson()` — the same deep-sorted
 * serialization `checkManifestDuplicates()` hashes on. Object-shaped
 * variables (REview's `$filter`, etc.) must compare equal regardless of
 * property-construction order; plain `JSON.stringify()` preserves insertion
 * order and would cause the runtime matcher to disagree with preflight,
 * letting a request miss a logically-identical fixture just because the
 * filter was built in a different key order.
 */
function shallowEqualsSubset(
  subset: Record<string, unknown>,
  full: Record<string, unknown>,
): boolean {
  for (const [key, expected] of Object.entries(subset)) {
    if (canonicalJson(full[key]) !== canonicalJson(expected)) return false;
  }
  return true;
}

function normalizeMatcher(matcher: StubMatcher): StubMatcher {
  const mv = matcher.matchVariables;
  if (mv && Object.keys(mv).length > 0) return matcher;
  return { operation: matcher.operation };
}

/**
 * Mutable registry of canned responses. The mock server consults the
 * registry on every request, so tests can register / clear stubs at runtime
 * without restarting the server.
 */
export class StubRegistry {
  private stubs: RegisteredStub[] = [];

  register(matcher: StubMatcher, resolver: StubResolver, scope?: string): void {
    this.stubs.push({ matcher: normalizeMatcher(matcher), resolver, scope });
  }

  registerFixture(
    matcher: StubMatcher,
    fixturePath: string,
    scope?: string,
  ): void {
    this.register(
      matcher,
      { kind: "fixture", data: loadFixtureJson(fixturePath) },
      scope,
    );
  }

  /**
   * Select the stub for `(operation, variables)` using **specificity-first**
   * resolution.
   *
   * Among the specific matchers whose `matchVariables` subset is satisfied
   * by the request, the one with the largest `matchVariables` key count
   * wins. That means a strictly-narrower matcher always beats a broader
   * one: a manifest entry with `{ filter: {}, first: 10 }` (two constrained
   * keys) answers a request of the same shape instead of a sibling
   * `{ first: 10 }` (one key), regardless of manifest order.
   *
   * Specificity, not registration order, is the arbiter — so manifest
   * additions cannot silently steal traffic from an earlier narrower
   * entry. When two matchers have the same constrained-key count and
   * both satisfy the same request (same values on shared keys, disjoint
   * remaining keys — e.g. `{ a: 1, b: 2 }` vs `{ a: 1, c: 3 }` on a
   * request carrying all three), `checkManifestDuplicates()` rejects the
   * pair at preflight, so the tie-breaker below only ever fires for
   * admin-registered stubs. Last-registered wins within a tier there
   * because admin stubs are registered explicitly per-spec.
   *
   * Catch-alls (no `matchVariables`) are the fallback: they are consulted
   * only when no specific matcher fires, and the last-registered catch-all
   * wins.
   */
  resolve(
    operationName: string | undefined,
    variables: Record<string, unknown>,
  ): StubResolver | null {
    let best: RegisteredStub | null = null;
    let bestSpecificity = -1;
    for (const stub of this.stubs) {
      if (operationName && stub.matcher.operation !== operationName) continue;
      const mv = stub.matcher.matchVariables;
      if (!mv) continue;
      if (!shallowEqualsSubset(mv, variables)) continue;
      const specificity = Object.keys(mv).length;
      if (specificity >= bestSpecificity) {
        best = stub;
        bestSpecificity = specificity;
      }
    }
    if (best) return best.resolver;
    for (let i = this.stubs.length - 1; i >= 0; i--) {
      const stub = this.stubs[i];
      if (operationName && stub.matcher.operation !== operationName) continue;
      if (stub.matcher.matchVariables) continue;
      return stub.resolver;
    }
    return null;
  }

  /**
   * Remove stubs from the registry. With no scope, every stub is removed
   * (used by global teardown). With a scope, only stubs tagged with that
   * scope are removed — so a spec's `afterAll` can clean up only its own
   * stubs without touching other specs' (or the manifest preload's) state.
   */
  clear(scope?: string): void {
    if (scope === undefined) {
      this.stubs = [];
      return;
    }
    this.stubs = this.stubs.filter((s) => s.scope !== scope);
  }
}

/**
 * Wire format for the admin stub-registration endpoint. Specs running in
 * separate worker processes (Playwright) cannot share a `StubRegistry`
 * instance with globalSetup, so they POST one of these to `/__admin/stubs`
 * instead.
 *
 * The admin endpoint deliberately does **not** accept inline fixture JSON.
 * Every fixture payload served to a running test must come from a file
 * under `src/__tests__/fixtures/` that is declared in `manifest.json`, so
 * the pre-test preflight covers it against the vendored schema. Inline
 * data would bypass that validation entirely. Specs that need ad-hoc error
 * responses can still use `{ kind: "errors", ... }`.
 */
export interface AdminStubRequest {
  operation: string;
  /**
   * Optional variable subset that must equal the incoming request variables
   * (per-key canonical-JSON equality; object-shaped values match regardless
   * of property-construction order). Omit to match any variables.
   */
  matchVariables?: Record<string, unknown>;
  /**
   * Optional caller-supplied scope tag. Pair with `DELETE` `?scope=<token>`
   * to clean up only this scope's stubs from `afterAll` — required when
   * multiple Playwright workers share the mock server, so one spec's
   * teardown does not wipe another spec's stubs.
   */
  scope?: string;
  response:
    | { kind: "fixture"; fixture: string }
    | { kind: "errors"; errors: { message: string }[] }
    | { kind: "connectionFailure" };
}

export interface MockServerTlsOptions {
  cert: string;
  key: string;
  ca: string;
}

export interface MockServerOptions {
  port?: number;
  /** Pre-registered stub registry. A new one is created when omitted. */
  registry?: StubRegistry;
  /** Override the schema (used by tests). Defaults to the vendored REview schema. */
  schema?: GraphQLSchema;
  /** Pre-load fixtures from `src/__tests__/fixtures/manifest.json`. Default: true. */
  loadManifest?: boolean;
  /**
   * Enable HTTPS + mTLS. When set, the server presents the given cert and
   * requires connecting clients to present a cert signed by `ca`. This is
   * what the E2E and integration tiers use so the dev server exercises the
   * production mTLS path in `src/lib/mtls.ts` unchanged.
   */
  tls?: MockServerTlsOptions;
  /**
   * Enable the admin endpoints (`POST /__admin/stubs`, `DELETE /__admin/stubs`).
   * Defaults to true — specs running in separate worker processes register
   * their stubs this way. Set to false to harden fixture-only servers.
   */
  admin?: boolean;
}

export interface RunningMockServer {
  url: string;
  port: number;
  registry: StubRegistry;
  close: () => Promise<void>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function jsonResponse(
  res: ServerResponse,
  status: number,
  body: unknown,
): void {
  const json = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(json).toString());
  res.end(json);
}

function formatErrors(errors: readonly GraphQLError[]): { message: string }[] {
  return errors.map((e) => ({ message: e.message }));
}

function preloadManifestStubs(registry: StubRegistry): void {
  let manifest: FixtureManifestEntry[];
  try {
    manifest = readManifest();
  } catch {
    return;
  }
  // Each manifest entry's `variables` doubles as the runtime stub matcher,
  // so multiple fixtures of the same operation can coexist (one per
  // distinct variables shape). An entry with no `variables` registers a
  // catch-all default. This keeps "fixture inventory for validation" and
  // "default runtime stub" decoupled — adding a new scenario fixture for
  // an existing operation does not silently steal traffic from the others.
  for (const entry of manifest) {
    registry.registerFixture(
      buildVariablesMatcher(entry.operation, entry.variables),
      entry.fixture,
    );
  }
}

/**
 * Build a `StubMatcher` from a variables subset, collapsing empty / absent
 * subsets to a catch-all. An empty object (`{}`) would otherwise register a
 * zero-key specific matcher — satisfied by every request — so it would
 * shadow narrower matchers under specificity-first resolution. The admin
 * wire format and the manifest preload both funnel through this helper so
 * the two paths cannot disagree on what an empty matcher means.
 */
function buildVariablesMatcher(
  operation: string,
  variables: Record<string, unknown> | undefined,
): StubMatcher {
  if (!variables || Object.keys(variables).length === 0) {
    return { operation };
  }
  return { operation, matchVariables: variables };
}

function buildMatcher(req: AdminStubRequest): StubMatcher {
  return buildVariablesMatcher(req.operation, req.matchVariables);
}

function resolveAdminStub(
  req: AdminStubRequest,
  declaredFixtures: Map<string, Set<string>>,
): StubResolver {
  if (req.response.kind === "errors") return req.response;
  if (req.response.kind === "connectionFailure") return req.response;
  const path = req.response.fixture;
  const declaredOps = declaredFixtures.get(path);
  if (!declaredOps) {
    throw new Error(
      `fixture '${path}' is not declared in src/__tests__/fixtures/manifest.json. ` +
        "Admin-registered fixture stubs must reference manifest-declared " +
        "fixture files so the pre-test preflight validates them against " +
        "schemas/review.graphql.",
    );
  }
  if (!declaredOps.has(req.operation)) {
    const declaredList = [...declaredOps]
      .map((o) => `'${o}'`)
      .sort()
      .join(", ");
    throw new Error(
      `fixture '${path}' is declared in manifest.json for operation(s) ` +
        `${declaredList}, but the admin request registers it under ` +
        `'${req.operation}'. The admin endpoint keys fixture payloads by ` +
        "manifest metadata, not raw path, so a mismatch would serve a " +
        "response preflight never executed against this operation's query. " +
        "Change the request's `operation` to match the manifest entry, or " +
        "add a manifest entry pairing this fixture with " +
        `'${req.operation}' and re-run preflight.`,
    );
  }
  return { kind: "fixture", data: loadFixtureJson(path) };
}

/**
 * Map each manifest-declared fixture path to the set of operations the
 * manifest pairs it with. Used as the admin endpoint's allow-list: the
 * POSTed `operation` must be one of the operations the fixture was
 * preflight-validated against.
 */
function readDeclaredFixtures(): Map<string, Set<string>> {
  try {
    const map = new Map<string, Set<string>>();
    for (const entry of readManifest()) {
      const ops = map.get(entry.fixture) ?? new Set<string>();
      ops.add(entry.operation);
      map.set(entry.fixture, ops);
    }
    return map;
  } catch {
    return new Map();
  }
}

function parseScopeFromUrl(url: string): string | undefined {
  const queryStart = url.indexOf("?");
  if (queryStart === -1) return undefined;
  const params = new URLSearchParams(url.slice(queryStart + 1));
  const scope = params.get("scope");
  return scope ?? undefined;
}

async function handleAdminStubs(
  method: string,
  registry: StubRegistry,
  declaredFixtures: Map<string, Set<string>>,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (method === "DELETE") {
    const scope = parseScopeFromUrl(req.url ?? "");
    registry.clear(scope);
    jsonResponse(res, 200, { ok: true, cleared: true, scope: scope ?? null });
    return;
  }
  if (method !== "POST") {
    jsonResponse(res, 405, { error: "method not allowed" });
    return;
  }
  let parsed: AdminStubRequest;
  try {
    parsed = JSON.parse(await readBody(req)) as AdminStubRequest;
  } catch (err) {
    jsonResponse(res, 400, {
      error: `invalid JSON body: ${(err as Error).message}`,
    });
    return;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof parsed.operation !== "string" ||
    parsed.operation.length === 0 ||
    typeof parsed.response !== "object" ||
    parsed.response === null
  ) {
    jsonResponse(res, 400, {
      error: "body must be { operation: string, response: {...} }",
    });
    return;
  }
  if (parsed.scope !== undefined && typeof parsed.scope !== "string") {
    jsonResponse(res, 400, {
      error: "`scope`, when present, must be a string",
    });
    return;
  }
  try {
    const matcher = buildMatcher(parsed);
    const resolver = resolveAdminStub(parsed, declaredFixtures);
    registry.register(matcher, resolver, parsed.scope);
  } catch (err) {
    jsonResponse(res, 400, { error: (err as Error).message });
    return;
  }
  jsonResponse(res, 201, {
    ok: true,
    registered: parsed.operation,
    scope: parsed.scope ?? null,
  });
}

export async function startMockServer(
  opts: MockServerOptions = {},
): Promise<RunningMockServer> {
  const registry = opts.registry ?? new StubRegistry();
  if (opts.loadManifest !== false) preloadManifestStubs(registry);
  const schema = opts.schema ?? loadReviewSchema();
  const adminEnabled = opts.admin !== false;
  // Always built from the manifest, even when `loadManifest: false` — this
  // is the allow-list the admin endpoint checks against, not the preload
  // source. Isolating the registry from the manifest preload should not
  // also disable preflight-backed fixture enforcement.
  const declaredFixtures = readDeclaredFixtures();

  const handler = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    if (!req.url) {
      jsonResponse(res, 404, { error: "not found" });
      return;
    }
    if (req.method === "GET" && req.url === "/health") {
      jsonResponse(res, 200, { status: "ok" });
      return;
    }
    if (adminEnabled && req.url.startsWith("/__admin/stubs")) {
      await handleAdminStubs(
        req.method ?? "GET",
        registry,
        declaredFixtures,
        req,
        res,
      );
      return;
    }
    if (req.method !== "POST" || !req.url.startsWith("/graphql")) {
      jsonResponse(res, 404, { error: "not found" });
      return;
    }
    let body: PostBody;
    try {
      body = JSON.parse(await readBody(req)) as PostBody;
    } catch (err) {
      jsonResponse(res, 400, {
        errors: [{ message: `invalid JSON: ${(err as Error).message}` }],
      });
      return;
    }
    if (typeof body.query !== "string") {
      jsonResponse(res, 400, {
        errors: [{ message: "request body must include a `query` string" }],
      });
      return;
    }
    let document: ReturnType<typeof parse>;
    try {
      document = parse(body.query);
    } catch (err) {
      jsonResponse(res, 400, {
        errors: [
          { message: `invalid GraphQL query: ${(err as Error).message}` },
        ],
      });
      return;
    }
    const errors = validate(schema, document);
    if (errors.length > 0) {
      jsonResponse(res, 400, { errors: formatErrors(errors) });
      return;
    }
    const variables = (body.variables ?? {}) as Record<string, unknown>;
    const operationName =
      typeof body.operationName === "string" ? body.operationName : undefined;

    const opDef = document.definitions.find(
      (d) => d.kind === "OperationDefinition",
    );
    const opName =
      operationName ??
      (opDef && opDef.kind === "OperationDefinition" && opDef.name?.value
        ? opDef.name.value
        : undefined);

    // Always allow introspection through to the schema executor.
    const isIntrospection =
      opDef &&
      opDef.kind === "OperationDefinition" &&
      opDef.selectionSet.selections.every(
        (s) =>
          s.kind === "Field" &&
          (s.name.value === "__schema" || s.name.value === "__type"),
      );

    if (isIntrospection) {
      const result = (await execute({
        schema,
        document,
        variableValues: variables,
        operationName,
      })) as ExecutionResult;
      jsonResponse(res, 200, result);
      return;
    }

    // Follows fragment spreads on the operation's root selection set, so a
    // document like `query Q { ...RootFields } fragment RootFields on Query
    // { eventList { ... } }` still routes to the `eventList` stub instead of
    // falling through to the operation name `Q` and producing `no stub
    // registered`.
    const fieldNames = extractRootFieldNames(document);
    let stub: StubResolver | null = null;
    for (const field of [opName, ...fieldNames]) {
      if (!field) continue;
      stub = registry.resolve(field, variables);
      if (stub) break;
    }
    if (!stub) {
      jsonResponse(res, 200, {
        errors: [
          {
            message:
              `mock-server: no stub registered for operation ` +
              `'${opName ?? fieldNames.join(",") ?? "<anonymous>"}'.`,
          },
        ],
      });
      return;
    }
    if (stub.kind === "errors") {
      jsonResponse(res, 200, { errors: stub.errors });
      return;
    }
    if (stub.kind === "connectionFailure") {
      // Hang up the socket without writing a response so undici raises
      // `ECONNRESET` / `socket hang up` on the client. This is the only
      // path that exercises `ManagerUnavailableError` end-to-end —
      // `kind: "errors"` returns a 200 (a `ClientError`, not a transport
      // failure), and a clean close after `res.end()` would still satisfy
      // the request.
      req.socket.destroy();
      return;
    }
    // Execute against the schema with the fixture as the root value so the
    // schema double-checks the response shape on every request.
    const result = (await execute({
      schema,
      document,
      rootValue: stub.data,
      variableValues: variables,
      operationName,
    })) as ExecutionResult;
    jsonResponse(res, 200, result);
  };

  const server: HttpServer = opts.tls
    ? createHttpsServer(
        {
          cert: opts.tls.cert,
          key: opts.tls.key,
          ca: [opts.tls.ca],
          requestCert: true,
          rejectUnauthorized: true,
        },
        handler,
      )
    : createHttpServer(handler);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const addr = server.address() as AddressInfo;
  const scheme = opts.tls ? "https" : "http";
  const url = `${scheme}://127.0.0.1:${addr.port}/graphql`;

  return {
    url,
    port: addr.port,
    registry,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
