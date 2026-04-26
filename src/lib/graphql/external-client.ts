import "server-only";

import type { DocumentNode } from "graphql";

import {
  getGigantoEndpoint,
  getTivanEndpoint,
} from "@/lib/node/external-endpoints";

import { graphqlRequestTo } from "./client";

/**
 * Sibling of `@/lib/graphql/client.ts` that targets the external
 * services (Giganto, Tivan) rather than the manager (review-web). The
 * Next.js server opens its own mTLS connection straight to the
 * external endpoint — these calls are NOT relayed through review-web,
 * and the dispatch URL is taken from environment configuration via
 * `external-endpoints.ts`, never derived from a node's stored
 * `graphql_srv_addr` or any other field carried in a Node payload.
 *
 * The two callers exposed here resolve their endpoint at call time
 * rather than module-load time so a missing env var surfaces as a
 * runtime error at the dispatch site (where the Node server action
 * can map it to `ExternalServiceUnavailableError`) rather than
 * crashing the Next.js server at boot.
 */

interface RequestContext {
  role: string;
  customerIds?: number[];
}

/**
 * Dispatch a GraphQL request to the configured Giganto endpoint.
 * Applies the same mTLS + Context JWT plumbing as `graphqlRequest`
 * (manager) — only the URL differs.
 */
export async function gigantoClient<
  TData,
  TVars extends Record<string, unknown> = Record<string, never>,
>(
  document: DocumentNode,
  variables: TVars | undefined,
  context: RequestContext,
  signal?: AbortSignal,
): Promise<TData> {
  return graphqlRequestTo<TData, TVars>(
    getGigantoEndpoint(),
    document,
    variables,
    context,
    signal,
  );
}

/**
 * Dispatch a GraphQL request to the configured Tivan endpoint. Same
 * mTLS + Context JWT contract as the manager and Giganto callers.
 */
export async function tivanClient<
  TData,
  TVars extends Record<string, unknown> = Record<string, never>,
>(
  document: DocumentNode,
  variables: TVars | undefined,
  context: RequestContext,
  signal?: AbortSignal,
): Promise<TData> {
  return graphqlRequestTo<TData, TVars>(
    getTivanEndpoint(),
    document,
    variables,
    context,
    signal,
  );
}
