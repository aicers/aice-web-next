/**
 * Per-file setup: exposes the integration server origin for all tests.
 *
 * IMPORTANT: Do NOT use `BASE_URL` as a name — Vitest injects
 * `process.env.BASE_URL = viteConfig.base` (default "/") into test
 * modules, which silently overrides the real environment variable.
 */
export const SERVER_ORIGIN =
  process.env.INTEGRATION_SERVER_URL || "http://localhost:3001";

/**
 * URL of the mock REview GraphQL server started by `global-setup.ts`. Used
 * by harness smoke tests (and any feature integration test that wants to
 * exercise the mock layer directly without going through Next.js). The
 * server is HTTPS + mTLS — see `global-setup.ts` and the MTLS_CA_PATH /
 * MTLS_CERT_PATH / MTLS_KEY_PATH env vars it sets.
 */
export const MOCK_REVIEW_GRAPHQL_URL =
  process.env.REVIEW_GRAPHQL_ENDPOINT ||
  `https://127.0.0.1:${process.env.MOCK_REVIEW_GRAPHQL_PORT || "4011"}/graphql`;
