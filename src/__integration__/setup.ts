/**
 * Per-file setup: exposes the integration server origin for all tests.
 *
 * IMPORTANT: Do NOT use `BASE_URL` as a name — Vitest injects
 * `process.env.BASE_URL = viteConfig.base` (default "/") into test
 * modules, which silently overrides the real environment variable.
 */
export const SERVER_ORIGIN =
  process.env.INTEGRATION_SERVER_URL || "http://localhost:3001";
