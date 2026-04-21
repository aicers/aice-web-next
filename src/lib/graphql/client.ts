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

export async function graphqlRequest<
  TData,
  TVars extends Record<string, unknown> = Record<string, never>,
>(
  document: DocumentNode,
  variables: TVars | undefined,
  context: RequestContext,
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
  });
}

export function resetClient(): void {
  client = null;
}
