/**
 * Shared auth constants — safe to import from both server and client code.
 * Do NOT add "server-only" here.
 */

/** Default JWT expiration in minutes. */
export const TOKEN_EXPIRATION_MINUTES = 15;

/** Default JWT expiration in seconds. */
export const TOKEN_EXPIRATION_SECONDS = TOKEN_EXPIRATION_MINUTES * 60;
