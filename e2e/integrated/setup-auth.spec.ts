import { test } from "@playwright/test";

import { storageStatePath } from "./global-setup";
import { signInAdmin } from "./helpers";

/**
 * Per-engine sign-in. The integrated config wires one of these per
 * Playwright project (`setup-chromium`, `setup-firefox`,
 * `setup-webkit`) and each engine's main project depends on its
 * matching setup. Signing in inside the actual engine browser keeps
 * the BFF session's stored `sessionBrowserFingerprint` aligned with
 * the engine that will later attach the resulting cookie — without
 * that, `assessIpUaRisk` in `src/lib/auth/guard.ts` flips
 * `needs_reauth=true` and the first mutating API call returns a 401
 * REAUTH_REQUIRED.
 */
test("sign-in admin", async ({ page, context, browserName }) => {
  await signInAdmin(page);
  await context.storageState({ path: storageStatePath(browserName) });
});
