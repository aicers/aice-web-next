import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Resolve DATA_DIR the same way the app does: `process.env` first, then a
 * `DATA_DIR=...` line from `e2e/../.env.local`, then the default `./data`.
 *
 * Both `e2e/playwright.config.ts` (which builds the webServer env) and
 * `e2e/global-setup.ts` (which generates the test certs and boots the mock
 * server) must resolve the directory identically, otherwise the Next dev
 * server, the admin-client in Playwright workers, and the mock server can
 * end up pointing at different `<dir>/certs` trees — which only surfaces
 * locally (CI sets `DATA_DIR` explicitly).
 */
export function resolveDataDir(): string {
  if (process.env.DATA_DIR) return resolve(process.env.DATA_DIR);

  try {
    const envFile = readFileSync(resolve(__dirname, "../.env.local"), "utf8");
    const match = envFile.match(/^DATA_DIR=(.+)$/m);
    if (match) return resolve(match[1].trim());
  } catch {
    // .env.local not present — fall through to the default
  }

  return resolve("data");
}
