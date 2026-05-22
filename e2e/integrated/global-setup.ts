import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { chromium } from "@playwright/test";

import { ADMIN_PASSWORD, ADMIN_USERNAME, AICE_WEB_NEXT_URL } from "./helpers";

/**
 * One-shot sign-in that persists the resulting cookies to `auth.json`
 * so all engine projects in the integrated config reuse the same
 * authenticated context. The prod build under test has no test-only
 * `/api/e2e/reset-rate-limits` endpoint, so repeating the password-flow
 * across 3 engines × N specs is not viable.
 */
export const STORAGE_STATE_PATH = resolve(
  __dirname,
  ".auth/admin-storage-state.json",
);

/**
 * Path to the aice-web-next aimer-context signing key (JWK) used by
 * the cross-binding tamper scenarios to re-sign `analyze_params_token`
 * after mutating a claim. The key is pulled out of the running BFF
 * container — without it the tampered JWS would fail the JWS-level
 * signature check on aimer-web instead of the `verifyAnalyzeParamsToken`
 * cross-binding check we want to exercise.
 */
export const SIGNING_KEY_PATH = resolve(
  __dirname,
  ".auth/aimer-context-signing.json",
);

/**
 * Command that prints the JSON contents of the signing key file from
 * the running aice-web-next container. The reference setup uses an
 * OrbStack VM (`orb -m m1`) wrapping docker; CI / alternative compose
 * stacks should set `SIGNING_KEY_FETCH_COMMAND` accordingly.
 */
const SIGNING_KEY_FETCH_COMMAND =
  process.env.SIGNING_KEY_FETCH_COMMAND ??
  "orb -m m1 docker exec aice-web-next-next-app-1 cat /app/data/keys/aimer-context-signing.json";

/**
 * Reuse an existing storageState file if it is younger than the JWT
 * expiration window — the prod build's sign-in endpoint is rate-
 * limited (no test-only reset) and the integrated harness re-runs at
 * a faster cadence than that window during iteration. The ceiling
 * must stay under `JWT_EXPIRATION_MINUTES` (default 15m, hard-coded
 * in the BFF for the reference stack) or the cached cookie is stale
 * and the first mutating call lands on a 401. Default to 10m to
 * leave headroom.
 */
const STORAGE_STATE_TTL_MS = Number(
  process.env.STORAGE_STATE_TTL_MS ?? 10 * 60 * 1000,
);

function isStorageStateFresh(): boolean {
  if (!existsSync(STORAGE_STATE_PATH)) return false;
  const age = Date.now() - statSync(STORAGE_STATE_PATH).mtimeMs;
  return age < STORAGE_STATE_TTL_MS;
}

export default async function globalSetup(): Promise<void> {
  mkdirSync(dirname(STORAGE_STATE_PATH), { recursive: true });

  if (!isStorageStateFresh()) {
    // Sign in through a real chromium browser so the session's
    // stored browser-fingerprint (UA-derived) matches what the spec
    // contexts present. A Playwright `request` context uses Node's
    // default UA; when the spec attaches storageState to a chromium
    // browser the UA mismatch trips `assessIpUaRisk()` in
    // src/lib/auth/guard.ts and flips `session.needs_reauth = true`,
    // which makes the first mutating API call (e.g.
    // /api/aimer/analyze-envelope) return 401 REAUTH_REQUIRED.
    // Using chromium here keeps the fingerprint stable for the
    // chromium engine project; firefox/webkit are currently still
    // served by this same state file — per-engine sign-in is a
    // follow-up for the #635 PR if the matrix needs to cover
    // authenticated flows on all three engines.
    const browser = await chromium.launch();
    const ctx = await browser.newContext({
      baseURL: AICE_WEB_NEXT_URL,
      ignoreHTTPSErrors: true,
    });
    const page = await ctx.newPage();
    await page.goto("/sign-in");
    await page.getByLabel("Account ID").fill(ADMIN_USERNAME);
    await page.locator("input[name='password']").fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: "Sign In" }).click();
    await page.waitForURL((url) => !url.pathname.endsWith("/sign-in"), {
      timeout: 30_000,
    });
    await ctx.storageState({ path: STORAGE_STATE_PATH });
    await browser.close();
  }

  // Pull the active signing key out of the BFF container so the
  // tamper specs can re-sign `analyze_params_token` after mutating
  // a cross-binding claim. Best-effort: a missing fetch command (or
  // an offline stack) leaves the file absent and the tamper specs
  // skip with a clear "signing key not provisioned" message.
  try {
    const parts = SIGNING_KEY_FETCH_COMMAND.split(/\s+/);
    const cmd = parts.shift();
    if (!cmd) throw new Error("empty SIGNING_KEY_FETCH_COMMAND");
    const keyJson = execFileSync(cmd, parts, { encoding: "utf8" });
    writeFileSync(SIGNING_KEY_PATH, keyJson);
  } catch (err) {
    console.warn(
      `global-setup: signing key fetch failed (${(err as Error).message}). Tamper specs will skip.`,
    );
  }
}
