import "server-only";

import { GraphQLClient, type RequestDocument } from "graphql-request";
import type { Dispatcher } from "undici";

import { getAgent, signContextJwt } from "@/lib/mtls";

function createFetchWithMtls(dispatcher: Dispatcher): typeof globalThis.fetch {
  return (input, init) =>
    globalThis.fetch(input, { ...init, dispatcher } as RequestInit);
}

let client: GraphQLClient | null = null;

function getClient(): GraphQLClient {
  if (client) return client;

  const endpoint = process.env.REVIEW_GRAPHQL_ENDPOINT;
  if (!endpoint) {
    throw new Error("Missing environment variable: REVIEW_GRAPHQL_ENDPOINT");
  }

  client = new GraphQLClient(endpoint);
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
  const [token, agent] = await Promise.all([
    signContextJwt(context.role, context.customerIds),
    getAgent(),
  ]);

  const gqlClient = getClient();

  return gqlClient.request<TData>({
    document,
    variables,
    requestHeaders: {
      Authorization: `Bearer ${token}`,
    },
    fetch: createFetchWithMtls(agent),
  } as Parameters<typeof gqlClient.request>[0]);
}

export function resetClient(): void {
  client = null;
}
