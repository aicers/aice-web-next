import { BASE_URL } from "../setup";

export const ADMIN_USERNAME = "admin";
export const ADMIN_PASSWORD = "Admin1234!";

/**
 * Authenticated HTTP session for integration tests.
 * Manages JWT cookie and CSRF token obtained from sign-in.
 */
export interface AuthSession {
  /** Cookie header value to send with requests. */
  cookie: string;
  /** CSRF token to send as X-CSRF-Token header on mutating requests. */
  csrfToken: string;
}

/**
 * Sign in via the API and capture the JWT cookie + CSRF token.
 */
export async function signIn(
  username: string,
  password: string,
): Promise<AuthSession> {
  const res = await fetch(`${BASE_URL}/api/auth/sign-in`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: BASE_URL,
    },
    body: JSON.stringify({ username, password }),
    redirect: "manual",
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Sign-in failed (${res.status}): ${body}`);
  }

  // Extract cookies from Set-Cookie headers
  const setCookies = res.headers.getSetCookie();
  const cookiePairs: string[] = [];
  let csrfToken = "";

  for (const sc of setCookies) {
    const nameValue = sc.split(";")[0];
    cookiePairs.push(nameValue);

    if (nameValue.startsWith("csrf=")) {
      csrfToken = nameValue.split("=").slice(1).join("=");
    }
  }

  return {
    cookie: cookiePairs.join("; "),
    csrfToken,
  };
}

/**
 * Make an authenticated GET request.
 */
export async function authGet(
  session: AuthSession,
  path: string,
): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, {
    headers: {
      Cookie: session.cookie,
    },
  });
}

/**
 * Make an authenticated POST request with JSON body.
 */
export async function authPost(
  session: AuthSession,
  path: string,
  data?: unknown,
): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: session.cookie,
      "X-CSRF-Token": session.csrfToken,
      Origin: BASE_URL,
    },
    body: data !== undefined ? JSON.stringify(data) : undefined,
  });
}

/**
 * Make an authenticated PATCH request with JSON body.
 */
export async function authPatch(
  session: AuthSession,
  path: string,
  data: unknown,
): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Cookie: session.cookie,
      "X-CSRF-Token": session.csrfToken,
      Origin: BASE_URL,
    },
    body: JSON.stringify(data),
  });
}

/**
 * Make an authenticated DELETE request.
 */
export async function authDelete(
  session: AuthSession,
  path: string,
): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, {
    method: "DELETE",
    headers: {
      Cookie: session.cookie,
      "X-CSRF-Token": session.csrfToken,
      Origin: BASE_URL,
    },
  });
}

/**
 * Reset the in-memory rate limiter via the test-only API endpoint.
 */
export async function resetRateLimits(): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/e2e/reset-rate-limits`, {
    method: "POST",
  });
  if (!res.ok) throw new Error(`reset-rate-limits failed: ${res.status}`);
}
