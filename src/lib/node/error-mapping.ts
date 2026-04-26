import "server-only";

import {
  type ExternalServiceKindHint,
  ExternalServiceUnavailableError,
  ManagerUnavailableError,
  NodeNotFoundError,
} from "./errors";

/**
 * Connection-level failures (refused, DNS, mTLS) and aborts surface
 * as `TypeError` / `AbortError` from undici. These are remapped to
 * {@link ManagerUnavailableError} or {@link ExternalServiceUnavailableError}
 * so the UI can render the offline banner. GraphQL-validation or
 * business-logic errors (returned in the `errors[]` payload of a 200
 * response) propagate unchanged because they describe a malformed
 * query, not an unreachable backend.
 *
 * Lives in its own module so both `server-actions.ts` and
 * `service-dispatch.ts` can apply the mapping without importing each
 * other (`service-dispatch` would otherwise pull in the whole server-
 * action layer transitively).
 */
export function isConnectionError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if (error instanceof TypeError) return true;
  const code = (error as { code?: string }).code;
  if (
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN" ||
    code === "ETIMEDOUT" ||
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    code === "UND_ERR_SOCKET" ||
    code === "UND_ERR_HEADERS_TIMEOUT"
  ) {
    return true;
  }
  const cause = (error as { cause?: unknown }).cause;
  if (cause && cause !== error) return isConnectionError(cause);
  return false;
}

export async function withManagerErrorMapping<T>(
  promise: Promise<T>,
): Promise<T> {
  try {
    return await promise;
  } catch (err) {
    if (isConnectionError(err)) {
      throw new ManagerUnavailableError(
        "Could not reach the manager (review-web) endpoint.",
        { cause: err },
      );
    }
    throw err;
  }
}

export async function withExternalErrorMapping<T>(
  serviceKind: ExternalServiceKindHint,
  promise: Promise<T>,
): Promise<T> {
  try {
    return await promise;
  } catch (err) {
    if (isConnectionError(err)) {
      throw new ExternalServiceUnavailableError(
        serviceKind,
        `Could not reach the ${
          serviceKind === "DATA_STORE" ? "Giganto" : "Tivan"
        } endpoint.`,
        { cause: err },
      );
    }
    throw err;
  }
}

/**
 * The vendored review-web schema declares `node(id: ID!): Node!` as
 * non-nullable, so a missing id surfaces as a rejected
 * `graphql-request` promise (a `ClientError` carrying GraphQL errors)
 * — never as `{ node: null }`. Without this mapping, a 404 leaks as a
 * raw GraphQL client error to callers that explicitly distinguish
 * `NodeNotFoundError` from `ManagerUnavailableError` / generic errors
 * (Phase Node-9's stale-conflict replay calls `getNode` on every retry
 * and depends on the typed 404).
 *
 * Detection: a thrown error from graphql-request whose `response.errors`
 * contains an entry whose `extensions.code` is `NOT_FOUND`, or whose
 * message text matches a not-found marker (`not found` /
 * `does not exist` / `no such`). We use a heuristic in addition to
 * `extensions.code` because review-web's resolver does not always
 * emit a structured code on missing-node errors.
 */
export async function withNodeNotFoundMapping<T>(
  promise: Promise<T>,
  id: string,
): Promise<T> {
  try {
    return await promise;
  } catch (err) {
    if (isMissingNodeError(err)) {
      throw new NodeNotFoundError(`Node ${id} was not found.`);
    }
    throw err;
  }
}

interface GraphQLLikeError {
  message?: string;
  extensions?: { code?: string };
}

function isMissingNodeError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  // Connection errors are the manager-offline path, not a 404.
  if (isConnectionError(error)) return false;
  const response = (error as { response?: { errors?: unknown } }).response;
  const errors = Array.isArray(response?.errors)
    ? (response.errors as GraphQLLikeError[])
    : null;
  if (!errors || errors.length === 0) return false;
  return errors.some((e) => {
    if (e?.extensions?.code === "NOT_FOUND") return true;
    const message = typeof e?.message === "string" ? e.message : "";
    return /not\s*found|does not exist|no such/i.test(message);
  });
}
