import "server-only";

import { ExternalServiceUnavailableError } from "./errors";

/**
 * Per-deployment endpoint URLs for the external services aice-web-next
 * dispatches to directly (Giganto and Tivan). Every external-service
 * GraphQL call originates from the Next.js server and opens its own
 * mTLS connection straight to the service — calls are NOT relayed
 * through review-web. The aice-web `/archive` and `/ti-container`
 * reverse-proxy paths from the previous web client are deliberately
 * not carried over.
 *
 * v1 of the Node management layer assumes a single Giganto and single
 * Tivan per deployment, so each service has exactly one endpoint URL
 * configured at startup. Multi-instance external deployments are out
 * of scope per the umbrella (#306). When that constraint relaxes, this
 * module is the single seam to extend with per-node discovery — but
 * only after the umbrella explicitly approves it. Until then, the
 * dispatch URL is environment configuration, never derived from a
 * node's stored `graphql_srv_addr`.
 *
 * A deployment with the env var unset is one that has not provisioned
 * the corresponding external service at all. Treating that as
 * `ExternalServiceUnavailableError` lets the same graceful-degradation
 * paths that handle a transient network outage also cover the
 * not-deployed case — the Edit dialog falls through to defaults
 * instead of crashing the settings page.
 */

const GIGANTO_ENV = "GIGANTO_GRAPHQL_ENDPOINT";
const TIVAN_ENV = "TIVAN_GRAPHQL_ENDPOINT";

export function getGigantoEndpoint(): string {
  const url = process.env[GIGANTO_ENV];
  if (!url) {
    throw new ExternalServiceUnavailableError(
      "DATA_STORE",
      `Missing environment variable: ${GIGANTO_ENV}`,
    );
  }
  return url;
}

export function getTivanEndpoint(): string {
  const url = process.env[TIVAN_ENV];
  if (!url) {
    throw new ExternalServiceUnavailableError(
      "TI_CONTAINER",
      `Missing environment variable: ${TIVAN_ENV}`,
    );
  }
  return url;
}
