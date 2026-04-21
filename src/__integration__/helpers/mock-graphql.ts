/**
 * Integration-tier mock-GraphQL layer — shared helpers that feature
 * integration tests consume. Three concerns live here:
 *
 *  1. **Scenario stub registration.** `mockGraphqlSession()` returns a
 *     per-spec scope so one file's `afterAll` cannot wipe another's stubs
 *     when integration tests run in sequence against the same mock server.
 *     Parallels `e2e/mock-server-admin.ts` but keyed off the harness env
 *     (`MOCK_REVIEW_GRAPHQL_URL` + `MTLS_*_PATH`) set by the integration
 *     `globalSetup`. Feature issues add their own fixtures via
 *     `session.registerStub(...)` in `beforeAll` and call `session.clear()`
 *     in `afterAll`.
 *
 *  2. **Direct `graphqlRequest()` calls.** `callGraphQL()` wraps the
 *     production GraphQL client with defaults suited to integration tests
 *     and resets the cached client before each call so changes to
 *     `REVIEW_GRAPHQL_ENDPOINT` (e.g. pointing a sub-test at a different
 *     mock) take effect. Feature issues that want to exercise a query
 *     document end-to-end through the production client — without paying
 *     the cost of a Next.js HTTP round trip — call this helper.
 *
 *  3. **Fixture loading.** Re-exports `loadFixtureJson` so feature
 *     integration tests can assert against the same canned payload the
 *     mock server is serving without reaching into `@/test-harness/`.
 *
 * The `graphqlRequest` client is reset before each `callGraphQL()` call
 * so changes to `REVIEW_GRAPHQL_ENDPOINT` (and therefore the mock URL)
 * take effect between tests. The underlying `mtls.ts` state is built once
 * per process from the harness-set `MTLS_*_PATH` env vars.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import type { DocumentNode } from "graphql";
import { Agent, fetch as undiciFetch } from "undici";

import { graphqlRequest, resetClient } from "@/lib/graphql/client";
import { loadFixtureJson } from "@/test-harness/fixtures";
import type { AdminStubRequest } from "@/test-harness/mock-server";

import { MOCK_REVIEW_GRAPHQL_URL } from "../setup";

export { loadFixtureJson };

let cachedAgent: Agent | null = null;

function adminBase(): string {
  return `${MOCK_REVIEW_GRAPHQL_URL.replace(/\/graphql$/, "")}/__admin/stubs`;
}

function adminAgent(): Agent {
  if (cachedAgent) return cachedAgent;
  const caPath = process.env.MTLS_CA_PATH;
  const certPath = process.env.MTLS_CERT_PATH;
  const keyPath = process.env.MTLS_KEY_PATH;
  if (!caPath || !certPath || !keyPath) {
    throw new Error(
      "Integration mock-graphql helper requires MTLS_CA_PATH / " +
        "MTLS_CERT_PATH / MTLS_KEY_PATH (set by the integration global " +
        "setup). Did you run through `pnpm test:integration`?",
    );
  }
  cachedAgent = new Agent({
    connect: {
      ca: readFileSync(caPath, "utf8"),
      cert: readFileSync(certPath, "utf8"),
      key: readFileSync(keyPath, "utf8"),
    },
  });
  return cachedAgent;
}

export async function registerStub(req: AdminStubRequest): Promise<void> {
  const res = await undiciFetch(adminBase(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
    dispatcher: adminAgent(),
  });
  if (res.status !== 201) {
    const text = await res.text();
    throw new Error(
      `registerStub failed: HTTP ${res.status} ${res.statusText} — ${text}`,
    );
  }
}

/**
 * Clear stubs from the mock server's registry.
 *
 *  - With no argument: wipes everything (manifest preloads included). Only
 *    safe to call from a global teardown after every test file has run —
 *    feature tests should pass a scope.
 *  - With `{ scope }`: clears only the stubs tagged with that scope, leaving
 *    other files' registrations untouched.
 */
export async function clearStubs(opts?: { scope?: string }): Promise<void> {
  const url = opts?.scope
    ? `${adminBase()}?scope=${encodeURIComponent(opts.scope)}`
    : adminBase();
  const res = await undiciFetch(url, {
    method: "DELETE",
    dispatcher: adminAgent(),
  });
  if (res.status !== 200) {
    const text = await res.text();
    throw new Error(
      `clearStubs failed: HTTP ${res.status} ${res.statusText} — ${text}`,
    );
  }
}

export interface MockGraphqlSession {
  /** Unique scope token tagging every stub registered through the session. */
  scope: string;
  /** Register a stub scoped to this session. `scope` is filled in for you. */
  registerStub: (req: Omit<AdminStubRequest, "scope">) => Promise<void>;
  /** Clear only this session's stubs — safe to call from `afterAll`. */
  clear: () => Promise<void>;
}

export function mockGraphqlSession(
  scope: string = randomUUID(),
): MockGraphqlSession {
  return {
    scope,
    registerStub: (req) => registerStub({ ...req, scope }),
    clear: () => clearStubs({ scope }),
  };
}

export async function closeAdminAgent(): Promise<void> {
  if (cachedAgent) {
    await cachedAgent.close();
    cachedAgent = null;
  }
}

interface CallGraphqlOptions {
  /** Role claim for the Context JWT. Defaults to `SYSTEM_ADMINISTRATOR`. */
  role?: string;
  /** Customer-id claims. Defaults to an empty list. */
  customerIds?: number[];
}

/**
 * Invoke `graphqlRequest()` directly against the mock server. Production
 * code paths use this helper transparently when the dev server handles a
 * request; calling it from an integration test bypasses the HTTP round
 * trip so tests can exercise query documents against canned fixtures
 * without asserting on any particular API route.
 *
 * The module-level client cache is reset before each call so that any
 * change to `REVIEW_GRAPHQL_ENDPOINT` between tests (e.g. pointing at a
 * per-file mock) takes effect immediately.
 */
export async function callGraphQL<
  TData,
  TVars extends Record<string, unknown> = Record<string, never>,
>(
  document: DocumentNode,
  variables?: TVars,
  opts: CallGraphqlOptions = {},
): Promise<TData> {
  resetClient();
  return graphqlRequest<TData, TVars>(document, variables, {
    role: opts.role ?? "SYSTEM_ADMINISTRATOR",
    customerIds: opts.customerIds ?? [],
  });
}
