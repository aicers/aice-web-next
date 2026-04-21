import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Agent, fetch as undiciFetch } from "undici";

import type { AdminStubRequest } from "../src/test-harness/mock-server";

import { mockServerUrl } from "./mock-server-state";

/**
 * HTTP client for the mock-server's `/__admin/stubs` endpoint. Specs run in
 * worker processes that do not share memory with `global-setup.ts`, so the
 * only way to register a scenario-specific stub is over HTTP.
 *
 * Two APIs are exposed:
 *
 *  - `mockServerSession()` returns a per-spec scope: every stub the session
 *    registers carries a unique scope token, and `session.clear()` only
 *    removes those stubs. This is the recommended API for feature specs —
 *    multiple Playwright workers share one mock server, and a global
 *    `clearStubs()` from one spec's `afterAll` would otherwise wipe other
 *    specs' stubs mid-run.
 *
 *  - `registerStub` / `clearStubs` are the unscoped primitives. `clearStubs`
 *    with no argument wipes the entire registry — only safe to call from a
 *    Playwright `globalTeardown` after every worker has finished.
 *
 * `response` must reference a manifest-declared fixture path (and the
 * request's `operation` must match the operation the manifest pairs that
 * fixture with) or use `{ kind: "errors", ... }`. Inline fixture JSON is
 * rejected — it would bypass the pre-test preflight.
 *
 * Recommended pattern:
 *
 * ```ts
 * import { mockServerSession } from "./mock-server-admin";
 *
 * const session = mockServerSession();
 *
 * test.beforeAll(async () => {
 *   await session.registerStub({
 *     operation: "eventList",
 *     matchVariables: { first: 100 },
 *     response: { kind: "fixture", fixture: "detection/eventList.busy.json" },
 *   });
 * });
 *
 * test.afterAll(async () => {
 *   await session.clear();
 * });
 * ```
 */

let cachedAgent: Agent | null = null;

function adminBase(): string {
  return `${mockServerUrl().replace(/\/graphql$/, "")}/__admin/stubs`;
}

function adminAgent(): Agent | undefined {
  // The mock server presents a self-signed cert signed by the test CA.
  // Playwright workers do not inherit Node's CA bundle, so we load the CA
  // + client cert/key from the paths the mtls module was pointed at.
  if (cachedAgent) return cachedAgent;
  const caPath = process.env.MTLS_CA_PATH;
  const certPath = process.env.MTLS_CERT_PATH;
  const keyPath = process.env.MTLS_KEY_PATH;
  if (!caPath || !certPath || !keyPath) return undefined;
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
 * - With no argument: clears everything (fixture preloads included). Only
 *   safe from `globalTeardown` after every Playwright worker has finished.
 * - With `{ scope }`: clears only stubs registered with that scope. Specs
 *   should call this from `test.afterAll` to clean up their own stubs
 *   without touching other specs' state.
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

export interface MockServerSession {
  /** Unique scope token tagging every stub this session registers. */
  scope: string;
  /** Register a stub scoped to this session. `scope` is filled in for you. */
  registerStub: (req: Omit<AdminStubRequest, "scope">) => Promise<void>;
  /** Clear only this session's stubs (safe to call from `test.afterAll`). */
  clear: () => Promise<void>;
}

export function mockServerSession(
  scope: string = randomUUID(),
): MockServerSession {
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
