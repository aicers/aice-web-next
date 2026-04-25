import "server-only";

import type { DocumentNode } from "graphql";
import { GraphQLClient } from "graphql-request";
import { fetch as undiciFetch } from "undici";

import { getAgent, signContextJwt } from "@/lib/mtls";

let client: GraphQLClient | null = null;

function getClient(): GraphQLClient {
  if (client) return client;

  const endpoint = process.env.REVIEW_GRAPHQL_ENDPOINT;
  if (!endpoint) {
    throw new Error("Missing environment variable: REVIEW_GRAPHQL_ENDPOINT");
  }

  client = new GraphQLClient(endpoint, {
    fetch: async (input, init) => {
      const agent = await getAgent();
      return undiciFetch(
        input as string | URL,
        { ...init, dispatcher: agent } as Parameters<typeof undiciFetch>[1],
      ) as unknown as Response;
    },
  });
  return client;
}

interface RequestContext {
  role: string;
  customerIds?: number[];
}

/**
 * Dispatch a GraphQL request to REview through the mTLS-authenticated
 * undici dispatcher with a freshly-signed Context JWT.
 *
 * `signal` is optional: pass an `AbortSignal` to cancel the in-flight
 * request mid-flight. `graphql-request` forwards the signal to its
 * underlying `fetch`, which in turn flows into `undiciFetch` via the
 * spread of `init`, so abort propagates all the way to the wire (the
 * mTLS dispatcher does not buffer the request body in a way that
 * bypasses undici's native cancellation). Long-running operations —
 * CSV export, large `eventList` pages, future search-language queries
 * — should accept and forward an `AbortSignal` so a user-initiated
 * Cancel terminates the request promptly instead of waiting for the
 * current page to complete. Fast operations (counters, location
 * lookups) may pass `undefined` since cancellation is not useful
 * within their typical latency window.
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
  // Defense-in-depth: the TypeScript signature already rejects strings, but a
  // runtime check guards against `as any` / `unknown` casts that smuggle one
  // through. All REview queries must be parsed DocumentNodes so the
  // schema-validation test can validate them against schemas/review.graphql.
  if (typeof document === "string") {
    throw new TypeError(
      "graphqlRequest: raw query strings are not allowed. Keep queries in " +
        "a checked-in .graphql file (validated by CI) and parse them with " +
        "`parse()` or import them through graphql-codegen.",
    );
  }

  const token = await signContextJwt(context.role, context.customerIds);
  const gqlClient = getClient();

  return gqlClient.request<TData>({
    document,
    variables,
    requestHeaders: {
      Authorization: `Bearer ${token}`,
    },
    signal,
  });
}

export function resetClient(): void {
  client = null;
}
