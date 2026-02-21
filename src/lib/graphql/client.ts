import "server-only";

import { GraphQLClient, type RequestDocument } from "graphql-request";

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
      return globalThis.fetch(input, {
        ...init,
        dispatcher: agent,
      } as RequestInit);
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
  document: RequestDocument,
  variables: TVars | undefined,
  context: RequestContext,
): Promise<TData> {
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
