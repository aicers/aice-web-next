import "server-only";

import { cookies } from "next/headers";

export const ACCESS_TOKEN_COOKIE = "at";

const COOKIE_OPTIONS = {
  httpOnly: true,
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
