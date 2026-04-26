import "server-only";

import type { DocumentNode } from "graphql";
import { GraphQLClient } from "graphql-request";
import { fetch as undiciFetch } from "undici";

import { getAgent, signContextJwt } from "@/lib/mtls";

const clientsByEndpoint = new Map<string, GraphQLClient>();

function buildClient(endpoint: string): GraphQLClient {
  return new GraphQLClient(endpoint, {
    fetch: async (input, init) => {
      const agent = await getAgent();
      return undiciFetch(
        input as string | URL,
        { ...init, dispatcher: agent } as Parameters<typeof undiciFetch>[1],
      ) as unknown as Response;
    },
  });
}

function getClient(endpoint: string): GraphQLClient {
  const cached = clientsByEndpoint.get(endpoint);
  if (cached) return cached;
  const client = buildClient(endpoint);
  clientsByEndpoint.set(endpoint, client);
  return client;
}

function getReviewEndpoint(): string {
  const endpoint = process.env.REVIEW_GRAPHQL_ENDPOINT;
  if (!endpoint) {
    throw new Error("Missing environment variable: REVIEW_GRAPHQL_ENDPOINT");
  }
  return endpoint;
}

interface RequestContext {
  role: string;
  customerIds?: number[];
}

/**
 * Dispatch a GraphQL request to an arbitrary endpoint through the
 * mTLS-authenticated undici dispatcher with a freshly-signed Context
 * JWT. The endpoint-specific clients are cached per endpoint so we
 * don't rebuild a `GraphQLClient` on every call, but they share the
 * same mTLS state from `@/lib/mtls`.
 *
 * This is the building block for both `graphqlRequest` (default
 * REview manager call site) and the per-service callers in
 * `src/lib/graphql/external-client.ts` (Giganto / Tivan). The
 * endpoint is passed at the boundary so that:
 *
 *  - Detection's existing call sites continue to work unchanged via
 *    the wrapper below, and
 *  - the Node management layer can dispatch directly to Giganto and
 *    Tivan without relaying through review-web — the mTLS + Context
 *    JWT contract is the same for every backend, only the URL
 *    differs.
 *
 * `signal` is optional: pass an `AbortSignal` to cancel the in-flight
 * request mid-flight. `graphql-request` forwards the signal to its
 * underlying `fetch`, which in turn flows into `undiciFetch` via the
 * spread of `init`, so abort propagates all the way to the wire.
 */
export async function graphqlRequestTo<
  TData,
  TVars extends Record<string, unknown> = Record<string, never>,
>(
  endpoint: string,
  document: DocumentNode,
  variables: TVars | undefined,
  context: RequestContext,
  signal?: AbortSignal,
): Promise<TData> {
  // Defense-in-depth: the TypeScript signature already rejects strings, but a
  // runtime check guards against `as any` / `unknown` casts that smuggle one
  // through. All queries must be parsed DocumentNodes so the
  // schema-validation test can validate them against the right vendored SDL.
  if (typeof document === "string") {
    throw new TypeError(
      "graphqlRequestTo: raw query strings are not allowed. Keep queries in " +
        "a checked-in .graphql file (validated by CI) and parse them with " +
        "`parse()` or import them through graphql-codegen.",
    );
  }

  const token = await signContextJwt(context.role, context.customerIds);
  const gqlClient = getClient(endpoint);

  return gqlClient.request<TData>({
    document,
    variables,
    requestHeaders: {
      Authorization: `Bearer ${token}`,
    },
    signal,
  });
}

/**
 * Dispatch a GraphQL request to the default REview (manager) endpoint
 * resolved from `REVIEW_GRAPHQL_ENDPOINT`. This is the call site for
 * Detection, Triage, and the manager half of Node management. External
 * services (Giganto, Tivan) use `graphqlRequestTo` via the
 * `external-client.ts` callers — they are not relayed through this
 * wrapper.
 *
 * Long-running operations — CSV export, large `eventList` pages,
 * future search-language queries — should accept and forward an
 * `AbortSignal` so a user-initiated Cancel terminates the request
 * promptly instead of waiting for the current page to complete.
 */
export async function graphqlRequest<
  TData,
  TVars extends Record<string, unknown> = Record<string, never>,
>(
  document: DocumentNode,
  variables: TVars | undefined,
  context: RequestContext,
  signal?: AbortSignal,
): Promise<TData> {
  return graphqlRequestTo<TData, TVars>(
    getReviewEndpoint(),
    document,
    variables,
    context,
    signal,
  );
}

export function resetClient(): void {
  clientsByEndpoint.clear();
}
