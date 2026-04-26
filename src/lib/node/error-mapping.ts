import "server-only";

import {
  type ExternalServiceKindHint,
  ExternalServiceUnavailableError,
  ManagerUnavailableError,
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
