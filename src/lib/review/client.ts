import { GraphQLClient } from "graphql-request";

type CreateClientOptions = {
  headers?: Record<string, string>;
};

const endpoint =
  process.env.NEXT_PUBLIC_REVIEW_GRAPHQL_ENDPOINT ??
  process.env.REVIEW_GRAPHQL_ENDPOINT;

export function createReviewClient(options: CreateClientOptions = {}) {
  if (!endpoint) {
    throw new Error(
      "NEXT_PUBLIC_REVIEW_GRAPHQL_ENDPOINT must be defined to use the REview client.",
    );
  }

  return new GraphQLClient(endpoint, {
    headers: {
      "content-type": "application/json",
      ...options.headers,
    },
  });
}
