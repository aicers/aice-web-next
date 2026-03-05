import "server-only";

import { cookies } from "next/headers";

export const ACCESS_TOKEN_COOKIE = "at";

/**
 * Non-httpOnly cookie that exposes the JWT expiration timestamp
 * (seconds since epoch) to client-side JavaScript.  The client
 * uses this to display a session-extension dialog before expiry.
 */
export const TOKEN_EXP_COOKIE = "token_exp";

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "strict" as const,
  path: "/",
};

const TOKEN_EXP_COOKIE_OPTIONS = {
  httpOnly: false,
  secure: process.env.NODE_ENV === "production",
  sameSite: "strict" as const,
  path: "/",
};

/** Set the access token cookie with the given max age (in seconds). */
export async function setAccessTokenCookie(
  token: string,
  maxAgeSeconds: number,
): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(ACCESS_TOKEN_COOKIE, token, {
    ...COOKIE_OPTIONS,
    maxAge: maxAgeSeconds,
  });
}

/** Read the access token from the cookie. Returns undefined if absent. */
export async function getAccessTokenCookie(): Promise<string | undefined> {
  const cookieStore = await cookies();
  return cookieStore.get(ACCESS_TOKEN_COOKIE)?.value;
}

/** Delete the access token cookie. */
export async function deleteAccessTokenCookie(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(ACCESS_TOKEN_COOKIE);
}

/** Set the token_exp cookie so the client can read the JWT expiry. */
export async function setTokenExpCookie(
  expSeconds: number,
  maxAgeSeconds: number,
): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(TOKEN_EXP_COOKIE, String(expSeconds), {
    ...TOKEN_EXP_COOKIE_OPTIONS,
    maxAge: maxAgeSeconds,
  });
}

/** Delete the token_exp cookie. */
export async function deleteTokenExpCookie(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(TOKEN_EXP_COOKIE);
}
